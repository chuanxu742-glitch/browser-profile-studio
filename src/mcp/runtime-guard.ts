import { BrowserToolError } from '../domain.js';
import type { WorkspaceControlState } from '../domain.js';
export interface ToolMetricSnapshot {
  readonly calls: number;
  readonly successes: number;
  readonly failures: number;
  readonly totalDurationMs: number;
  readonly maxDurationMs: number;
}

export interface McpRuntimeGuardOptions {
  /** Sustained process-wide tool calls per second. */
  readonly ratePerSecond?: number;
  /** Maximum immediately available calls. */
  readonly burst?: number;
  readonly now?: () => number;
}

export interface RuntimeCallContext {
  readonly sessionId?: string;
  readonly toolName?: string;
  readonly write?: boolean;
  readonly controlState?: WorkspaceControlState;
  readonly sessionState?: string;
}

/**
 * A small process-local safety valve for the stdio control plane. Distributed
 * tenant quotas still belong in shared infrastructure; this guard prevents a
 * single local client from creating an unbounded request burst.
 */
export class McpRuntimeGuard {
  private readonly ratePerSecond: number;
  private readonly capacity: number;
  private readonly now: () => number;
  private tokens: number;
  private lastRefillMs: number;
  private readonly metrics = new Map<string, {
    calls: number;
    successes: number;
    failures: number;
    totalDurationMs: number;
    maxDurationMs: number;
  }>();

  public constructor(options: McpRuntimeGuardOptions = {}) {
    this.ratePerSecond = boundedNumber(options.ratePerSecond, 0.1, 1_000, 20);
    this.capacity = boundedNumber(options.burst, 1, 10_000, 40);
    this.tokens = this.capacity;
    this.now = options.now ?? (() => Date.now());
    this.lastRefillMs = this.now();
  }

  public beforeCall(context: RuntimeCallContext = {}): void {
    if (context.write && context.sessionState === 'PAUSED_CHALLENGE') {
      throw new BrowserToolError('SESSION_PAUSED_CHALLENGE', {
        details: {
          ...(context.toolName !== undefined ? { toolName: context.toolName } : {}),
        },
        ...(context.sessionId !== undefined ? { sessionId: context.sessionId } : {}),
        sessionState: 'PAUSED_CHALLENGE',
        retryable: false,
      });
    }
    if (context.write && context.controlState === 'USER_CONTROLLED') {
      throw new BrowserToolError('USER_CONTROL_HARD_STOP', {
        details: {
          ...(context.toolName !== undefined ? { toolName: context.toolName } : {}),
        },
        ...(context.sessionId !== undefined ? { sessionId: context.sessionId } : {}),
        sessionState: 'USER_CONTROLLED',
        retryable: false,
      });
    }
    const now = this.now();
    const elapsedMs = Math.max(0, now - this.lastRefillMs);
    this.tokens = Math.min(this.capacity, this.tokens + elapsedMs * this.ratePerSecond / 1_000);
    this.lastRefillMs = now;
    if (this.tokens < 1) {
      throw new BrowserToolError('RATE_LIMITED', 'The MCP control-plane request rate is limited.', {
        details: { scope: 'process' },
        retryable: true,
      });
    }
    this.tokens -= 1;
  }

  public record(toolName: string, success: boolean, durationMs: number): void {
    const current = this.metrics.get(toolName) ?? {
      calls: 0,
      successes: 0,
      failures: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
    };
    current.calls += 1;
    if (success) current.successes += 1;
    else current.failures += 1;
    const boundedDuration = Math.max(0, Math.min(86_400_000, Math.floor(durationMs)));
    current.totalDurationMs += boundedDuration;
    current.maxDurationMs = Math.max(current.maxDurationMs, boundedDuration);
    this.metrics.set(toolName, current);
  }

  public snapshot(): Readonly<Record<string, ToolMetricSnapshot>> {
    return Object.freeze(Object.fromEntries(
      [...this.metrics.entries()].map(([toolName, value]) => [toolName, Object.freeze({ ...value })]),
    ));
  }
}

function boundedNumber(value: number | undefined, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, value));
}
