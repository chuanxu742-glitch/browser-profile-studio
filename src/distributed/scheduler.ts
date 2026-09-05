import type { Cluster, Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { BrowserToolError } from '../domain.js';
import type { SessionManager } from '../browser/session-manager.js';
import type { FetchUrlPolicy } from '../fetcher/types.js';
import type { TaskQueueAdapter } from './queue-adapter.js';
import { MemoryQueueAdapter } from './queue-adapter.js';
import { RedisQueueAdapter } from './redis-adapter.js';
import type { RedisMode } from './redis-adapter.js';
import { WorkerDaemon } from './worker-daemon.js';
import type {
  ClusterStatus,
  DistributedTaskDefinition,
  DistributedTaskRecord,
  TaskEvent,
  TaskListFilter,
  TaskUrlPreflight,
  WorkerNodeInfo,
  TaskExecutionMode,
} from './types.js';
import {
  AccountPlacementRegistry,
  InMemorySharedStateStore,
  RedisSharedAccountStateStore
} from './account-placement.js';
import type { SharedAccountStateStore, AccountPlacementRecord } from './account-placement.js';
import { DEFAULT_TENANT_ID, normalizeTenantId } from './tenant.js';

export interface MasterSchedulerOptions {
  maxConcurrency?: number | undefined;
  sessionManager?: SessionManager | undefined;
  adapter?: TaskQueueAdapter | undefined;
  redisUrl?: string | undefined;
  redisMode?: RedisMode | undefined;
  redisClusterNodes?: readonly string[] | undefined;
  redisShardCount?: number | undefined;
  urlPolicy?: FetchUrlPolicy | undefined;
  startLocalWorker?: boolean | undefined; // 是否在本机启动内建 Worker
  accountStateStore?: SharedAccountStateStore<AccountPlacementRecord> | undefined;
}

/**
 * 分布式主调度引擎 (Master Coordinator)
 * 负责与 Redis / 内存消息队列交互，分发跨机器任务，监控集群 Worker 状态与全局排重
 */
export class DistributedMasterScheduler {
  private readonly adapter: TaskQueueAdapter;
  private readonly localWorker?: WorkerDaemon | undefined;
  private readonly urlPolicy?: FetchUrlPolicy | undefined;
  private readonly placementRegistry: AccountPlacementRegistry;
  private localWorkerReady: Promise<void> | undefined;

  public constructor(options: MasterSchedulerOptions = {}) {
    this.urlPolicy = options.urlPolicy;
    if (options.adapter) {
      this.adapter = options.adapter;
    } else if (options.redisUrl || options.redisClusterNodes !== undefined || options.redisMode !== undefined || process.env.REDIS_URL || process.env.REDIS_CLUSTER_NODES) {
      this.adapter = new RedisQueueAdapter({
        ...(options.redisUrl !== undefined ? { redisUrl: options.redisUrl } : {}),
        ...(options.redisMode !== undefined ? { redisMode: options.redisMode } : {}),
        ...(options.redisClusterNodes !== undefined ? { redisClusterNodes: options.redisClusterNodes } : {}),
        ...(options.redisShardCount !== undefined ? { shardCount: options.redisShardCount } : {}),
      });
    } else {
      this.adapter = new MemoryQueueAdapter();
    }

    const stateStore = options.accountStateStore
      ?? (this.adapter instanceof RedisQueueAdapter
        ? new RedisSharedAccountStateStore<AccountPlacementRecord>(
          this.adapter.underlyingRedisClient as Redis | Cluster,
        )
        : new InMemorySharedStateStore<AccountPlacementRecord>());
    this.placementRegistry = new AccountPlacementRegistry(stateStore, Date.now, 60_000);

    if (options.startLocalWorker !== false) {
      const workerId = 'master-local-worker';
      const capacity = options.maxConcurrency ?? 16;
      const storageNamespace = `local:${workerId}`;
      this.localWorker = new WorkerDaemon({
        workerId,
        concurrency: capacity,
        adapter: this.adapter,
        sessionManager: options.sessionManager,
        urlPolicy: options.urlPolicy,
        storageNamespace,
        accountPlacementStore: stateStore,
      });
      this.localWorkerReady = this.adapter.updateWorkerHeartbeat({
        workerId,
        tenantId: DEFAULT_TENANT_ID,
        hostname: 'localhost',
        capacity,
        activeTasks: 0,
        healthy: true,
        lastHeartbeat: Date.now(),
        storageNamespace,
      });
      void this.localWorker.start();
    }
  }

  private async resolvePlacement(
    tenantId: string,
    mode: TaskExecutionMode,
    profileId: string | undefined,
  ): Promise<{ workerId: string; generation: number } | undefined> {
    if (mode !== 'browser' || profileId === undefined) return undefined;
    if (this.localWorkerReady) {
      await this.localWorkerReady.catch(() => undefined);
      this.localWorkerReady = undefined;
    }
    this.placementRegistry.syncWorkers(await this.adapter.listWorkers(tenantId));
    try {
      return await this.placementRegistry.acquirePlacement(tenantId, profileId);
    } catch (error: unknown) {
      if (error instanceof Error && error.message.startsWith('CAS conflict:')) {
        return this.placementRegistry.acquirePlacement(tenantId, profileId);
      }
      throw error;
    }
  }

  public getAdapter(): TaskQueueAdapter {
    return this.adapter;
  }

  public async registerWorker(worker: WorkerNodeInfo): Promise<void> {
    const tenantId = normalizeTenantId(worker.tenantId);
    this.placementRegistry.registerWorker(
      worker.workerId,
      worker.capacity,
      worker.storageNamespace ?? `local:${worker.workerId}`,
      tenantId,
    );
    this.placementRegistry.updateLoad(worker.workerId, worker.activeTasks);
    await this.adapter.updateWorkerHeartbeat({ ...worker, tenantId });
  }

  /**
   * 提交任务到分布式队列
   */
  public async submitTask(def: DistributedTaskDefinition, tenantId = DEFAULT_TENANT_ID): Promise<DistributedTaskRecord> {
    const normalizedTenantId = normalizeTenantId(tenantId);
    const id = this.taskId(def.taskId);
    const projectId = this.taskLabel(def.projectId, 'projectId');
    const runId = this.taskLabel(def.runId, 'runId');
    const mode = this.taskMode(def.mode);
    const priority = this.taskPriority(def.priority);
    const maxRetries = this.maxRetries(def.maxRetries);
    const timeoutMs = this.timeoutMs(def.timeoutMs);
    const profileId = this.taskLabel(def.profileId, 'profileId');
    const proxyId = this.taskLabel(def.proxyId, 'proxyId');
    const accountGroup = this.taskLabel(def.accountGroup, 'accountGroup');
    let targetWorkerId: string | undefined = undefined;
    let placementGeneration: number | undefined = undefined;

    const placement = await this.resolvePlacement(normalizedTenantId, mode, profileId);
    if (placement) {
      targetWorkerId = placement.workerId;
      placementGeneration = placement.generation;
    }

    const url = await this.assertTaskUrl(def.url);
    await this.claimUrls([url], normalizedTenantId);
    const record: DistributedTaskRecord = {
      id,
      tenantId: normalizedTenantId,
      ...(projectId ? { projectId } : {}),
      ...(runId ? { runId } : {}),
      url,
      mode,
      priority,
      ...(profileId ? { profileId } : {}),
      ...(proxyId ? { proxyId } : {}),
      ...(accountGroup ? { accountGroup } : {}),
      ...(targetWorkerId ? { targetWorkerId } : {}),
      ...(placementGeneration !== undefined ? { placementGeneration } : {}),
      state: 'PENDING',
      retries: 0,
      maxRetries,
      extractionSchema: def.extractionSchema,
      timeoutMs,
      createdAt: Date.now(),
      events: [{ at: Date.now(), state: 'PENDING', phase: 'queued', message: '任务已排队' }],
    };

    try {
      await this.adapter.enqueueTask(record);
    } catch (enqueueError: unknown) {
      await this.compensateUrlClaim([url], normalizedTenantId, enqueueError);
    }
    return record;
  }

  /**
   * 批量提交任务
   */
  public async submitBatch(definitions: readonly DistributedTaskDefinition[], tenantId = DEFAULT_TENANT_ID): Promise<DistributedTaskRecord[]> {
    const normalizedTenantId = normalizeTenantId(tenantId);
    if (definitions.length < 1 || definitions.length > 500) {
      throw new BrowserToolError('INVALID_ARGUMENT', 'A task batch must contain between 1 and 500 tasks.', {
        details: { reason: 'batch-size-out-of-range' },
        retryable: false,
      });
    }

    const normalized = definitions.map((definition) => ({
      definition,
      id: this.taskId(definition.taskId),
      projectId: this.taskLabel(definition.projectId, 'projectId'),
      runId: this.taskLabel(definition.runId, 'runId'),
      mode: this.taskMode(definition.mode),
      priority: this.taskPriority(definition.priority),
      maxRetries: this.maxRetries(definition.maxRetries),
      timeoutMs: this.timeoutMs(definition.timeoutMs),
      profileId: this.taskLabel(definition.profileId, 'profileId'),
      proxyId: this.taskLabel(definition.proxyId, 'proxyId'),
      accountGroup: this.taskLabel(definition.accountGroup, 'accountGroup'),
    }));
    const ids = new Set<string>();
    for (const task of normalized) {
      if (ids.has(task.id)) {
        throw new BrowserToolError('INVALID_ARGUMENT', 'A batch contains duplicate task IDs.', {
          details: { reason: 'duplicate-task-id-in-batch' },
          retryable: false,
        });
      }
      ids.add(task.id);
    }

    const approvedUrls = await Promise.all(definitions.map((definition) => this.assertTaskUrl(definition.url)));
    if (new Set(approvedUrls).size !== approvedUrls.length) {
      throw new BrowserToolError('INVALID_ARGUMENT', 'A batch contains duplicate URLs.', {
        details: { reason: 'duplicate-url-in-batch' },
        retryable: false,
      });
    }
    const placements = await Promise.all(normalized.map((task) => (
      this.resolvePlacement(normalizedTenantId, task.mode, task.profileId)
    )));
    await this.claimUrls(approvedUrls, normalizedTenantId);

    const createdAt = Date.now();
    const records = normalized.map((task, index): DistributedTaskRecord => {
      const placement = placements[index];
      return {
        id: task.id,
        tenantId: normalizedTenantId,
        ...(task.projectId !== undefined ? { projectId: task.projectId } : {}),
        ...(task.runId !== undefined ? { runId: task.runId } : {}),
        url: approvedUrls[index]!,
        mode: task.mode,
        priority: task.priority,
        ...(task.profileId !== undefined ? { profileId: task.profileId } : {}),
        ...(task.proxyId !== undefined ? { proxyId: task.proxyId } : {}),
        ...(task.accountGroup !== undefined ? { accountGroup: task.accountGroup } : {}),
        ...(placement !== undefined ? {
          targetWorkerId: placement.workerId,
          placementGeneration: placement.generation,
        } : {}),
        state: 'PENDING',
        retries: 0,
        maxRetries: task.maxRetries,
        ...(task.definition.extractionSchema !== undefined
          ? { extractionSchema: task.definition.extractionSchema }
          : {}),
        timeoutMs: task.timeoutMs,
        createdAt,
        events: [{ at: createdAt, state: 'PENDING', phase: 'queued', message: '任务已排队' }],
      };
    });

    try {
      await this.adapter.enqueueBatch(records);
    } catch (enqueueError: unknown) {
      await this.compensateUrlClaim(approvedUrls, normalizedTenantId, enqueueError);
    }
    return records;
  }

  public async getTask(taskId: string, tenantId = DEFAULT_TENANT_ID): Promise<DistributedTaskRecord | null> {
    return this.adapter.getTask(taskId, normalizeTenantId(tenantId));
  }

  public async listTasks(
    filter: TaskListFilter = {},
    limit = 100,
    tenantId = DEFAULT_TENANT_ID,
  ): Promise<DistributedTaskRecord[]> {
    const normalizedFilter: TaskListFilter = {
      ...(filter.projectId !== undefined ? { projectId: this.taskLabel(filter.projectId, 'projectId') } : {}),
      ...(filter.runId !== undefined ? { runId: this.taskLabel(filter.runId, 'runId') } : {}),
      ...(filter.state !== undefined ? { state: filter.state } : {}),
      ...(filter.mode !== undefined ? { mode: filter.mode } : {}),
      ...(filter.priority !== undefined ? { priority: filter.priority } : {}),
      ...(filter.createdAfter !== undefined ? { createdAfter: filter.createdAfter } : {}),
      ...(filter.createdBefore !== undefined ? { createdBefore: filter.createdBefore } : {}),
    };
    return this.adapter.listTasks(limit, normalizeTenantId(tenantId), normalizedFilter);
  }

  public async preflightTaskUrl(url: string, tenantId = DEFAULT_TENANT_ID): Promise<TaskUrlPreflight> {
    let origin: string | undefined;
    try {
      origin = new URL(url).origin;
    } catch {
      return { allowed: false, policy: 'deny', reason: 'invalid-url' };
    }
    if (!this.urlPolicy?.assertAllowed) {
      return { allowed: false, origin, policy: 'unavailable', reason: 'missing-url-policy' };
    }
    try {
      const decision = await this.urlPolicy.assertAllowed(url, 'navigation');
      const allowed = decision instanceof URL
        || (typeof decision === 'object' && decision !== null && 'allowed' in decision
          ? Boolean((decision as { allowed?: unknown }).allowed)
          : decision !== false);
      return { allowed, origin, policy: allowed ? 'allow' : 'deny', reason: allowed ? 'approved' : 'url-not-allowed' };
    } catch (error: unknown) {
      return {
        allowed: false,
        origin,
        policy: 'deny',
        reason: error instanceof Error ? error.message.slice(0, 120) : 'policy-denied',
      };
    }
  }

  public async cancelTask(taskId: string, tenantId = DEFAULT_TENANT_ID): Promise<DistributedTaskRecord> {
    const task = await this.getTask(taskId, tenantId);
    if (!task) throw new Error('TASK_NOT_FOUND');
    if (task.state === 'RUNNING') throw new Error('TASK_RUNNING');
    if (task.state === 'CANCELLED') return task;
    const updated: DistributedTaskRecord = {
      ...task,
      state: 'CANCELLED',
      completedAt: Date.now(),
      events: appendTaskEvent(task, 'cancelled', '任务已由操作员取消'),
    };
    await this.adapter.updateTask(updated);
    return updated;
  }

  public async retryTask(taskId: string, tenantId = DEFAULT_TENANT_ID): Promise<DistributedTaskRecord> {
    const task = await this.getTask(taskId, tenantId);
    if (!task) throw new Error('TASK_NOT_FOUND');
    if (task.state !== 'FAILED' && task.state !== 'CANCELLED') throw new Error('TASK_NOT_RETRYABLE');
    const placement = await this.resolvePlacement(task.tenantId, task.mode, task.profileId);
    const updated: DistributedTaskRecord = {
      ...task,
      state: 'RETRYING',
      retries: 0,
      completedAt: undefined,
      error: undefined,
      errorCode: undefined,
      targetWorkerId: placement?.workerId,
      placementGeneration: placement?.generation,
      events: appendTaskEvent(task, 'retrying', '任务已重新排队'),
    };
    await this.adapter.enqueueTask(updated);
    return updated;
  }

  public async getClusterStatus(tenantId = DEFAULT_TENANT_ID): Promise<ClusterStatus> {
    const normalizedTenantId = normalizeTenantId(tenantId);
    const now = Date.now();
    const workers = await this.adapter.listWorkers(normalizedTenantId);
    const healthyWorkers = workers.filter((w) => w.healthy && now - w.lastHeartbeat < 60_000);
    const totalCapacity = healthyWorkers.reduce((sum, w) => sum + w.capacity, 0);
    const activeTasks = healthyWorkers.reduce((sum, w) => sum + w.activeTasks, 0);

    const allTasks = await this.adapter.listTasks(500, normalizedTenantId);
    const completedTasks = allTasks.filter((t) => t.state === 'COMPLETED').length;
    const failedTasks = allTasks.filter((t) => t.state === 'FAILED').length;
    const queuedTasks = allTasks.filter((t) => t.state === 'PENDING' || t.state === 'RETRYING').length;

    return {
      totalWorkers: workers.length,
      healthyWorkers: healthyWorkers.length,
      totalCapacity,
      activeTasks,
      queuedTasks,
      completedTasks,
      failedTasks,
    };
  }

  public async shutdown(): Promise<void> {
    if (this.localWorker) {
      await this.localWorker.stop();
      // The built-in worker owns the shared adapter and closes it as part of
      // its shutdown. Closing the same Redis connection a second time can
      // race with ioredis teardown.
      return;
    }
    await this.adapter.close();
  }

  private async assertTaskUrl(url: string): Promise<string> {
    const policy = this.urlPolicy;
    if (!policy?.assertAllowed) {
      throw new BrowserToolError('POLICY_DENIED', 'A server URL policy is required for cluster tasks.', {
        details: { reason: 'missing-url-policy' },
        retryable: false,
      });
    }
    const decision = await policy.assertAllowed(url, 'navigation');
    if (decision === false || (typeof decision === 'object' && decision !== null && 'allowed' in decision && !(decision as { allowed: boolean }).allowed)) {
      throw new BrowserToolError('POLICY_DENIED', 'The cluster task URL is outside the approved URL policy.', {
        details: { reason: 'url-not-allowed' },
        retryable: false,
      });
    }
    return decision instanceof URL ? decision.toString() : url;
  }

  private async claimUrls(urls: readonly string[], tenantId: string): Promise<void> {
    if (!(await this.adapter.claimUrls(urls, undefined, tenantId))) {
      throw new BrowserToolError('INVALID_ARGUMENT', 'The URL has already been processed.', {
        details: { reason: 'duplicate-url' },
        retryable: false,
      });
    }
  }

  private async compensateUrlClaim(
    urls: readonly string[],
    tenantId: string,
    enqueueError: unknown,
  ): Promise<never> {
    try {
      await this.adapter.releaseUrls(urls, tenantId);
    } catch (releaseError: unknown) {

      throw new AggregateError(
        [enqueueError, releaseError],
        'Task enqueue failed and URL claim compensation also failed.',
      );
    }
    throw enqueueError;
  }

  private taskId(value: string | undefined): string {
    if (value === undefined) return `task_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
      throw new BrowserToolError('INVALID_ARGUMENT', 'taskId contains invalid characters.', {
        details: { reason: 'invalid-task-id' },
        retryable: false,
      });
    }
    return value;
  }
  private taskLabel(value: string | undefined, name: string): string | undefined {
    if (value === undefined) return undefined;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
      throw new BrowserToolError('INVALID_ARGUMENT', `${name} contains invalid characters.`, {
        details: { reason: `invalid-${name}` },
        retryable: false,
      });
    }
    return value;
  }

  private taskMode(value: DistributedTaskDefinition['mode']): 'fetch' | 'browser' {
    if (value === undefined || value === 'fetch' || value === 'browser') return value ?? 'fetch';
    throw new BrowserToolError('INVALID_ARGUMENT', 'Task mode is invalid.', { retryable: false });
  }

  private taskPriority(value: DistributedTaskDefinition['priority']): 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL' {
    if (value === undefined || value === 'LOW' || value === 'NORMAL' || value === 'HIGH' || value === 'CRITICAL') {
      return value ?? 'NORMAL';
    }
    throw new BrowserToolError('INVALID_ARGUMENT', 'Task priority is invalid.', { retryable: false });
  }

  private maxRetries(value: number | undefined): number {
    if (value !== undefined && !Number.isFinite(value)) throw new BrowserToolError('INVALID_ARGUMENT', 'maxRetries is invalid.');
    return Math.max(0, Math.min(10, Math.floor(value ?? 3)));
  }

  private timeoutMs(value: number | undefined): number {
    if (value !== undefined && !Number.isFinite(value)) throw new BrowserToolError('INVALID_ARGUMENT', 'timeoutMs is invalid.');
    return Math.max(1_000, Math.min(120_000, Math.floor(value ?? 30_000)));
  }
}

function appendTaskEvent(
  task: DistributedTaskRecord,
  phase: 'queued' | 'running' | 'retrying' | 'completed' | 'failed' | 'cancelled',
  message: string,
): NonNullable<DistributedTaskRecord['events']> {
  const state: TaskEvent['state'] = phase === 'queued' ? 'PENDING' : phase === 'running' ? 'RUNNING' : phase === 'retrying' ? 'RETRYING' : phase === 'completed' ? 'COMPLETED' : phase === 'failed' ? 'FAILED' : 'CANCELLED';
  return [...(task.events ?? []), {
    at: Date.now(),
    state,
    phase,
    message,
    ...(task.workerId ? { workerId: task.workerId } : {}),
  }].slice(-50);
}
