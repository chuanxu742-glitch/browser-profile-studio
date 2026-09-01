import { describe, expect, it, vi } from 'vitest';
import { DistributedMasterScheduler } from '../../src/distributed/scheduler.js';
import { MemoryQueueAdapter } from '../../src/distributed/queue-adapter.js';
import { WorkerDaemon } from '../../src/distributed/worker-daemon.js';
import type { DistributedTaskRecord } from '../../src/distributed/types.js';
import type { FetchOptions, FetchResult } from '../../src/fetcher/types.js';
import { UrlPolicy } from '../../src/policy/url-policy.js';

class FailFirstEnqueueAdapter extends MemoryQueueAdapter {
  public failuresRemaining = 1;

  public override async enqueueTask(task: DistributedTaskRecord): Promise<void> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining--;
      throw new Error('injected enqueue failure');
    }
    await super.enqueueTask(task);
  }
}

class FailFirstUpdateAdapter extends MemoryQueueAdapter {
  public failuresRemaining = 1;

  public override async updateTask(task: DistributedTaskRecord): Promise<void> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining--;
      throw new Error('injected update failure');
    }
    await super.updateTask(task);
  }
}

class BlockingUpdateAdapter extends MemoryQueueAdapter {
  public readonly updateStarted: Promise<void>;
  private resolveUpdateStarted!: () => void;
  private resolveUpdate!: () => void;
  private readonly updateGate: Promise<void>;

  public constructor() {
    super();
    this.updateStarted = new Promise((resolve) => { this.resolveUpdateStarted = resolve; });
    this.updateGate = new Promise((resolve) => { this.resolveUpdate = resolve; });
  }

  public override async updateTask(task: DistributedTaskRecord): Promise<void> {
    this.resolveUpdateStarted();
    await this.updateGate;
    await super.updateTask(task);
  }

  public releaseUpdate(): void {
    this.resolveUpdate();
  }
}

class AlwaysFailUpdateAdapter extends MemoryQueueAdapter {
  public readonly updateStarted: Promise<void>;
  private resolveUpdateStarted!: () => void;

  public constructor() {
    super();
    this.updateStarted = new Promise((resolve) => { this.resolveUpdateStarted = resolve; });
  }

  public override async updateTask(_task: DistributedTaskRecord): Promise<void> {
    this.resolveUpdateStarted();
    throw new Error('injected persistent update failure');
  }
}

class FairnessProbeAdapter extends MemoryQueueAdapter {
  public override readonly shardCount = 2;
  public readonly dequeueCalls: Array<{ tenantId: string; shard: number }> = [];

  public override async dequeueTask(workerId: string, tenantId = 'default', shard = 0): Promise<null> {
    this.dequeueCalls.push({ tenantId, shard });
    // This probe deliberately leaves every partition empty; the call order is
    // enough to verify that WorkerDaemon rotates its scan cursor.
    void workerId;
    return null;
  }
}

function taskRecord(overrides: Partial<DistributedTaskRecord> = {}): DistributedTaskRecord {
  return {
    id: 'task-injected',
    tenantId: 'default',
    url: 'https://example.com/injected',
    mode: 'fetch',
    priority: 'NORMAL',
    state: 'PENDING',
    retries: 0,
    maxRetries: 2,
    timeoutMs: 5_000,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('分布式队列与主调度器 (Master Scheduler & Queue)', () => {
  it('应当原子声明 URL，避免并发提交重复任务', async () => {
    const adapter = new MemoryQueueAdapter();
    const results = await Promise.all([
      adapter.claimUrl('https://example.com/concurrent'),
      adapter.claimUrl('https://example.com/concurrent'),
    ]);

    expect(results.sort()).toEqual([false, true]);
    await adapter.close();
  });

  it('批量 URL 声明失败时不应留下半批次占坑', async () => {
    const adapter = new MemoryQueueAdapter();

    await expect(adapter.claimUrls([
      'https://example.com/already-claimed',
      'https://example.com/new-url',
    ])).resolves.toBe(true);

    await expect(adapter.claimUrls([
      'https://example.com/new-url',
      'https://example.com/another-url',
    ])).resolves.toBe(false);
    await expect(adapter.claimUrl('https://example.com/another-url')).resolves.toBe(true);

    await adapter.close();
  });

  it('释放 URL 声明必须保持租户隔离', async () => {
    const adapter = new MemoryQueueAdapter();
    const url = 'https://example.com/tenant-scoped-release';
    await expect(adapter.claimUrl(url, undefined, 'tenant-a')).resolves.toBe(true);
    await expect(adapter.claimUrl(url, undefined, 'tenant-b')).resolves.toBe(true);

    await adapter.releaseUrls([url], 'tenant-a');

    await expect(adapter.claimUrl(url, undefined, 'tenant-a')).resolves.toBe(true);
    await expect(adapter.claimUrl(url, undefined, 'tenant-b')).resolves.toBe(false);
    await adapter.close();
  });

  it('入队失败时应补偿释放 URL 声明，而不是把 URL 锁到 TTL 到期', async () => {
    const adapter = new FailFirstEnqueueAdapter();
    const scheduler = new DistributedMasterScheduler({
      adapter,
      startLocalWorker: false,
      urlPolicy: new UrlPolicy({
        allowedHosts: ['example.com'],
        resourceHosts: ['example.com'],
        resolver: () => ['93.184.216.34'],
      }),
    });

    await expect(scheduler.submitTask({
      url: 'https://example.com/enqueue-failure-compensation',
    })).rejects.toThrow('injected enqueue failure');
    await expect(adapter.claimUrl('https://example.com/enqueue-failure-compensation')).resolves.toBe(true);

    await scheduler.shutdown();
  });

  it('重试入队失败后应保留恢复任务，并在队列恢复后再次入队', async () => {
    vi.useFakeTimers();
    const adapter = new FailFirstEnqueueAdapter();
    const task = taskRecord();
    // Seed the task as if it had already been claimed by a worker.
    adapter.failuresRemaining = 0;
    await adapter.enqueueTask(task);
    adapter.failuresRemaining = 1;
    const worker = new WorkerDaemon({
      adapter,
      concurrency: 1,
      urlPolicy: new UrlPolicy({
        allowedHosts: ['example.com'],
        resourceHosts: ['example.com'],
        resolver: () => ['93.184.216.34'],
      }),
    });

    try {
      const requeueTask = (worker as unknown as {
        requeueTask(value: DistributedTaskRecord): Promise<void>;
      }).requeueTask.bind(worker);
      await requeueTask(task);

      expect(task.state).toBe('RETRYING');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await adapter.getTask(task.id)).toMatchObject({ state: 'PENDING' });
    } finally {
      await worker.stop();
      vi.useRealTimers();
    }
  });

  it('完成状态写入失败时只重试持久化，不重复执行任务', async () => {
    vi.useFakeTimers();
    const adapter = new FailFirstUpdateAdapter();
    const task = taskRecord();
    await adapter.enqueueTask(task);
    const fetcher = vi.fn<(options: FetchOptions) => Promise<FetchResult>>().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      url: task.url,
      headers: { 'content-type': 'text/plain' },
      body: 'ok',
      durationMs: 1,
      redirectCount: 0,
    });
    const worker = new WorkerDaemon({
      adapter,
      concurrency: 1,
      urlPolicy: new UrlPolicy({
        allowedHosts: ['example.com'],
        resourceHosts: ['example.com'],
        resolver: () => ['93.184.216.34'],
      }),
      fetcher,
    });

    try {
      const executeTask = (worker as unknown as {
        executeTask(value: DistributedTaskRecord): Promise<void>;
      }).executeTask.bind(worker);
      await executeTask(task);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(await adapter.getTask(task.id)).toMatchObject({ state: 'PENDING' });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(await adapter.getTask(task.id)).toMatchObject({ state: 'COMPLETED' });
    } finally {
      await worker.stop();
      vi.useRealTimers();
    }
  });

  it('关闭时应等待已启动的恢复操作，再关闭队列连接', async () => {
    vi.useFakeTimers();
    const adapter = new BlockingUpdateAdapter();
    const close = vi.spyOn(adapter, 'close');
    const update = vi.spyOn(adapter, 'updateTask');
    const task = taskRecord({ state: 'COMPLETED' });
    await adapter.enqueueTask(task);
    const worker = new WorkerDaemon({ adapter, concurrency: 1 });

    try {
      const scheduleRecovery = (worker as unknown as {
        scheduleRecovery(value: DistributedTaskRecord, kind: 'persist', delayMs: number): void;
      }).scheduleRecovery.bind(worker);
      scheduleRecovery(task, 'persist', 1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await adapter.updateStarted;

      const stopPromise = worker.stop();
      await Promise.resolve();
      expect(close).not.toHaveBeenCalled();

      adapter.releaseUpdate();
      await stopPromise;
      expect(close).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledTimes(1);
      expect(update.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]!);
    } finally {
      adapter.releaseUpdate();
      vi.useRealTimers();
    }
  });

  it('关闭等待活跃任务期间恢复先失败时必须明确失败', async () => {
    vi.useFakeTimers();
    const adapter = new AlwaysFailUpdateAdapter();
    const worker = new WorkerDaemon({ adapter, concurrency: 1 });
    const task = taskRecord({ state: 'COMPLETED' });

    try {
      const scheduleRecovery = (worker as unknown as {
        scheduleRecovery(value: DistributedTaskRecord, kind: 'persist', delayMs: number): void;
      }).scheduleRecovery.bind(worker);
      scheduleRecovery(task, 'persist', 1_000);
      const internals = worker as unknown as { activeTasksCount: number };
      internals.activeTasksCount = 1;
      const stopPromise = worker.stop();
      const stopExpectation = expect(stopPromise).rejects.toMatchObject({ name: 'AggregateError' });
      await vi.advanceTimersByTimeAsync(1_000);
      await adapter.updateStarted;

      // The recovery has already rejected while stop is still waiting on the
      // simulated active task. The failure must survive until final drain.
      await vi.advanceTimersByTimeAsync(15_000);
      await stopExpectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it('缺少服务端 URL 策略时必须拒绝集群任务', async () => {
    const scheduler = new DistributedMasterScheduler({
      adapter: new MemoryQueueAdapter(),
      startLocalWorker: false,
    });

    await expect(scheduler.submitTask({
      url: 'https://example.com/without-policy',
      mode: 'fetch',
    })).rejects.toMatchObject({ code: 'POLICY_DENIED' });

    await scheduler.shutdown();
  });

  it('内建 Worker 与调度器共享适配器时只关闭一次且不会递归停机', async () => {
    const adapter = new MemoryQueueAdapter();
    const close = vi.spyOn(adapter, 'close');
    const scheduler = new DistributedMasterScheduler({ adapter });

    await scheduler.shutdown();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('应当正确处理异步任务排队、排重与集群状态统计', async () => {
    const adapter = new MemoryQueueAdapter();
    const scheduler = new DistributedMasterScheduler({
    adapter,
    maxConcurrency: 4,
    urlPolicy: new UrlPolicy({
      allowedHosts: ['example.com'],
      resourceHosts: ['example.com'],
      resolver: () => ['93.184.216.34'],
    }),
    startLocalWorker: false, // 禁用本地内建 Worker，纯测试队列与调度逻辑
    });

    const normalTask = await scheduler.submitTask({
      url: 'https://example.com/item1',
      mode: 'fetch',
      priority: 'NORMAL',
    });

    const criticalTask = await scheduler.submitTask({
      url: 'https://example.com/item2',
      mode: 'fetch',
      priority: 'CRITICAL',
    });

    expect(normalTask.id).toBeDefined();
    expect(criticalTask.id).toBeDefined();

    const boundedTask = await scheduler.submitTask({
      url: 'https://example.com/bounded',
      mode: 'fetch',
      maxRetries: 999,
      timeoutMs: 999_999,
    });
    expect(boundedTask.maxRetries).toBe(10);
    expect(boundedTask.timeoutMs).toBe(120_000);

    await expect(scheduler.submitTask({
      url: 'https://example.com/item1',
      mode: 'fetch',
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    await expect(scheduler.submitBatch([
      { taskId: 'same-id', url: 'https://example.com/batch-a' },
      { taskId: 'same-id', url: 'https://example.com/batch-b' },
    ])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    // 注册远程 Worker 节点
    await scheduler.registerWorker({
      workerId: 'remote-worker-node-1',
      tenantId: 'default',
      hostname: 'worker-1.cluster.internal',
      capacity: 8,
      activeTasks: 2,
      healthy: true,
      lastHeartbeat: Date.now(),
    });

    const clusterStatus = await scheduler.getClusterStatus();
    expect(clusterStatus.totalWorkers).toBe(1);
    expect(clusterStatus.totalCapacity).toBe(8);
    expect(clusterStatus.activeTasks).toBe(2);

    // 测试 URL 全局去重
    await adapter.markUrlSeen('https://example.com/seen-item');
    const isSeen = await adapter.isUrlSeen('https://example.com/seen-item');
    const isNotSeen = await adapter.isUrlSeen('https://example.com/unseen-item');
    expect(isSeen).toBe(true);
    expect(isNotSeen).toBe(false);

    await scheduler.shutdown();
  });

  it('租户之间隔离 URL 排重、任务读取、Worker 消费与状态统计', async () => {
    const adapter = new MemoryQueueAdapter();
    const scheduler = new DistributedMasterScheduler({
      adapter,
      startLocalWorker: false,
      urlPolicy: new UrlPolicy({
        allowedHosts: ['example.com'],
        resourceHosts: ['example.com'],
        resolver: () => ['93.184.216.34'],
      }),
    });
    const definition = { url: 'https://example.com/shared-between-tenants', mode: 'fetch' as const };

    const tenantATask = await scheduler.submitTask(definition, 'tenant-a');
    const tenantBTask = await scheduler.submitTask(definition, 'tenant-b');

    expect(tenantATask.tenantId).toBe('tenant-a');
    expect(tenantBTask.tenantId).toBe('tenant-b');
    expect(await scheduler.getTask(tenantATask.id, 'tenant-a')).toMatchObject({ tenantId: 'tenant-a' });
    expect(await scheduler.getTask(tenantATask.id, 'tenant-b')).toBeNull();
    expect((await scheduler.getClusterStatus('tenant-a')).queuedTasks).toBe(1);
    expect((await scheduler.getClusterStatus('tenant-b')).queuedTasks).toBe(1);

    const consumedA = await adapter.dequeueTask('worker-a', 'tenant-a');
    const consumedB = await adapter.dequeueTask('worker-b', 'tenant-b');
    expect(consumedA).toMatchObject({ id: tenantATask.id, tenantId: 'tenant-a', workerId: 'worker-a', state: 'RUNNING' });
    expect(consumedB).toMatchObject({ id: tenantBTask.id, tenantId: 'tenant-b', workerId: 'worker-b', state: 'RUNNING' });
    expect(await adapter.dequeueTask('worker-a', 'tenant-a')).toBeNull();

    await scheduler.shutdown();
  });

  it('任务被接管后旧 Worker 的 ACK/NACK 与重入队写入必须被 fencing 拒绝', async () => {
    const adapter = new MemoryQueueAdapter();
    const task = taskRecord({ id: 'lease-fencing' });
    await adapter.enqueueTask(task);

    const firstLease = await adapter.dequeueTask('worker-a');
    expect(firstLease?.leaseId).toEqual(expect.any(String));
    await adapter.enqueueTask({ ...firstLease!, state: 'PENDING' });
    const secondLease = await adapter.dequeueTask('worker-b');
    expect(secondLease?.leaseId).toEqual(expect.any(String));
    expect(secondLease?.leaseId).not.toBe(firstLease?.leaseId);

    await expect(adapter.enqueueTask({ ...firstLease!, state: 'PENDING' }))
      .rejects.toMatchObject({ code: 'TASK_LEASE_LOST' });
    await expect(adapter.updateTask({
      ...firstLease!,
      state: 'COMPLETED',
      completedAt: Date.now(),
    })).rejects.toMatchObject({ code: 'TASK_LEASE_LOST' });
    await expect(adapter.updateTask({
      ...firstLease!,
      state: 'FAILED',
      completedAt: Date.now(),
    })).rejects.toMatchObject({ code: 'TASK_LEASE_LOST' });

    expect(await adapter.getTask(task.id)).toMatchObject({
      state: 'RUNNING',
      workerId: 'worker-b',
      leaseId: secondLease?.leaseId,
    });
    await adapter.close();
  });

  it('续租必须同时校验 workerId 与 leaseId，接管后旧租约不能续期', async () => {
    const adapter = new MemoryQueueAdapter();
    const task = taskRecord({ id: 'lease-renewal' });
    await adapter.enqueueTask(task);
    const firstLease = await adapter.dequeueTask('worker-a');
    expect(firstLease).not.toBeNull();

    await expect(adapter.renewTaskLease({ ...firstLease!, workerId: 'worker-b' })).resolves.toBe(false);
    await expect(adapter.renewTaskLease({ ...firstLease!, leaseId: 'stale-lease' })).resolves.toBe(false);
    await expect(adapter.renewTaskLease(firstLease!)).resolves.toBe(true);

    await adapter.enqueueTask({ ...firstLease!, state: 'PENDING' });
    await adapter.dequeueTask('worker-b');
    await expect(adapter.renewTaskLease(firstLease!)).resolves.toBe(false);
    await adapter.close();
  });

  it('Worker 按租户与分片轮转扫描，优先级仍由分片内队列决定', async () => {
    vi.useFakeTimers();
    const adapter = new FairnessProbeAdapter();
    const worker = new WorkerDaemon({
      adapter,
      concurrency: 1,
      pollIntervalMs: 50,
      allowedTenants: ['tenant-a', 'tenant-b'],
    });

    try {
      await worker.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(adapter.dequeueCalls.slice(0, 4)).toEqual([
        { tenantId: 'tenant-a', shard: 0 },
        { tenantId: 'tenant-a', shard: 1 },
        { tenantId: 'tenant-b', shard: 0 },
        { tenantId: 'tenant-b', shard: 1 },
      ]);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(adapter.dequeueCalls.slice(4, 8)).toEqual([
        { tenantId: 'tenant-a', shard: 1 },
        { tenantId: 'tenant-b', shard: 0 },
        { tenantId: 'tenant-b', shard: 1 },
        { tenantId: 'tenant-a', shard: 0 },
      ]);
    } finally {
      await worker.stop();
      vi.useRealTimers();
    }
  });
});
