import { randomUUID } from 'node:crypto';
import type { DistributedTaskRecord, WorkerNodeInfo } from './types.js';
import { TaskLeaseLostError } from './types.js';
import { DEFAULT_TENANT_ID, normalizeTenantId } from './tenant.js';

export interface TaskQueueAdapter {
  /** Number of independent queue shards used by this adapter. */
  readonly shardCount: number;
  /** Lease duration used by workers to schedule renewal. */
  readonly leaseDurationMs: number;
  /** 任务入队（按优先级权重） */
  enqueueTask(task: DistributedTaskRecord): Promise<void>;
  /** 批量任务入队 */
  enqueueBatch(tasks: readonly DistributedTaskRecord[]): Promise<void>;
  /** 从队列按优先级抢占式拉取一个任务（原子操作） */
  dequeueTask(workerId: string, tenantId?: string, shard?: number): Promise<DistributedTaskRecord | null>;
  /** 任务执行确认（ACK）或完成更新 */
  updateTask(task: DistributedTaskRecord): Promise<void>;
  /** Renew a running task lease only when workerId and leaseId still match. */
  renewTaskLease(task: DistributedTaskRecord): Promise<boolean>;
  /** 获取单个任务状态 */
  getTask(taskId: string, tenantId?: string): Promise<DistributedTaskRecord | null>;
  /** 查询所有/过滤任务 */
  listTasks(limit?: number, tenantId?: string): Promise<DistributedTaskRecord[]>;
  /** 注册/刷新 Worker 心跳 */
  updateWorkerHeartbeat(worker: WorkerNodeInfo): Promise<void>;
  /** 获取所有活跃 Worker 节点列表 */
  listWorkers(tenantId?: string): Promise<WorkerNodeInfo[]>;
  /** 检查 URL 是否已存在（排重） */
  isUrlSeen(url: string, tenantId?: string): Promise<boolean>;
  /** 原子声明 URL；返回 false 表示已被其他任务声明。 */
  claimUrl(url: string, ttlSeconds?: number, tenantId?: string): Promise<boolean>;
  /** 原子声明一批 URL；失败时整批不产生声明。 */
  claimUrls(urls: readonly string[], ttlSeconds?: number, tenantId?: string): Promise<boolean>;
  /**
   * 释放尚未入队成功的 URL 声明。
   *
   * URL 声明和任务入队分属两个存储操作；调用方在入队失败时使用该
   * 补偿接口，避免一个暂时性的队列故障把 URL 永久（直到 TTL）标记为
   * 重复。实现必须限定在给定租户命名空间内，并对整个批次保持原子性。
   */
  releaseUrls(urls: readonly string[], tenantId?: string): Promise<void>;
  /** 记录已抓取的 URL */
  markUrlSeen(url: string, ttlSeconds?: number, tenantId?: string): Promise<void>;
  /** 优雅关闭连接 */
  close(): Promise<void>;
}

/**
 * 内存队列适配器（用于单机模式、本地调试与测试环境）
 */
export class MemoryQueueAdapter implements TaskQueueAdapter {
  public readonly shardCount: number = 1;
  public readonly leaseDurationMs = 300_000;
  private readonly tasks = new Map<string, DistributedTaskRecord>();
  private readonly pendingQueue: string[] = [];
  private readonly workers = new Map<string, WorkerNodeInfo>();
  private readonly seenUrls = new Map<string, number>();

  public async enqueueTask(task: DistributedTaskRecord): Promise<void> {
    const normalizedTask = { ...task, tenantId: normalizeTenantId(task.tenantId) };
    const key = taskKey(normalizedTask.tenantId, normalizedTask.id);
    const existing = this.tasks.get(key);
    assertLeaseOwnership(existing, normalizedTask);
    this.tasks.set(key, normalizedTask);
    // Enqueue is idempotent for a task ID. This matters when a worker retries
    // the queue operation after a transient write failure: duplicate queue
    // entries must not cause the same task to execute twice.
    if (normalizedTask.state === 'PENDING' || normalizedTask.state === 'RETRYING') {
      if (!this.pendingQueue.includes(key)) this.pendingQueue.push(key);
    } else {
      this.removePendingKey(key);
    }
  }

  public async enqueueBatch(tasks: readonly DistributedTaskRecord[]): Promise<void> {
    for (const task of tasks) {
      await this.enqueueTask(task);
    }
  }

  public async dequeueTask(workerId: string, tenantId = DEFAULT_TENANT_ID, _shard = 0): Promise<DistributedTaskRecord | null> {
    const normalizedTenantId = normalizeTenantId(tenantId);
    const prefix = `${normalizedTenantId}\0`;
    let queueIndex = this.pendingQueue.findIndex((key) => key.startsWith(prefix));
    if (queueIndex < 0) return null;
    while (queueIndex >= 0) {
      const [key] = this.pendingQueue.splice(queueIndex, 1);
      if (!key) return null;
      const task = this.tasks.get(key);
      if (!task || (task.state !== 'PENDING' && task.state !== 'RETRYING')) {
        queueIndex = this.pendingQueue.findIndex((candidate) => candidate.startsWith(prefix));
        if (queueIndex < 0) return null;
        continue;
      }
      const leasedTask: DistributedTaskRecord = {
        ...task,
        state: 'RUNNING',
        startedAt: Date.now(),
        workerId,
        leaseId: randomUUID(),
      };
      // Return a detached record. A stale worker must retain its old fencing
      // token even when another worker later takes the task over in memory.
      this.tasks.set(key, leasedTask);
      return { ...leasedTask };
    }
    return null;
  }

  public async updateTask(task: DistributedTaskRecord): Promise<void> {
    const normalizedTask = { ...task, tenantId: normalizeTenantId(task.tenantId) };
    const key = taskKey(normalizedTask.tenantId, normalizedTask.id);
    const existing = this.tasks.get(key);
    assertLeaseOwnership(existing, normalizedTask);
    this.tasks.set(key, normalizedTask);
  }

  public async renewTaskLease(task: DistributedTaskRecord): Promise<boolean> {
    if (!task.leaseId || !task.workerId) return false;
    const key = taskKey(normalizeTenantId(task.tenantId), task.id);
    const existing = this.tasks.get(key);
    return existing?.state === 'RUNNING'
      && existing.workerId === task.workerId
      && existing.leaseId === task.leaseId;
  }

  public async getTask(taskId: string, tenantId = DEFAULT_TENANT_ID): Promise<DistributedTaskRecord | null> {
    return this.tasks.get(taskKey(normalizeTenantId(tenantId), taskId)) ?? null;
  }

  public async listTasks(limit = 100, tenantId = DEFAULT_TENANT_ID): Promise<DistributedTaskRecord[]> {
    const normalizedTenantId = normalizeTenantId(tenantId);
    return Array.from(this.tasks.values()).filter((task) => task.tenantId === normalizedTenantId).slice(0, limit);
  }

  public async updateWorkerHeartbeat(worker: WorkerNodeInfo): Promise<void> {
    const tenantId = normalizeTenantId(worker.tenantId);
    this.workers.set(taskKey(tenantId, worker.workerId), { ...worker, tenantId, lastHeartbeat: Date.now() });
  }

  public async listWorkers(tenantId = DEFAULT_TENANT_ID): Promise<WorkerNodeInfo[]> {
    const normalizedTenantId = normalizeTenantId(tenantId);
    return Array.from(this.workers.values()).filter((worker) => worker.tenantId === normalizedTenantId);
  }

  public async isUrlSeen(url: string, tenantId = DEFAULT_TENANT_ID): Promise<boolean> {
    const key = taskKey(normalizeTenantId(tenantId), url);
    const expiresAt = this.seenUrls.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= Date.now()) {
      this.seenUrls.delete(key);
      return false;
    }
    return true;
  }

  public async claimUrl(url: string, ttlSeconds = 2_592_000, tenantId = DEFAULT_TENANT_ID): Promise<boolean> {
    return this.claimUrls([url], ttlSeconds, tenantId);
  }

  public async claimUrls(urls: readonly string[], ttlSeconds = 2_592_000, tenantId = DEFAULT_TENANT_ID): Promise<boolean> {
    if (urls.length === 0 || ttlSeconds <= 0) return false;
    const normalizedTenantId = normalizeTenantId(tenantId);
    const now = Date.now();
    for (const url of urls) {
      const expiresAt = this.seenUrls.get(taskKey(normalizedTenantId, url));
      if (expiresAt !== undefined && expiresAt > now) return false;
    }
    const expiresAt = now + ttlSeconds * 1_000;
    for (const url of urls) this.seenUrls.set(taskKey(normalizedTenantId, url), expiresAt);
    return true;
  }

  public async releaseUrls(urls: readonly string[], tenantId = DEFAULT_TENANT_ID): Promise<void> {
    if (urls.length === 0) return;
    const normalizedTenantId = normalizeTenantId(tenantId);
    for (const url of urls) this.seenUrls.delete(taskKey(normalizedTenantId, url));
  }

  private removePendingKey(key: string): void {
    let index = this.pendingQueue.indexOf(key);
    while (index >= 0) {
      this.pendingQueue.splice(index, 1);
      index = this.pendingQueue.indexOf(key);
    }
  }

  public async markUrlSeen(url: string, ttlSeconds = 2_592_000, tenantId = DEFAULT_TENANT_ID): Promise<void> {
    if (ttlSeconds <= 0) return;
    this.seenUrls.set(taskKey(normalizeTenantId(tenantId), url), Date.now() + ttlSeconds * 1_000);
  }

  public async close(): Promise<void> {
    this.tasks.clear();
    this.pendingQueue.length = 0;
    this.workers.clear();
    this.seenUrls.clear();
  }
}

function assertLeaseOwnership(
  existing: DistributedTaskRecord | undefined,
  incoming: DistributedTaskRecord,
): void {
  const existingLeaseId = existing?.leaseId;
  const incomingLeaseId = incoming.leaseId;
  if (existingLeaseId !== undefined) {
    if (incomingLeaseId !== existingLeaseId || incoming.workerId !== existing?.workerId) {
      throw new TaskLeaseLostError();
    }
    return;
  }
  // A task record written by an older version has no fencing token. Permit a
  // compatible migration/update until a new dequeue assigns one.
}

function taskKey(tenantId: string, value: string): string {
  return `${tenantId}\0${value}`;
}
