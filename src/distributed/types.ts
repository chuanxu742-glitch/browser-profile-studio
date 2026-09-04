import type { ExtractionSchema } from '../extractor/types.js';

export type TaskPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';
export type TaskExecutionMode = 'fetch' | 'browser';
export type TaskState = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'RETRYING' | 'CANCELLED';

export interface TaskEvent {
  at: number;
  state: TaskState;
  phase: 'queued' | 'running' | 'retrying' | 'completed' | 'failed' | 'cancelled';
  message: string;
  workerId?: string | undefined;
}

/**
 * Raised when a worker tries to mutate a task after its lease has been taken
 * over by another worker. Callers must stop retrying that local task: the
 * newer lease owner is now authoritative.
 */
export class TaskLeaseLostError extends Error {
  public readonly code = 'TASK_LEASE_LOST';

  public constructor(message = 'The task lease is no longer owned by this worker.') {
    super(message);
    this.name = 'TaskLeaseLostError';
  }
}

export function isTaskLeaseLostError(error: unknown): error is TaskLeaseLostError {
  return error instanceof TaskLeaseLostError
    || (error !== null
      && typeof error === 'object'
      && 'code' in error
      && (error as { code?: unknown }).code === 'TASK_LEASE_LOST');
}

export interface DistributedTaskDefinition {
  taskId?: string | undefined;
  /** Stable project/run labels for crawl observability and result correlation. */
  projectId?: string | undefined;
  runId?: string | undefined;
  url: string;
  mode?: TaskExecutionMode | undefined; // 'fetch' 毫秒级轻量抓取 | 'browser' 浏览器渲染抓取
  priority?: TaskPriority | undefined;
  extractionSchema?: ExtractionSchema | undefined;
  maxRetries?: number | undefined;
  timeoutMs?: number | undefined;
}

export interface DistributedTaskRecord {
  id: string;
  tenantId: string;
  projectId?: string | undefined;
  runId?: string | undefined;
  url: string;
  mode: TaskExecutionMode;
  priority: TaskPriority;
  state: TaskState;
  retries: number;
  maxRetries: number;
  workerId?: string | undefined;
  /** Fencing token assigned atomically when a worker claims the task. */
  leaseId?: string | undefined;
  sessionId?: string | undefined;
  extractionSchema?: ExtractionSchema | undefined;
  timeoutMs: number;
  createdAt: number;
  startedAt?: number | undefined;
  completedAt?: number | undefined;
  result?: unknown | undefined;
  error?: string | undefined;
  errorCode?: string | undefined;
  durationMs?: number | undefined;
  events?: TaskEvent[] | undefined;
}

export interface TaskListFilter {
  projectId?: string | undefined;
  runId?: string | undefined;
  state?: TaskState | undefined;
  mode?: TaskExecutionMode | undefined;
  priority?: TaskPriority | undefined;
  createdAfter?: number | undefined;
  createdBefore?: number | undefined;
}
export interface TaskUrlPreflight {
  allowed: boolean;
  origin?: string | undefined;
  policy: 'allow' | 'deny' | 'unavailable';
  reason: string;
}


export interface WorkerNodeInfo {
  workerId: string;
  tenantId: string;
  hostname: string;
  capacity: number; // 最大并发会话/任务数
  activeTasks: number;
  healthy: boolean;
  lastHeartbeat: number;
}

export interface ClusterStatus {
  totalWorkers: number;
  healthyWorkers: number;
  totalCapacity: number;
  activeTasks: number;
  queuedTasks: number;
  completedTasks: number;
  failedTasks: number;
}
