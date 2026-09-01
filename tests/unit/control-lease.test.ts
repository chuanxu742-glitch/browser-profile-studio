import { describe, expect, it } from 'vitest';

import {
  ControlLeaseError,
  ControlLeaseManager,
  type ControlLeaseClock,
} from '../../src/browser/control-lease.js';

interface FakeClock {
  clock: ControlLeaseClock;
  advanceBy(milliseconds: number): void;
  pendingTimers(): number;
}

function fakeClock(start = 0): FakeClock {
  let now = start;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: ControlLeaseClock = {
    now: () => now,
    setTimeout: (callback, timeoutMs) => {
      const id = ++nextId;
      timers.set(id, { at: now + timeoutMs, callback });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };
  return {
    clock,
    advanceBy(milliseconds) {
      now += milliseconds;
      // Keep driving due callbacks until no callback is due.  This also
      // covers a timer that fired a little early and was rescheduled.
      let progressed = true;
      while (progressed) {
        progressed = false;
        for (const [id, timer] of [...timers.entries()]) {
          if (timer.at > now) continue;
          timers.delete(id);
          timer.callback();
          progressed = true;
        }
      }
    },
    pendingTimers: () => timers.size,
  };
}

function errorCode(error: unknown): unknown {
  return error instanceof ControlLeaseError ? error.code : undefined;
}

describe('ControlLeaseManager', () => {
  it('starts agent-controlled and returns a handoff token exactly once', () => {
    const timer = fakeClock();
    const manager = new ControlLeaseManager({
      ttlMs: 500,
      clock: timer.clock,
      randomToken: () => 'opaque-token-1',
    });

    expect(manager.status()).toMatchObject({
      state: 'AGENT_CONTROLLED',
      controlState: 'AGENT_CONTROLLED',
      owner: 'agent',
      handoffState: 'NONE',
      hardStop: false,
      agentWriteAllowed: true,
      leaseActive: false,
    });

    const grant = manager.handoff({ reason: 'payment requires a person' });
    expect(grant.leaseToken).toBe('opaque-token-1');
    expect(grant).toMatchObject({
      controlState: 'INACTIVE',
      owner: 'none',
      handoffState: 'PENDING',
      hardStop: true,
      expiresAt: 500,
    });
    expect(manager.status()).not.toHaveProperty('leaseToken');
    expect(JSON.stringify(manager.status())).not.toContain('opaque-token-1');

    // A lost one-time response cannot cause the service to reveal the token.
    expect(() => manager.handoff()).toThrowError(expect.objectContaining({ code: 'INVALID_STATE' }));
    expect(timer.pendingTimers()).toBe(1);
  });

  it('requires an explicit user confirmation and rejects agent self-takeover', () => {
    const manager = new ControlLeaseManager({ randomToken: () => 'opaque-token-2' });
    const { leaseToken } = manager.handoff();

    expect(() => manager.takeover({ leaseToken, userConfirmed: false })).toThrowError(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
    expect(() => manager.takeover({ actor: 'agent', leaseToken, userConfirmed: true })).toThrowError(
      expect.objectContaining({ code: 'INVALID_STATE' }),
    );
    expect(manager.status()).toMatchObject({ handoffState: 'PENDING', hardStop: true });

    expect(manager.takeover({ actor: 'user', leaseToken, userConfirmed: true })).toMatchObject({
      state: 'USER_CONTROLLED',
      controlState: 'USER_CONTROLLED',
      owner: 'user',
      handoffState: 'ACTIVE',
      hardStop: true,
      agentWriteAllowed: false,
      userControlActive: true,
    });
  });

  it('hard-stops agent writes while user control is active and validates the lease token', () => {
    const manager = new ControlLeaseManager({ randomToken: () => 'opaque-token-3' });
    const { leaseToken } = manager.handoff();
    manager.takeover(leaseToken, true);

    expect(() => manager.assertAgentControl()).toThrowError(
      expect.objectContaining({ code: 'MANUAL_TAKEOVER_ACTIVE' }),
    );
    expect(() => manager.assertCanAct('agent')).toThrowError(
      expect.objectContaining({ code: 'MANUAL_TAKEOVER_ACTIVE' }),
    );
    expect(() => manager.assertUserControl('wrong-token')).toThrowError(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
    expect(() => manager.assertCanAct('user')).toThrowError(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
    expect(manager.canAgentAct()).toBe(false);
    expect(manager.canUserAct(leaseToken)).toBe(true);
    expect(manager.canUserAct('wrong-token')).toBe(false);

    // Neither a new handoff nor resume can dislodge a live user lease.
    expect(() => manager.handoff()).toThrowError(
      expect.objectContaining({ code: 'MANUAL_TAKEOVER_ACTIVE' }),
    );
    expect(() => manager.resume()).toThrowError(
      expect.objectContaining({ code: 'MANUAL_TAKEOVER_ACTIVE' }),
    );
  });

  it('requires a confirmed user release, then a separate agent resume', () => {
    const manager = new ControlLeaseManager({ randomToken: () => 'opaque-token-4' });
    const { leaseToken } = manager.handoff();
    manager.takeover(leaseToken, true);

    expect(() => manager.release({ leaseToken, userConfirmed: false })).toThrowError(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
    expect(() => manager.release({ actor: 'agent', leaseToken, userConfirmed: true })).toThrowError(
      expect.objectContaining({ code: 'INVALID_STATE' }),
    );

    expect(manager.release({ actor: 'user', leaseToken, userConfirmed: true })).toMatchObject({
      state: 'INACTIVE',
      owner: 'none',
      handoffState: 'RELEASED',
      hardStop: true,
      agentWriteAllowed: false,
      leaseActive: false,
    });
    expect(() => manager.assertAgentControl()).toThrowError(
      expect.objectContaining({ code: 'INVALID_STATE' }),
    );

    expect(manager.resume({ actor: 'agent' })).toMatchObject({
      state: 'AGENT_CONTROLLED',
      controlState: 'AGENT_CONTROLLED',
      owner: 'agent',
      handoffState: 'NONE',
      hardStop: false,
      agentWriteAllowed: true,
    });
    // The old token cannot be replayed after release/resume.
    expect(() => manager.assertUserControl(leaseToken)).toThrowError(
      expect.objectContaining({ code: 'INVALID_STATE' }),
    );
  });

  it('expires pending and active leases, keeps the hard stop, and rejects stale tokens', () => {
    const timer = fakeClock();
    let tokenNumber = 0;
    const manager = new ControlLeaseManager({
      ttlMs: 100,
      clock: timer.clock,
      randomToken: () => `opaque-token-${++tokenNumber}`,
    });
    const pending = manager.handoff();

    timer.advanceBy(99);
    expect(manager.status()).toMatchObject({ handoffState: 'PENDING', hardStop: true });
    timer.advanceBy(1);
    expect(manager.status()).toMatchObject({
      state: 'INACTIVE',
      owner: 'none',
      handoffState: 'EXPIRED',
      hardStop: true,
      leaseActive: false,
      expiresAt: 100,
      expiredAt: 100,
    });
    expect(() => manager.takeover({ leaseToken: pending.leaseToken, userConfirmed: true })).toThrowError(
      expect.objectContaining({ code: 'HUMAN_HANDOFF_EXPIRED' }),
    );
    expect(() => manager.assertAgentControl()).toThrowError(
      expect.objectContaining({ code: 'HUMAN_HANDOFF_EXPIRED' }),
    );

    // A fresh handoff may be offered, but expiry never silently returns agent
    // control and therefore cannot be used as an unauthorized reclaim path.
    const next = manager.handoff({ ttlMs: 100 });
    manager.takeover(next.leaseToken, true);
    timer.advanceBy(100);
    expect(manager.status()).toMatchObject({ handoffState: 'EXPIRED', hardStop: true });
    expect(() => manager.resume()).toThrowError(expect.objectContaining({ code: 'HUMAN_HANDOFF_EXPIRED' }));
  });

  it('recovers an expired handoff only through explicit user authorization', () => {
    const timer = fakeClock();
    const manager = new ControlLeaseManager({ ttlMs: 50, clock: timer.clock, randomToken: () => 'opaque-token-5' });
    manager.handoff();
    timer.advanceBy(50);

    expect(() => manager.recoverExpired({ userConfirmed: false })).toThrowError(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
    expect(() => manager.recoverExpired({ actor: 'agent', userConfirmed: true })).toThrowError(
      expect.objectContaining({ code: 'INVALID_STATE' }),
    );
    expect(manager.recoverExpired({ actor: 'user', userConfirmed: true })).toMatchObject({
      handoffState: 'RELEASED',
      controlState: 'INACTIVE',
      hardStop: true,
    });
    expect(manager.resume()).toMatchObject({ controlState: 'AGENT_CONTROLLED', owner: 'agent' });
  });

  it('bounds TTL/reason/token configuration and handles malformed tokens without leaking them', () => {
    expect(() => new ControlLeaseManager({ ttlMs: 0 })).toThrowError(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
    expect(() => new ControlLeaseManager({ ttlMs: 101, maxTtlMs: 100 })).toThrowError(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
    expect(() => new ControlLeaseManager({ tokenBytes: 8 })).toThrowError(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );

    const manager = new ControlLeaseManager({ randomToken: () => 'opaque-token-6' });
    expect(() => manager.handoff({ reason: 'x'.repeat(201) })).toThrowError(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
    const { leaseToken } = manager.handoff();
    expect(() => manager.takeover({ leaseToken: '', userConfirmed: true })).toThrowError(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
    try {
      manager.takeover({ leaseToken: 'not-the-token', userConfirmed: true });
    } catch (error) {
      expect(errorCode(error)).toBe('INVALID_ARGUMENT');
      expect(JSON.stringify(error)).not.toContain('not-the-token');
    }
  });

  it('dispose clears timer state and leaves a non-writable expired stop', () => {
    const timer = fakeClock();
    const manager = new ControlLeaseManager({ ttlMs: 100, clock: timer.clock, randomToken: () => 'opaque-token-7' });
    manager.handoff();
    expect(timer.pendingTimers()).toBe(1);
    manager.dispose();
    expect(timer.pendingTimers()).toBe(0);
    expect(manager.status()).toMatchObject({ handoffState: 'EXPIRED', hardStop: true, owner: 'none' });
    expect(() => manager.assertAgentControl()).toThrowError(
      expect.objectContaining({ code: 'HUMAN_HANDOFF_EXPIRED' }),
    );
  });
});
