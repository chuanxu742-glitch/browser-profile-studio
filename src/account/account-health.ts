export enum AccountHealthState {
  HEALTHY = 'HEALTHY',
  LOGIN_EXPIRED = 'LOGIN_EXPIRED',
  CHALLENGE_REQUIRED = 'CHALLENGE_REQUIRED',
  PROXY_UNHEALTHY = 'PROXY_UNHEALTHY',
  QUARANTINED = 'QUARANTINED',
  DISABLED = 'DISABLED',
}

export interface AccountHealthSnapshot {
  readonly state: AccountHealthState;
  readonly reason: string | null;
  readonly lastUpdated: number;
  readonly failureCount: number;
  readonly nextRetryAvailableAt: number | null;
}

export type Clock = () => number;

const VALID_TRANSITIONS: Record<AccountHealthState, Partial<Record<AccountHealthState, true>>> = {
  [AccountHealthState.HEALTHY]: {
    [AccountHealthState.LOGIN_EXPIRED]: true,
    [AccountHealthState.CHALLENGE_REQUIRED]: true,
    [AccountHealthState.PROXY_UNHEALTHY]: true,
    [AccountHealthState.QUARANTINED]: true,
    [AccountHealthState.DISABLED]: true,
  },
  [AccountHealthState.LOGIN_EXPIRED]: {
    [AccountHealthState.HEALTHY]: true,
    [AccountHealthState.CHALLENGE_REQUIRED]: true,
    [AccountHealthState.PROXY_UNHEALTHY]: true,
    [AccountHealthState.QUARANTINED]: true,
    [AccountHealthState.DISABLED]: true,
  },
  [AccountHealthState.CHALLENGE_REQUIRED]: {
    [AccountHealthState.HEALTHY]: true,
    [AccountHealthState.LOGIN_EXPIRED]: true,
    [AccountHealthState.PROXY_UNHEALTHY]: true,
    [AccountHealthState.QUARANTINED]: true,
    [AccountHealthState.DISABLED]: true,
  },
  [AccountHealthState.PROXY_UNHEALTHY]: {
    [AccountHealthState.HEALTHY]: true,
    [AccountHealthState.LOGIN_EXPIRED]: true,
    [AccountHealthState.CHALLENGE_REQUIRED]: true,
    [AccountHealthState.QUARANTINED]: true,
    [AccountHealthState.DISABLED]: true,
  },
  [AccountHealthState.QUARANTINED]: {
    [AccountHealthState.HEALTHY]: true,
    [AccountHealthState.DISABLED]: true,
  },
  [AccountHealthState.DISABLED]: {
    [AccountHealthState.HEALTHY]: true,
  },
};

export class InvalidStateTransitionError extends Error {
  constructor(public readonly from: AccountHealthState, public readonly to: AccountHealthState) {
    super(`Invalid account health state transition from ${from} to ${to}`);
    this.name = 'InvalidStateTransitionError';
  }
}

const MAX_REASON_LENGTH = 1_024;
const BASE_RETRY_DELAY_MS = 5 * 60_000;
const MAX_RETRY_DELAY_MS = 24 * 60 * 60_000;

function validatedReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined;
  if (typeof reason !== 'string' || reason.length > MAX_REASON_LENGTH) {
    throw new Error(`Account health reason must be at most ${MAX_REASON_LENGTH} characters`);
  }
  return reason;
}

function validatedTimestamp(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a nonnegative safe integer`);
  }
  return value;
}

function isAccountHealthState(value: unknown): value is AccountHealthState {
  return Object.values(AccountHealthState).includes(value as AccountHealthState);
}


export class AccountHealth {
  private state: AccountHealthState;
  private reason: string | null;
  private lastUpdated: number;
  private failureCount: number;
  private nextRetryAvailableAt: number | null;
  private readonly clock: Clock;

  constructor(clock: Clock = Date.now, initialSnapshot?: Partial<AccountHealthSnapshot>) {
    this.clock = clock;
    const state = initialSnapshot?.state ?? AccountHealthState.HEALTHY;
    if (!isAccountHealthState(state)) throw new Error('Invalid account health state');
    const failureCount = initialSnapshot?.failureCount ?? 0;
    if (!Number.isSafeInteger(failureCount) || failureCount < 0) {
      throw new Error('Account health failureCount must be a nonnegative safe integer');
    }
    const nextRetryAvailableAt = initialSnapshot?.nextRetryAvailableAt ?? null;
    if (nextRetryAvailableAt !== null) validatedTimestamp(nextRetryAvailableAt, 'Account health nextRetryAvailableAt');
    if (
      (state === AccountHealthState.HEALTHY && (failureCount !== 0 || nextRetryAvailableAt !== null))
      || ((state === AccountHealthState.QUARANTINED || state === AccountHealthState.DISABLED) && nextRetryAvailableAt !== null)
    ) {
      throw new Error('Account health snapshot violates state invariants');
    }
    this.state = state;
    this.reason = validatedReason(initialSnapshot?.reason ?? undefined) ?? null;
    this.lastUpdated = validatedTimestamp(initialSnapshot?.lastUpdated ?? this.currentTime(), 'Account health lastUpdated');
    this.failureCount = failureCount;
    this.nextRetryAvailableAt = nextRetryAvailableAt;
  }

  public getSnapshot(): AccountHealthSnapshot {
    return Object.freeze({
      state: this.state,
      reason: this.reason,
      lastUpdated: this.lastUpdated,
      failureCount: this.failureCount,
      nextRetryAvailableAt: this.nextRetryAvailableAt,
    });
  }

  public isRetryEligible(): boolean {
    if (this.state === AccountHealthState.HEALTHY) {
      return true;
    }
    if (this.state === AccountHealthState.DISABLED || this.state === AccountHealthState.QUARANTINED) {
      return false;
    }
    if (this.nextRetryAvailableAt !== null) {
      return this.clock() >= this.nextRetryAvailableAt;
    }
    return true;
  }

  public recordFailure(newState: AccountHealthState, reason?: string): void {
    if (
      newState === AccountHealthState.HEALTHY ||
      newState === AccountHealthState.DISABLED ||
      newState === AccountHealthState.QUARANTINED
    ) {
      throw new Error(`recordFailure cannot be used to transition to ${newState}`);
    }
    this.applyTransition(newState, reason, true);
  }

  public quarantine(reason?: string): void {
    this.applyTransition(AccountHealthState.QUARANTINED, reason, false);
  }

  public disable(reason?: string): void {
    this.applyTransition(AccountHealthState.DISABLED, reason, false);
  }

  public recover(reason?: string): void {
    this.applyTransition(AccountHealthState.HEALTHY, reason, false);
  }

  private applyTransition(newState: AccountHealthState, reason?: string, isFailure: boolean = false): void {
    const normalizedReason = validatedReason(reason);
    const now = this.currentTime();
    if (this.state === newState) {
      if (isFailure) this.recordBackoff(now);
      if (normalizedReason !== undefined) this.reason = normalizedReason;
      this.lastUpdated = now;
      return;
    }

    if (!VALID_TRANSITIONS[this.state][newState]) {
      throw new InvalidStateTransitionError(this.state, newState);
    }

    this.state = newState;
    this.reason = normalizedReason ?? null;
    this.lastUpdated = now;

    if (newState === AccountHealthState.HEALTHY) {
      this.failureCount = 0;
      this.nextRetryAvailableAt = null;
    } else if (isFailure) {
      this.recordBackoff(now);
    } else if (newState === AccountHealthState.DISABLED || newState === AccountHealthState.QUARANTINED) {
      this.nextRetryAvailableAt = null;
    }
  }

  private currentTime(): number {
    return validatedTimestamp(this.clock(), 'Account health clock');
  }

  private recordBackoff(now: number): void {
    this.failureCount += 1;
    const exponent = Math.min(this.failureCount - 1, 30);
    this.nextRetryAvailableAt = now + Math.min(BASE_RETRY_DELAY_MS * (2 ** exponent), MAX_RETRY_DELAY_MS);
  }
}
