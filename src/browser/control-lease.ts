import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { BrowserToolError } from '../domain.js';

/**
 * The only actors that may change control ownership.  `system` is reserved
 * for a trusted server-side recovery path; it is never accepted by the
 * user-facing takeover/release methods below.
 */
export type ControlLeaseActor = 'agent' | 'user' | 'system';

/** A small, wire-friendly vocabulary for the control plane state. */
export type ControlOwner = 'agent' | 'user' | 'none';
export type ControlState = 'AGENT_CONTROLLED' | 'USER_CONTROLLED' | 'INACTIVE';
export type HandoffState = 'NONE' | 'PENDING' | 'ACTIVE' | 'RELEASED' | 'EXPIRED' | 'USER_ACTIVE';

/**
 * Keep these errors in the existing public vocabulary.  The manager throws a
 * BrowserToolError subclass so MCP callers can map it without knowing this
 * module's implementation details.
 */
export type ControlLeaseErrorCode =
  | 'MANUAL_TAKEOVER_ACTIVE'
  | 'HUMAN_HANDOFF_EXPIRED'
  | 'INVALID_STATE'
  | 'INVALID_ARGUMENT';

export class ControlLeaseError extends BrowserToolError {
  public constructor(
    code: ControlLeaseErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(code, message, {
      details,
      retryable: false,
    });
    this.name = 'ControlLeaseError';
  }
}

/** Injectable wall-clock and timer primitives for deterministic tests. */
export interface ControlLeaseClock {
  now?: () => number;
  setTimeout?: (handler: () => void, timeoutMs: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

/**
 * A random source may return bytes (the recommended form) or an already
 * encoded token.  The production default is 256 bits from node:crypto;
 * callers injecting a source are responsible for preserving that entropy.
 */
export type ControlLeaseRandom = (byteLength: number) => Uint8Array | string;

export interface ControlLeaseManagerOptions {
  /** Default lease duration. Five minutes mirrors the server architecture. */
  ttlMs?: number;
  /** Optional server hard cap for per-handoff TTL overrides. */
  maxTtlMs?: number;
  /** Injectable wall-clock/timer primitives. */
  clock?: ControlLeaseClock;
  /** Convenience alias for a clock with only a now function. */
  now?: () => number;
  /** Injectable token source, useful for deterministic tests. */
  randomToken?: ControlLeaseRandom;
  /** Alias accepted by embedders that call the source simply `random`. */
  random?: ControlLeaseRandom;
  /** Number of bytes requested from the default random source. */
  tokenBytes?: number;
}

export interface HandoffRequest {
  /** Handoff is initiated by the agent; user takeover is a separate step. */
  actor?: ControlLeaseActor;
  reason?: string;
  /** Optional per-handoff duration, bounded by maxTtlMs. */
  ttlMs?: number;
}

export interface TakeoverRequest {
  /** Must be `user`; an agent cannot self-authorize takeover. */
  actor?: ControlLeaseActor;
  leaseToken: string;
  /** Must be literally true, not merely truthy. */
  userConfirmed: boolean;
}

export interface ReleaseRequest {
  /** Must be `user`; returning control is an explicit user action. */
  actor?: ControlLeaseActor;
  leaseToken: string;
  /** Must be literally true, not merely truthy. */
  userConfirmed: boolean;
}

export interface ResumeRequest {
  /** Only the agent may resume after an explicit user release. */
  actor?: ControlLeaseActor;
}

export interface ExpiredRecoveryRequest {
  /** Recovery is a user authorization event, never an agent shortcut. */
  actor?: ControlLeaseActor;
  userConfirmed: boolean;
}

/**
 * Public state.  No token, digest, or token-derived value is included here.
 * `leaseToken` exists only on the one-time HandoffGrant returned by handoff.
 */
export interface ControlLeaseStatus {
  /** Alias of `controlState` for callers that use a generic state field. */
  state: ControlState;
  controlState: ControlState;
  owner: ControlOwner;
  /** Alias retained for consumers that call this the lease state. */
  handoffState: HandoffState;
  leaseState: HandoffState;
  phase: HandoffState;
  /** True whenever an agent write must stop at the control boundary. */
  hardStop: boolean;
  agentWriteAllowed: boolean;
  /** Indicates active user control; token validation is still required. */
  userControlActive: boolean;
  leaseActive: boolean;
  hasActiveLease: boolean;
  issuedAt?: number;
  activatedAt?: number;
  expiresAt?: number;
  releasedAt?: number;
  expiredAt?: number;
}

/** Returned from handoff exactly once; status() never contains leaseToken. */
export interface HandoffGrant extends ControlLeaseStatus {
  leaseToken: string;
}

interface LeaseRecord {
  generation: number;
  digest: Buffer;
  issuedAt: number;
  expiresAt: number;
  activatedAt?: number;
}

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_TTL_MS = 60 * 60_000;
const DEFAULT_TOKEN_BYTES = 32;
const MIN_TOKEN_BYTES = 16;
const MAX_TOKEN_BYTES = 128;
const MAX_REASON_LENGTH = 200;

/**
 * Process-local control ownership and human handoff state machine.
 *
 * A handoff is deliberately two-phase:
 *
 *   AGENT_CONTROLLED -> (handoff) INACTIVE/PENDING
 *   INACTIVE/PENDING -> (user confirmed token) USER_CONTROLLED/ACTIVE
 *   USER_CONTROLLED/ACTIVE -> (user confirmed token) INACTIVE/RELEASED
 *   INACTIVE/RELEASED -> (agent resume) AGENT_CONTROLLED/NONE
 *
 * Pending, active, released and expired states are all hard stops for agent
 * writes.  There is no method that lets an agent reclaim active control.  It
 * can resume only after the user has explicitly released (or recovered) the
 * handoff.
 */
export class ControlLeaseManager {
  private readonly ttlMs: number;
  private readonly maxTtlMs: number;
  private readonly tokenBytes: number;
  private readonly now: () => number;
  private readonly scheduleTimer: (handler: () => void, timeoutMs: number) => unknown;
  private readonly cancelTimer: (handle: unknown) => void;
  private readonly randomToken: ControlLeaseRandom;

  private controlState: ControlState = 'AGENT_CONTROLLED';
  private handoffState: HandoffState = 'NONE';
  private owner: ControlOwner = 'agent';
  private currentLease: LeaseRecord | undefined;
  private expiryTimer: unknown;
  private nextGeneration = 0;
  private releasedAt: number | undefined;
  private expiredAt: number | undefined;
  // Retain only non-sensitive timestamps after a lease is consumed/expired;
  // the digest itself is cleared and the active lease record is dropped when
  // control is released. Expired records retain a zeroed digest solely so
  // status can expose safe expiry timestamps.
  private lastIssuedAt: number | undefined;
  private lastActivatedAt: number | undefined;
  private lastExpiresAt: number | undefined;

  public constructor(options: ControlLeaseManagerOptions = {}) {
    this.maxTtlMs = validateDuration(options.maxTtlMs ?? DEFAULT_MAX_TTL_MS, 'maxTtlMs');
    this.ttlMs = validateDuration(options.ttlMs ?? DEFAULT_TTL_MS, 'ttlMs');
    if (this.ttlMs > this.maxTtlMs) {
      throw invalidArgument('ttlMs must not exceed maxTtlMs', 'ttlMs');
    }

    this.tokenBytes = validateTokenBytes(options.tokenBytes ?? DEFAULT_TOKEN_BYTES);
    this.now = options.clock?.now ?? options.now ?? (() => Date.now());
    this.scheduleTimer = options.clock?.setTimeout ?? ((handler, timeoutMs) => setTimeout(handler, timeoutMs));
    this.cancelTimer = options.clock?.clearTimeout ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    this.randomToken = options.randomToken ?? options.random ?? ((byteLength) => randomBytes(byteLength));

    // Fail early for a broken injected clock rather than creating a lease that
    // can never expire deterministically.
    this.readNow();
  }

  /** Current state; expiry is checked lazily as well as by the timer. */
  public status(): ControlLeaseStatus {
    this.expireIfDue();
    return this.statusUnsafe();
  }

  public getStatus(): ControlLeaseStatus {
    return this.status();
  }

  /**
   * Create a pending human handoff and return its token once.  The token is
   * never retained in memory after hashing and is absent from status/errors.
   */
  public handoff(options: HandoffRequest = {}): HandoffGrant {
    return this.requestHandoff(options);
  }

  public requestHandoff(options: HandoffRequest = {}): HandoffGrant {
    assertObject(options, 'handoff request');
    this.expireIfDue();
    const actor = normalizeActor(options.actor, 'agent');
    if (actor !== 'agent') {
      throw invalidState('Only the agent may initiate a handoff.');
    }
    validateReason(options.reason);

    if (this.handoffState === 'ACTIVE' || this.controlState === 'USER_CONTROLLED') {
      throw new ControlLeaseError('MANUAL_TAKEOVER_ACTIVE', 'Manual takeover is active.');
    }
    if (this.handoffState === 'PENDING') {
      // Do not return a second copy of the token.  A caller that lost the
      // one-time result must restart the trusted user flow instead of asking
      // the service to reveal it from storage.
      throw invalidState('A human handoff is already pending.');
    }
    if (this.handoffState === 'RELEASED') {
      throw invalidState('The handoff was released; resume agent control first.');
    }

    const ttlMs = validateDuration(options.ttlMs ?? this.ttlMs, 'ttlMs');
    if (ttlMs > this.maxTtlMs) {
      throw invalidArgument('ttlMs must not exceed maxTtlMs', 'ttlMs');
    }

    const issuedAt = this.readNow();
    const token = this.issueToken();
    const generation = ++this.nextGeneration;
    const expiresAt = issuedAt + ttlMs;
    this.currentLease = {
      generation,
      digest: token.digest,
      issuedAt,
      expiresAt,
    };
    this.lastIssuedAt = issuedAt;
    this.lastActivatedAt = undefined;
    this.lastExpiresAt = expiresAt;
    this.controlState = 'INACTIVE';
    this.owner = 'none';
    this.handoffState = 'PENDING';
    this.releasedAt = undefined;
    this.expiredAt = undefined;
    this.scheduleExpiry(generation, ttlMs);

    // Spread a snapshot before adding the raw token so status cannot retain it
    // by reference or accidentally expose it from a later status call.
    return {
      ...this.statusUnsafe(),
      leaseToken: token.value,
    };
  }

  public createHandoff(options: HandoffRequest = {}): HandoffGrant {
    return this.requestHandoff(options);
  }

  /** Claim a pending handoff; userConfirmed must be exactly true. */
  public takeover(request: TakeoverRequest): ControlLeaseStatus;
  public takeover(leaseToken: string, userConfirmed: boolean): ControlLeaseStatus;
  public takeover(
    requestOrToken: TakeoverRequest | string,
    positionalConfirmation?: boolean,
  ): ControlLeaseStatus {
    const request = normalizeTokenRequest(requestOrToken, positionalConfirmation);
    this.expireIfDue();
    const actor = normalizeActor(request.actor, 'user');
    this.assertUserConfirmation(request.userConfirmed);
    if (actor !== 'user') {
      throw invalidState('Only a confirmed user may take over control.');
    }

    if (this.handoffState === 'EXPIRED') throw expiredError();
    if (this.handoffState === 'NONE') throw invalidState('No human handoff is pending.');
    if (this.handoffState === 'RELEASED') throw invalidState('The handoff was already released.');
    if (this.handoffState === 'ACTIVE') {
      // Safe retry for the same user action.  A different token still cannot
      // dislodge the active user and receives the hard-stop code.
      if (this.matchesToken(request.leaseToken)) return this.statusUnsafe();
      throw new ControlLeaseError('MANUAL_TAKEOVER_ACTIVE', 'Manual takeover is active.');
    }
    this.assertToken(request.leaseToken);

    const activatedAt = this.readNow();
    if (!this.currentLease) throw invalidState('The handoff lease is unavailable.');
    this.currentLease.activatedAt = activatedAt;
    this.lastActivatedAt = activatedAt;
    this.controlState = 'USER_CONTROLLED';
    this.owner = 'user';
    this.handoffState = 'ACTIVE';
    return this.statusUnsafe();
  }

  public confirmTakeover(request: TakeoverRequest): ControlLeaseStatus;
  public confirmTakeover(leaseToken: string, userConfirmed: boolean): ControlLeaseStatus;
  public confirmTakeover(
    requestOrToken: TakeoverRequest | string,
    positionalConfirmation?: boolean,
  ): ControlLeaseStatus {
    return typeof requestOrToken === 'string'
      ? this.takeover(requestOrToken, positionalConfirmation ?? false)
      : this.takeover(requestOrToken);
  }

  /**
   * Explicitly return control from a user.  Release does not immediately
   * permit writes: the agent must make a separate resume call, matching the
   * architecture's paused-after-operator-release rule.
   */
  public release(request: ReleaseRequest): ControlLeaseStatus;
  public release(leaseToken: string, userConfirmed: boolean): ControlLeaseStatus;
  public release(
    requestOrToken: ReleaseRequest | string,
    positionalConfirmation?: boolean,
  ): ControlLeaseStatus {
    const request = normalizeTokenRequest(requestOrToken, positionalConfirmation);
    this.expireIfDue();
    const actor = normalizeActor(request.actor, 'user');
    this.assertUserConfirmation(request.userConfirmed);
    if (actor !== 'user') {
      throw invalidState('Only a confirmed user may release control.');
    }
    if (this.handoffState === 'EXPIRED') throw expiredError();
    if (this.handoffState !== 'ACTIVE') {
      throw invalidState('User control is not active.');
    }
    this.assertToken(request.leaseToken);

    this.clearExpiryTimer();
    this.clearDigest();
    this.currentLease = undefined;
    this.controlState = 'INACTIVE';
    this.owner = 'none';
    this.handoffState = 'RELEASED';
    this.releasedAt = this.readNow();
    this.expiredAt = undefined;
    return this.statusUnsafe();
  }

  /** Resume only after a confirmed user release/recovery. */
  public resume(request: ResumeRequest = {}): ControlLeaseStatus {
    assertObject(request, 'resume request');
    this.expireIfDue();
    const actor = normalizeActor(request.actor, 'agent');
    if (actor !== 'agent') throw invalidState('Only the agent may resume control.');
    if (this.handoffState === 'ACTIVE' || this.controlState === 'USER_CONTROLLED') {
      throw new ControlLeaseError('MANUAL_TAKEOVER_ACTIVE', 'Manual takeover is active.');
    }
    if (this.handoffState === 'EXPIRED') throw expiredError();
    if (this.handoffState === 'PENDING') throw invalidState('The user has not released the pending handoff.');
    if (this.handoffState === 'NONE') {
      // Idempotent when already agent controlled.  This is not a reclaim path:
      // the state has never left the agent or has already been resumed.
      if (this.controlState === 'AGENT_CONTROLLED') return this.statusUnsafe();
      throw invalidState('Agent control is unavailable.');
    }
    if (this.handoffState !== 'RELEASED') throw invalidState('The handoff cannot be resumed from its current state.');

    this.controlState = 'AGENT_CONTROLLED';
    this.owner = 'agent';
    this.handoffState = 'NONE';
    this.releasedAt = undefined;
    this.expiredAt = undefined;
    return this.statusUnsafe();
  }

  public resumeAgentControl(request: ResumeRequest = {}): ControlLeaseStatus {
    return this.resume(request);
  }

  /**
   * Recover an expired handoff only through a new explicit user authorization.
   * The recovery still lands in RELEASED/INACTIVE; the agent must resume.
   */
  public recoverExpired(request: ExpiredRecoveryRequest): ControlLeaseStatus {
    assertObject(request, 'expired recovery request');
    this.expireIfDue();
    const actor = normalizeActor(request.actor, 'user');
    this.assertUserConfirmation(request.userConfirmed);
    if (actor !== 'user') throw invalidState('Only a confirmed user may recover an expired handoff.');
    if (this.handoffState !== 'EXPIRED') throw invalidState('There is no expired handoff to recover.');

    this.controlState = 'INACTIVE';
    this.owner = 'none';
    this.handoffState = 'RELEASED';
    this.currentLease = undefined;
    this.releasedAt = this.readNow();
    this.expiredAt = undefined;
    return this.statusUnsafe();
  }

  public authorizeAgentResume(request: ExpiredRecoveryRequest): ControlLeaseStatus {
    return this.recoverExpired(request);
  }

  /** Throw unless an agent write is currently safe to perform. */
  public assertAgentControl(): void {
    this.expireIfDue();
    if (this.handoffState === 'EXPIRED') throw expiredError();
    if (this.handoffState === 'ACTIVE' || this.controlState === 'USER_CONTROLLED') {
      throw new ControlLeaseError('MANUAL_TAKEOVER_ACTIVE', 'Manual takeover is active.');
    }
    if (this.handoffState !== 'NONE' || this.controlState !== 'AGENT_CONTROLLED') {
      throw invalidState('Agent control is not active.');
    }
  }

  /** Throw unless a user with the active lease token may perform a write. */
  public assertUserControl(leaseToken: string): void {
    this.expireIfDue();
    if (this.handoffState === 'EXPIRED') throw expiredError();
    if (this.handoffState !== 'ACTIVE' || this.controlState !== 'USER_CONTROLLED') {
      throw invalidState('User control is not active.');
    }
    this.assertToken(leaseToken);
  }

  /** Generic write guard used by callers that know the actor at dispatch time. */
  public assertCanAct(actor: ControlLeaseActor, leaseToken?: string): void {
    if (actor === 'agent') {
      this.assertAgentControl();
      return;
    }
    if (actor === 'user') {
      if (leaseToken === undefined) throw invalidArgument('leaseToken is required for user control.', 'leaseToken');
      this.assertUserControl(leaseToken);
      return;
    }
    throw invalidState('The system actor cannot perform browser writes through this lease.');
  }

  public canAgentAct(): boolean {
    return this.status().agentWriteAllowed;
  }

  public canUserAct(leaseToken?: string): boolean {
    try {
      if (leaseToken === undefined) return false;
      this.assertUserControl(leaseToken);
      return true;
    } catch {
      return false;
    }
  }

  /** Hard-stop predicate suitable for orchestration before every write. */
  public isHardStop(): boolean {
    return this.status().hardStop;
  }

  /** Explicitly process due expiry; useful to drive a fake clock in tests. */
  public expireIfDue(): boolean {
    const lease = this.currentLease;
    if (!lease || (this.handoffState !== 'PENDING' && this.handoffState !== 'ACTIVE')) return false;
    if (this.readNow() < lease.expiresAt) return false;
    this.expireLease(lease.generation);
    return true;
  }

  /** Release timer resources when the owning browser session is disposed. */
  public dispose(): void {
    this.clearExpiryTimer();
    this.clearDigest();
    this.currentLease = undefined;
    this.controlState = 'INACTIVE';
    this.owner = 'none';
    this.handoffState = 'EXPIRED';
    this.expiredAt = this.readNow();
  }

  private statusUnsafe(): ControlLeaseStatus {
    const agentWriteAllowed = this.controlState === 'AGENT_CONTROLLED'
      && this.handoffState === 'NONE'
      && this.owner === 'agent';
    const userControlActive = this.controlState === 'USER_CONTROLLED'
      && this.handoffState === 'ACTIVE'
      && this.owner === 'user';
    const leaseActive = this.currentLease !== undefined
      && (this.handoffState === 'PENDING' || this.handoffState === 'ACTIVE');
    const result: ControlLeaseStatus = {
      state: this.controlState,
      controlState: this.controlState,
      owner: this.owner,
      handoffState: this.handoffState,
      leaseState: this.handoffState,
      phase: this.handoffState,
      hardStop: !agentWriteAllowed,
      agentWriteAllowed,
      userControlActive,
      leaseActive,
      hasActiveLease: leaseActive,
      ...(this.currentLease ? {
        issuedAt: this.currentLease.issuedAt,
        ...(this.currentLease.activatedAt !== undefined ? { activatedAt: this.currentLease.activatedAt } : {}),
        expiresAt: this.currentLease.expiresAt,
      } : this.handoffState === 'EXPIRED' ? {
        ...(this.lastIssuedAt !== undefined ? { issuedAt: this.lastIssuedAt } : {}),
        ...(this.lastActivatedAt !== undefined ? { activatedAt: this.lastActivatedAt } : {}),
        ...(this.lastExpiresAt !== undefined ? { expiresAt: this.lastExpiresAt } : {}),
      } : {}),
      ...(this.releasedAt !== undefined ? { releasedAt: this.releasedAt } : {}),
      ...(this.expiredAt !== undefined ? { expiredAt: this.expiredAt } : {}),
    };
    return result;
  }

  private readNow(): number {
    const value = this.now();
    if (!Number.isFinite(value)) throw invalidArgument('The injected clock returned an invalid time.', 'clock');
    return value;
  }

  private issueToken(): { value: string; digest: Buffer } {
    let generated: Uint8Array | string;
    try {
      generated = this.randomToken(this.tokenBytes);
    } catch (error) {
      throw new ControlLeaseError('INVALID_ARGUMENT', 'The injected token source failed.', { field: 'randomToken' });
    }
    const value = typeof generated === 'string'
      ? generated
      : generated instanceof Uint8Array
        ? Buffer.from(generated).toString('base64url')
        : undefined;
    if (!value || value.length < 1 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw invalidArgument('The token source returned an invalid token.', 'randomToken');
    }
    const digest = createHash('sha256').update(value, 'utf8').digest();
    return { value, digest };
  }

  private scheduleExpiry(generation: number, ttlMs: number): void {
    this.clearExpiryTimer();
    this.expiryTimer = this.scheduleTimer(() => {
      this.expireLease(generation);
    }, ttlMs);
  }

  private expireLease(generation: number): void {
    const lease = this.currentLease;
    if (!lease || lease.generation !== generation || this.handoffState === 'EXPIRED') return;
    // Timers can fire a little early on some hosts.  Lazy status checks remain
    // authoritative, so reschedule instead of expiring before expiresAt.
    const remaining = lease.expiresAt - this.readNow();
    if (remaining > 0) {
      this.expiryTimer = this.scheduleTimer(() => this.expireLease(generation), remaining);
      return;
    }
    this.clearExpiryTimer();
    this.clearDigest();
    this.controlState = 'INACTIVE';
    this.owner = 'none';
    this.handoffState = 'EXPIRED';
    this.expiredAt = this.readNow();
    this.releasedAt = undefined;
  }

  private clearExpiryTimer(): void {
    if (this.expiryTimer === undefined) return;
    this.cancelTimer(this.expiryTimer);
    this.expiryTimer = undefined;
  }

  private clearDigest(): void {
    if (this.currentLease) this.currentLease.digest.fill(0);
  }

  private matchesToken(leaseToken: string): boolean {
    const lease = this.currentLease;
    if (!lease || typeof leaseToken !== 'string' || leaseToken.length === 0) return false;
    const candidate = createHash('sha256').update(leaseToken, 'utf8').digest();
    const matches = candidate.length === lease.digest.length && timingSafeEqual(candidate, lease.digest);
    candidate.fill(0);
    return matches;
  }

  private assertToken(leaseToken: string): void {
    if (!matchesTokenShape(leaseToken)) throw invalidArgument('leaseToken is invalid.', 'leaseToken');
    if (!this.matchesToken(leaseToken)) throw invalidArgument('leaseToken is invalid.', 'leaseToken');
  }

  private assertUserConfirmation(value: boolean): void {
    if (value !== true) throw invalidArgument('userConfirmed must be true.', 'userConfirmed');
  }
}

/** Concise aliases for embedders that use controller/lease terminology. */
export { ControlLeaseManager as ControlLeaseController };
export { ControlLeaseManager as ControlLease };

function validateDuration(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0 || value > 2_147_000_000) {
    throw invalidArgument(`${field} must be a positive bounded integer.`, field);
  }
  return value;
}

function validateTokenBytes(value: number): number {
  if (!Number.isInteger(value) || value < MIN_TOKEN_BYTES || value > MAX_TOKEN_BYTES) {
    throw invalidArgument('tokenBytes is outside the supported range.', 'tokenBytes');
  }
  return value;
}

function validateReason(value: string | undefined): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || value.length > MAX_REASON_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw invalidArgument('reason is invalid.', 'reason');
  }
}

function assertObject(value: unknown, field: string): asserts value is object {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidArgument(`${field} must be an object.`, field);
  }
}

function normalizeActor(value: ControlLeaseActor | undefined, fallback: ControlLeaseActor): ControlLeaseActor {
  if (value === undefined) return fallback;
  if (value === 'agent' || value === 'user' || value === 'system') return value;
  throw invalidArgument('actor is invalid.', 'actor');
}

function normalizeTokenRequest(
  requestOrToken: TakeoverRequest | ReleaseRequest | string,
  positionalConfirmation?: boolean,
): TakeoverRequest | ReleaseRequest {
  if (typeof requestOrToken === 'string') {
    return {
      leaseToken: requestOrToken,
      userConfirmed: positionalConfirmation ?? false,
    };
  }
  if (!requestOrToken || typeof requestOrToken !== 'object') {
    throw invalidArgument('A handoff request is required.', 'request');
  }
  if (!('leaseToken' in requestOrToken)) throw invalidArgument('leaseToken is required.', 'leaseToken');
  return requestOrToken;
}

function matchesTokenShape(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
}

function invalidArgument(message: string, field?: string): ControlLeaseError {
  return new ControlLeaseError('INVALID_ARGUMENT', message, field ? { field } : undefined);
}

function invalidState(message: string): ControlLeaseError {
  return new ControlLeaseError('INVALID_STATE', message);
}

function expiredError(): ControlLeaseError {
  return new ControlLeaseError('HUMAN_HANDOFF_EXPIRED', 'The human handoff has expired.');
}
