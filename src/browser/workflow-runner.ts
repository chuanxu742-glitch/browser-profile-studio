import {
  DEFAULT_WORKFLOW_DURATION_MS,
  DEFAULT_WORKFLOW_RESULT_BYTES,
  DEFAULT_WORKFLOW_STEPS,
  MAX_WORKFLOW_DURATION_MS,
  MAX_WORKFLOW_RESULT_BYTES,
  WorkflowExecutor,
  resolveWorkflowLimits,
} from './workflow.js';
import type {
  WorkflowAdapter,
  WorkflowDefinition,
  WorkflowExecutionOptions,
  WorkflowLimits,
  WorkflowResult,
  WorkflowStep,
  WorkflowStopReason,
  WorkflowStopTrigger,
} from './workflow.js';

export const WORKFLOW_STEP_LIMIT = DEFAULT_WORKFLOW_STEPS;
export const WORKFLOW_TIME_LIMIT_MS = DEFAULT_WORKFLOW_DURATION_MS;

export interface WorkflowRunnerOptions {
  now?: () => number;
  maxSnapshotBytes?: number;
  limits?: WorkflowLimits;
}

export interface WorkflowRunnerRunOptions extends WorkflowExecutionOptions {
  stopOn?: readonly WorkflowStopTrigger[];
}

export interface WorkflowRunnerResult extends WorkflowResult {
  /** A bounded observation captured after an interrupt or error stop. */
  snapshot?: unknown;
  /** Stable alias for clients that prefer an explicit stopped field. */
  stoppedReason?: WorkflowStopReason;
}

/**
 * Public entry point for serial, finite workflows. The executor owns input
 * validation, idempotency, step/deadline enforcement, and stop conditions;
 * this facade adds the one post-stop observation required by the MCP contract.
 */
export class WorkflowRunner {
  private readonly executor: WorkflowExecutor;
  private readonly adapter: WorkflowAdapter;
  private readonly now: () => number;
  private readonly limits: WorkflowLimits;
  private readonly maxSnapshotBytes: number;

  public constructor(adapter: WorkflowAdapter, options: WorkflowRunnerOptions = {}) {
    this.adapter = adapter;
    this.limits = resolveWorkflowLimits(options.limits);
    this.executor = new WorkflowExecutor(adapter, {
      ...(options.now !== undefined ? { now: options.now } : {}),
      limits: this.limits,
    });
    this.now = options.now ?? Date.now;
    this.maxSnapshotBytes = boundedInteger(options.maxSnapshotBytes, 500, this.limits.maxSnapshotBytes, this.limits.maxSnapshotBytes);
  }

  public async run(
    workflowOrSteps: WorkflowDefinition | readonly WorkflowStep[],
    options: WorkflowRunnerRunOptions = {},
  ): Promise<WorkflowRunnerResult> {
    const workflow: WorkflowDefinition = Array.isArray(workflowOrSteps)
      ? { steps: workflowOrSteps, ...(options.stopOn !== undefined ? { stopOn: options.stopOn } : {}) }
      : (() => {
        const definition = workflowOrSteps as WorkflowDefinition;
        return {
          ...definition,
          ...(options.stopOn !== undefined ? { stopOn: options.stopOn } : {}),
        };
      })();
    const startedAt = this.now();
    const result = await this.executor.run(workflow, options);
    if (result.status !== 'stopped') return result;

    const output: WorkflowRunnerResult = {
      ...result,
      stoppedReason: result.stopReason,
    };
    const budgetMs = options.maxDurationMs ?? workflow.maxDurationMs ?? this.limits.maxDurationMs;
    const remainingMs = Math.max(0, Math.min(this.limits.maxDurationMs, budgetMs) - (this.now() - startedAt));
    const adapter = this.adapter;
    if (!adapter?.snapshot) return output;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(undefined);
      }, remainingMs);
    });
    try {
      const snapshot = await Promise.race([
        adapter.snapshot({ maxBytes: this.maxSnapshotBytes, signal: controller.signal }),
        timeout,
      ]);
      if (snapshot !== undefined) output.snapshot = snapshot;
    } catch {
      // A stop result is still useful when the page cannot produce a final
      // observation before the single workflow deadline expires.
    } finally {
      clearTimeout(timer);
    }
    return output;
  }

  public execute(
    workflowOrSteps: WorkflowDefinition | readonly WorkflowStep[],
    options: WorkflowRunnerRunOptions = {},
  ): Promise<WorkflowRunnerResult> {
    return this.run(workflowOrSteps, options);
  }

  public clearCache(): void {
    this.executor.clearCache();
  }
}

function boundedInteger(value: number | undefined, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined || !Number.isSafeInteger(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, value));
}

export {
  DEFAULT_WORKFLOW_DURATION_MS,
  DEFAULT_WORKFLOW_RESULT_BYTES,
  MAX_WORKFLOW_DURATION_MS,
  MAX_WORKFLOW_RESULT_BYTES,
};

export type { WorkflowAdapter, WorkflowDefinition, WorkflowExecutionOptions, WorkflowLimits, WorkflowResult, WorkflowStep, WorkflowStopReason, WorkflowStopTrigger };

export default WorkflowRunner;
