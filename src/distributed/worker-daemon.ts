import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { TaskQueueAdapter } from './queue-adapter.js';
import { RedisQueueAdapter } from './redis-adapter.js';
import type { RedisMode } from './redis-adapter.js';
import { MemoryQueueAdapter } from './queue-adapter.js';
import type { SessionManager } from '../browser/session-manager.js';
import { fetchPage } from '../fetcher/http-client.js';
import type { FetchOptions, FetchResult, FetchUrlPolicy } from '../fetcher/types.js';
import { isTaskLeaseLostError } from './types.js';
import type { DistributedTaskRecord, WorkerNodeInfo } from './types.js';
import { DEFAULT_TENANT_ID, normalizeTenantId } from './tenant.js';

const QUEUE_RECOVERY_DELAY_MS = 1_000;
const RECOVERY_DRAIN_TIMEOUT_MS = 5_000;

type RecoveryKind = 'enqueue' | 'persist';
type WorkerFetcher = (options: FetchOptions) => Promise<FetchResult>;

interface RecoveryWork {
  task: DistributedTaskRecord;
  kind: RecoveryKind;
}

export interface WorkerDaemonOptions {
  workerId?: string | undefined;
  hostname?: string | undefined;
  concurrency?: number | undefined;
  adapter?: TaskQueueAdapter | undefined;
  redisUrl?: string | undefined;
  redisMode?: RedisMode | undefined;
  redisClusterNodes?: readonly string[] | undefined;
  redisShardCount?: number | undefined;
  sessionManager?: SessionManager | undefined;
  urlPolicy?: FetchUrlPolicy | undefined;
  /** Injectable for deterministic worker tests; production defaults to fetchPage. */
  fetcher?: WorkerFetcher | undefined;
  pollIntervalMs?: number | undefined;
  /** Tenants this trusted worker is allowed to consume. */
  allowedTenants?: readonly string[] | undefined;
}

/**
 * 独立的分布式 Worker 守护进程
 * 可独立部署在任意远程物理机或容器中，自主抢占任务、执行受策略约束的 Firefox/Fetch 并上报心跳
 */
export class WorkerDaemon {
  private readonly workerId: string;
  private readonly hostname: string;
  private readonly capacity: number;
  private readonly adapter: TaskQueueAdapter;
  private readonly sessionManager?: SessionManager | undefined;
  private readonly urlPolicy?: FetchUrlPolicy | undefined;
  private readonly fetcher: WorkerFetcher;
  private readonly pollIntervalMs: number;
  private readonly allowedTenants: readonly string[];
  private activeTasksCount = 0;
  private isRunning = false;
  private closed = false;
  private startPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private heartbeatTimer?: NodeJS.Timeout | undefined;
  private readonly retryTimers = new Map<NodeJS.Timeout, RecoveryWork>();
  private readonly recoveryPromises = new Set<Promise<void>>();
  private readonly recoveryFailures: unknown[] = [];
  private readonly lateRecoveryWork: RecoveryWork[] = [];
  private readonly activeControllers = new Map<string, AbortController>();
  /** Start partition scans at a different tenant/shard on every poll round. */
  private partitionCursor = 0;
  private stopping = false;
  private shutdownFinished = false;

  public constructor(options: WorkerDaemonOptions = {}) {
    this.workerId = options.workerId ?? `worker_${os.hostname()}_${randomUUID().slice(0, 8)}`;
    this.hostname = options.hostname ?? os.hostname();
    this.capacity = boundedInteger(options.concurrency ?? Math.max(2, os.cpus().length), 1, 32, 2);
    this.pollIntervalMs = boundedInteger(options.pollIntervalMs ?? 200, 50, 5_000, 200);
    const configuredTenants = options.allowedTenants ?? [DEFAULT_TENANT_ID];
    this.allowedTenants = Object.freeze([...new Set(configuredTenants.map(normalizeTenantId))]);

    if (options.adapter) {
      this.adapter = options.adapter;
    } else if (options.redisUrl || options.redisClusterNodes !== undefined || options.redisMode !== undefined || process.env.REDIS_URL || process.env.REDIS_CLUSTER_NODES) {
      this.adapter = new RedisQueueAdapter({
        redisUrl: options.redisUrl,
        ...(options.redisMode !== undefined ? { redisMode: options.redisMode } : {}),
        ...(options.redisClusterNodes !== undefined ? { redisClusterNodes: options.redisClusterNodes } : {}),
        ...(options.redisShardCount !== undefined ? { shardCount: options.redisShardCount } : {}),
      });
    } else {
      this.adapter = new MemoryQueueAdapter();
    }

    this.sessionManager = options.sessionManager;
    this.urlPolicy = options.urlPolicy;
    this.fetcher = options.fetcher ?? fetchPage;
  }

  public async start(): Promise<void> {
    if (this.closed) throw new Error('WorkerDaemon is already stopped.');
    if (this.startPromise) return this.startPromise;
    if (this.isRunning) return;
    const promise = this.startInternal();
    this.startPromise = promise;
    try {
      await promise;
    } finally {
      if (this.startPromise === promise) this.startPromise = undefined;
    }
  }

  private async startInternal(): Promise<void> {
    this.isRunning = true;

    // 1. 注册每个租户范围内的初始心跳
    await Promise.all(this.allowedTenants.map((tenantId) => this.sendHeartbeat(tenantId)));

    // 2. 启动周期心跳汇报 (每 10 秒)
    this.heartbeatTimer = setInterval(() => {
      void Promise.all(this.allowedTenants.map((tenantId) => this.sendHeartbeat(tenantId)));
    }, 10_000);

    // 3. 启动任务抢占消费循环
    void this.pollLoop();
  }

  public async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const promise = this.stopInternal();
    this.stopPromise = promise;
    try {
      await promise;
    } finally {
      if (this.stopPromise === promise) this.stopPromise = undefined;
    }
  }

  private async stopInternal(): Promise<void> {
    if (this.closed) return;
    if (this.startPromise) await this.startPromise.catch(() => undefined);
    this.stopping = true;
    this.closed = true;
    this.isRunning = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const controller of this.activeControllers.values()) controller.abort();

    // Close browser sessions early so active browser tasks observe shutdown
    // instead of keeping the worker alive until their full timeout.
    if (this.sessionManager) {
      await this.sessionManager.shutdownSessions('worker_stopping').catch(() => undefined);
    }

    // 等待活跃任务清空，但不能无限阻塞优雅关闭
    let checks = 0;
    while (this.activeTasksCount > 0 && checks < 30) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      checks++;
    }

    const activeTasksTimedOut = this.activeTasksCount > 0;
    // Active tasks may schedule a recovery after observing the stop signal, so
    // collect both timer-backed and in-flight recovery work only after they
    // have finished. A failed drain is surfaced to the caller instead of
    // being silently discarded.
    const recoveryErrors: unknown[] = [];
    recoveryErrors.push(...this.recoveryFailures.splice(0));
    await this.collectInFlightRecoveryErrors(recoveryErrors);
    // A recovery may settle in the tiny window after the initial snapshot
    // and before collect observes an in-flight promise. Consume that second
    // failure batch as well.
    recoveryErrors.push(...this.recoveryFailures.splice(0));
    const recoveryWork = Array.from(this.retryTimers.entries());
    this.retryTimers.clear();
    for (const [timer, work] of recoveryWork) {
      clearTimeout(timer);
      await this.flushRecoveryCollectingErrors(work, recoveryErrors);
    }
    while (this.lateRecoveryWork.length > 0) {
      const work = this.lateRecoveryWork.shift();
      if (work) await this.flushRecoveryCollectingErrors(work, recoveryErrors);
    }
    recoveryErrors.push(...this.recoveryFailures.splice(0));
    if (activeTasksTimedOut) {
      recoveryErrors.push(new Error('Worker shutdown timed out while active tasks were still running.'));
    }

    let closeError: unknown;
    try {
      await this.adapter.close();
    } catch (error: unknown) {
      closeError = error;
    }
    this.shutdownFinished = true;
    if (recoveryErrors.length > 0 || closeError !== undefined) {
      const errors = closeError === undefined ? recoveryErrors : [...recoveryErrors, closeError];
      throw new AggregateError(errors, 'Worker shutdown could not durably flush queue recovery work.');
    }
  }

  private async sendHeartbeat(tenantId: string): Promise<void> {
    try {
      const info: WorkerNodeInfo = {
        workerId: this.workerId,
        tenantId,
        hostname: this.hostname,
        capacity: this.capacity,
        activeTasks: this.activeTasksCount,
        healthy: true,
        lastHeartbeat: Date.now(),
      };
      await this.adapter.updateWorkerHeartbeat(info);
    } catch {}
  }

  private async pollLoop(): Promise<void> {
    while (this.isRunning) {
      if (this.activeTasksCount >= this.capacity) {
        await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
        continue;
      }

      const tenantCount = this.allowedTenants.length;
      const shardCount = Number.isInteger(this.adapter.shardCount) && this.adapter.shardCount > 0
        ? this.adapter.shardCount
        : 1;
      const partitionCount = tenantCount * shardCount;
      if (partitionCount === 0) {
        await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
        continue;
      }

      // Priority is still evaluated by the adapter within each partition.
      // Rotating the starting partition prevents a permanently empty/low
      // priority partition from starving later tenants or shards; this is a
      // bounded, approximate global fairness policy rather than a cross-shard
      // priority merge.
      const start = this.partitionCursor % partitionCount;
      let claimed = false;
      for (let offset = 0; offset < partitionCount && this.activeTasksCount < this.capacity; offset++) {
        const partition = (start + offset) % partitionCount;
        const tenantIndex = Math.floor(partition / shardCount);
        const tenantId = this.allowedTenants[tenantIndex];
        const shard = partition % shardCount;
        if (!tenantId) continue;
        try {
          const task = await this.adapter.dequeueTask(this.workerId, tenantId, shard);
          if (!task) continue;
          claimed = true;
          this.activeTasksCount++;
          // 异步执行任务
          void this.executeTask(task);
        } catch {
          // A temporary queue failure should not stop other tenant/shard
          // partitions from being consumed.
        }
      }
      this.partitionCursor = (start + 1) % partitionCount;
      if (!claimed) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  private async executeTask(task: DistributedTaskRecord): Promise<void> {
    const start = Date.now();
    const controller = new AbortController();
    const controllerKey = `${task.tenantId}\0${task.id}`;
    this.activeControllers.set(controllerKey, controller);
    const leaseTimer = this.startLeaseRenewal(task, controller);

    try {
      let resultData: unknown;

      if (task.mode === 'fetch') {
        if (!this.urlPolicy) throw new Error('A server URL policy is required for worker fetch tasks');
        const fetchRes = await this.fetcher({
          url: task.url,
          timeoutMs: task.timeoutMs,
          urlPolicy: this.urlPolicy,
          signal: controller.signal,
        });

        if (!fetchRes.ok && [403, 429, 503].includes(fetchRes.status)) {
          throw new Error(`HTTP ${fetchRes.status}: ${fetchRes.statusText}`);
        }

        resultData = fetchRes;
      } else {
        const sm = this.sessionManager;
        if (!sm) {
          throw new Error('SessionManager is required for browser execution mode on this worker');
        }

        const session = (await sm.start({
          headless: true,
        })) as { sessionId: string };

        try {
          await sm.open(session.sessionId, task.url, { timeoutMs: task.timeoutMs });

          if (task.extractionSchema) {
            resultData = await sm.extract(session.sessionId, task.extractionSchema);
          } else {
            resultData = await sm.snapshot(session.sessionId, { maxChars: 15_000 });
          }
        } finally {
          await sm.stop(session.sessionId).catch(() => undefined);
        }
      }

      task.state = 'COMPLETED';
      task.completedAt = Date.now();
      task.durationMs = Date.now() - start;
      task.result = resultData;

      // 写入完成状态
      try {
        await this.persistCompletedTask(task);
      } catch (error: unknown) {
        if (isTaskLeaseLostError(error)) return;
        // The task has completed locally, but completion is not an ACK until
        // the record is durable. Retry the persistence operation without
        // executing the read-only task again.
        this.scheduleRecovery(task, 'persist', QUEUE_RECOVERY_DELAY_MS);
        return;
      }
    } catch (err: unknown) {
      const errorMsg = safeTaskError(err);
      if (task.retries < task.maxRetries) {
        task.retries += 1;
        task.state = 'RETRYING';
        task.error = errorMsg;
        // If this write fails, the existing Redis lease (or the recovery
        // enqueue below) remains the source of eventual delivery. Do not
        // discard the task merely because its status write was unavailable.
        let statusPersisted = true;
        try {
          await this.persistTask(task);
        } catch (error: unknown) {
          if (isTaskLeaseLostError(error)) return;
          // The enqueue recovery below is deliberately scheduled even when
          // the status write failed, so the task cannot remain lease-only.
          statusPersisted = false;
        }

        if (!this.isRunning) {
          await this.requeueTask(task);
          return;
        }

        // 重新放回待处理队列. When the status write itself failed, use a
        // short recovery interval so the lease-only task is handed back to
        // the queue promptly; otherwise retain the execution backoff.
        const retryDelay = statusPersisted
          ? Math.min(10_000, 1000 * Math.pow(2, task.retries))
          : QUEUE_RECOVERY_DELAY_MS;
        this.scheduleRecovery(task, 'enqueue', retryDelay);
      } else {
        task.state = 'FAILED';
        task.completedAt = Date.now();
        task.durationMs = Date.now() - start;
        task.error = errorMsg;
        try {
          await this.persistTask(task);
        } catch (error: unknown) {
          if (isTaskLeaseLostError(error)) return;
          // Preserve the terminal state and retry only the durable update;
          // retrying the read-only operation would violate maxRetries.
          this.scheduleRecovery(task, 'persist', QUEUE_RECOVERY_DELAY_MS);
        }
      }
    } finally {
      if (leaseTimer) clearInterval(leaseTimer);
      this.activeControllers.delete(controllerKey);
      this.activeTasksCount--;
      void Promise.all(this.allowedTenants.map((tenantId) => this.sendHeartbeat(tenantId)));
    }
  }

  private async persistTask(task: DistributedTaskRecord): Promise<void> {
    await this.adapter.updateTask(task);
  }

  private async persistCompletedTask(task: DistributedTaskRecord): Promise<void> {
    await this.persistTask(task);
    // A completed task must also advance URL de-duplication. Treat this as
    // part of completion recovery so a transient marker write cannot reopen
    // the URL after the claim TTL expires.
    if (task.state === 'COMPLETED') {
      await this.adapter.markUrlSeen(task.url, undefined, task.tenantId);
    }
  }

  private async enqueueTask(task: DistributedTaskRecord): Promise<void> {
    await this.adapter.enqueueTask(task);
  }

  /**
   * Renew halfway through the adapter lease. A failed conditional renewal is
   * authoritative: abort local execution so its eventual ACK/NACK is fenced
   * by the adapter. Transport errors are left to lease expiry, since the
   * worker cannot safely distinguish them from a temporarily unreachable
   * queue.
   */
  private startLeaseRenewal(task: DistributedTaskRecord, controller: AbortController): NodeJS.Timeout | undefined {
    if (!task.leaseId || !task.workerId) return undefined;
    const leaseDurationMs = Number.isFinite(this.adapter.leaseDurationMs) && this.adapter.leaseDurationMs > 0
      ? this.adapter.leaseDurationMs
      : 300_000;
    const intervalMs = Math.max(1, Math.floor(leaseDurationMs / 2));
    let inFlight = false;
    const timer = setInterval(() => {
      if (inFlight || controller.signal.aborted || this.shutdownFinished) return;
      inFlight = true;
      void this.adapter.renewTaskLease(task)
        .then((renewed) => {
          if (!renewed) controller.abort();
        })
        .catch(() => {
          // Let the current lease expire/fence the write when the queue is
          // temporarily unreachable; do not claim ownership locally.
        })
        .finally(() => {
          inFlight = false;
        });
    }, intervalMs);
    return timer;
  }

  private scheduleRecovery(task: DistributedTaskRecord, kind: RecoveryKind, delayMs: number): void {
    if (this.shutdownFinished) return;
    if (this.stopping) {
      // Stop owns the final drain. Keep work scheduled by an active task out
      // of the timer map so it cannot race adapter.close().
      this.lateRecoveryWork.push({ task, kind });
      return;
    }
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      this.trackRecovery({ task, kind });
    }, Math.max(QUEUE_RECOVERY_DELAY_MS, delayMs));
    this.retryTimers.set(timer, { task, kind });
  }

  private trackRecovery(work: RecoveryWork): void {
    const promise = this.runRecovery(work);
    this.recoveryPromises.add(promise);
    void promise.then(
      () => this.recoveryPromises.delete(promise),
      (error: unknown) => {
        this.recoveryPromises.delete(promise);
        // The rejection handler runs before stop() necessarily snapshots the
        // promise set. Retain failures separately so an already-settled
        // recovery cannot disappear between those two operations.
        if (this.stopping && !this.shutdownFinished) this.recoveryFailures.push(error);
      },
    );
  }

  private async runRecovery(work: RecoveryWork): Promise<void> {
    try {
      await this.flushRecovery(work);
    } catch (error: unknown) {
      if (isTaskLeaseLostError(error)) return;
      // Keep the task in local recovery storage and try again. For Redis, an
      // outstanding lease also provides a second recovery path; for the
      // in-memory adapter this timer is the only durable-in-process handoff.
      if (!this.stopping) {
        if (work.kind === 'enqueue') work.task.state = 'RETRYING';
        this.scheduleRecovery(work.task, work.kind, QUEUE_RECOVERY_DELAY_MS);
        return;
      }
      throw error;
    }
  }

  private async collectInFlightRecoveryErrors(errors: unknown[]): Promise<void> {
    const deadline = Date.now() + RECOVERY_DRAIN_TIMEOUT_MS;
    while (this.recoveryPromises.size > 0) {
      const pending = Array.from(this.recoveryPromises);
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        errors.push(new Error('Worker shutdown timed out waiting for queue recovery.'));
        return;
      }
      let timeout: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), remainingMs);
      });
      const settled = await Promise.race([
        Promise.allSettled(pending),
        timeoutPromise,
      ]);
      if (timeout) clearTimeout(timeout);
      if (settled === null) {
        errors.push(new Error('Worker shutdown timed out waiting for queue recovery.'));
        return;
      }
      for (const result of settled) {
        if (result.status === 'rejected' && !this.recoveryFailures.includes(result.reason)) {
          errors.push(result.reason);
        }
      }
      errors.push(...this.recoveryFailures.splice(0));
    }
  }

  private async flushRecoveryCollectingErrors(work: RecoveryWork, errors: unknown[]): Promise<void> {
    try {
      await this.flushRecovery(work);
    } catch (error: unknown) {
      if (!isTaskLeaseLostError(error)) errors.push(error);
    }
  }

  private async flushRecovery(work: RecoveryWork): Promise<void> {
    if (work.kind === 'enqueue') {
      work.task.state = 'PENDING';
      await this.enqueueTask(work.task);
      return;
    }
    if (work.task.state === 'COMPLETED') {
      await this.persistCompletedTask(work.task);
      return;
    }
    await this.persistTask(work.task);
  }

  private async requeueTask(task: DistributedTaskRecord): Promise<void> {
    task.state = 'PENDING';
    try {
      await this.enqueueTask(task);
    } catch (error: unknown) {
      if (isTaskLeaseLostError(error)) return;
      task.state = 'RETRYING';
      this.scheduleRecovery(task, 'enqueue', QUEUE_RECOVERY_DELAY_MS);
    }
  }
}

function boundedInteger(value: number, minimum: number, maximum: number, fallback: number): number {
  return Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, Math.floor(value)))
    : fallback;
}

function safeTaskError(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_-]{1,63}$/.test(code)) return `Task failed (${code}).`;
  }
  if (error instanceof Error && /^HTTP \d{3}\b/.test(error.message)) {
    return error.message.slice(0, 64);
  }
  return 'Task execution failed.';
}
