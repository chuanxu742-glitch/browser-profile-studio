import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AccountHealth, AccountHealthState, InvalidStateTransitionError } from '../../src/account/account-health.js';

describe('AccountHealth', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1000000000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const getClock = () => Date.now();

  it('initializes with HEALTHY state by default', () => {
    const health = new AccountHealth(getClock);
    expect(health.getSnapshot().state).toBe(AccountHealthState.HEALTHY);
    expect(health.isRetryEligible()).toBe(true);
  });

  it('allows restoring from snapshot', () => {
    const health = new AccountHealth(getClock, {
      state: AccountHealthState.LOGIN_EXPIRED,
      failureCount: 2,
      nextRetryAvailableAt: 1000000000 + 600000,
    });
    const snap = health.getSnapshot();
    expect(snap.state).toBe(AccountHealthState.LOGIN_EXPIRED);
    expect(snap.failureCount).toBe(2);
    expect(snap.nextRetryAvailableAt).toBe(1000000000 + 600000);
  });

  it('provides immutable snapshots', () => {
    const health = new AccountHealth(getClock);
    const snap = health.getSnapshot();
    
    // @ts-expect-error testing immutability
    expect(() => { snap.state = AccountHealthState.DISABLED; }).toThrow();
    
    health.quarantine();
    expect(snap.state).toBe(AccountHealthState.HEALTHY);
    expect(health.getSnapshot().state).toBe(AccountHealthState.QUARANTINED);
  });

  describe('legal transitions', () => {
    it('transitions to LOGIN_EXPIRED on failure', () => {
      const health = new AccountHealth(getClock);
      health.recordFailure(AccountHealthState.LOGIN_EXPIRED, 'session invalid');
      const snap = health.getSnapshot();
      expect(snap.state).toBe(AccountHealthState.LOGIN_EXPIRED);
      expect(snap.reason).toBe('session invalid');
      expect(snap.failureCount).toBe(1);
    });

    it('can quarantine an account from any state', () => {
      const health = new AccountHealth(getClock);
      health.recordFailure(AccountHealthState.LOGIN_EXPIRED);
      health.quarantine('bot detected');
      expect(health.getSnapshot().state).toBe(AccountHealthState.QUARANTINED);
      expect(health.isRetryEligible()).toBe(false);
    });

    it('can disable an account from quarantine', () => {
      const health = new AccountHealth(getClock);
      health.quarantine();
      health.disable('admin action');
      expect(health.getSnapshot().state).toBe(AccountHealthState.DISABLED);
    });
  });

  describe('illegal transitions', () => {
    it('prevents transition from QUARANTINED to LOGIN_EXPIRED', () => {
      const health = new AccountHealth(getClock);
      health.quarantine();
      expect(() => health.recordFailure(AccountHealthState.LOGIN_EXPIRED)).toThrow(InvalidStateTransitionError);
    });

    it('prevents transition from DISABLED to QUARANTINED', () => {
      const health = new AccountHealth(getClock);
      health.disable();
      expect(() => health.quarantine()).toThrow(InvalidStateTransitionError);
    });

    it('prevents using recordFailure to transition to HEALTHY', () => {
      const health = new AccountHealth(getClock);
      expect(() => health.recordFailure(AccountHealthState.HEALTHY)).toThrow('recordFailure cannot be used to transition to HEALTHY');
    });
  });

  describe('backoff and retry eligibility', () => {
    it('applies exponential backoff on repeated failures', () => {
      const health = new AccountHealth(getClock);
      
      health.recordFailure(AccountHealthState.LOGIN_EXPIRED);
      expect(health.getSnapshot().failureCount).toBe(1);
      expect(health.isRetryEligible()).toBe(false); // 5 mins backoff
      
      vi.advanceTimersByTime(5 * 60 * 1000);
      expect(health.isRetryEligible()).toBe(true);

      health.recordFailure(AccountHealthState.PROXY_UNHEALTHY);
      expect(health.getSnapshot().failureCount).toBe(2);
      expect(health.isRetryEligible()).toBe(false); // 10 mins backoff

      vi.advanceTimersByTime(10 * 60 * 1000);
      expect(health.isRetryEligible()).toBe(true);
    });

    it('caps backoff at 24 hours', () => {
      const health = new AccountHealth(getClock);
      for (let i = 0; i < 20; i++) {
        health.recordFailure(AccountHealthState.CHALLENGE_REQUIRED);
      }
      const snap = health.getSnapshot();
      expect(snap.nextRetryAvailableAt).toBe(Date.now() + 24 * 60 * 60 * 1000);
    });
  });

  describe('recovery', () => {
    it('recovers from error state, resetting failures', () => {
      const health = new AccountHealth(getClock);
      health.recordFailure(AccountHealthState.LOGIN_EXPIRED);
      health.recordFailure(AccountHealthState.LOGIN_EXPIRED);
      
      expect(health.getSnapshot().failureCount).toBe(2);
      
      health.recover('re-login successful');
      const snap = health.getSnapshot();
      
      expect(snap.state).toBe(AccountHealthState.HEALTHY);
      expect(snap.failureCount).toBe(0);
      expect(snap.nextRetryAvailableAt).toBe(null);
      expect(health.isRetryEligible()).toBe(true);
    });

    it('recovers from quarantine', () => {
      const health = new AccountHealth(getClock);
      health.quarantine();
      health.recover('admin review');
      expect(health.getSnapshot().state).toBe(AccountHealthState.HEALTHY);
    });

    it('recovers from disabled', () => {
      const health = new AccountHealth(getClock);
      health.disable();
      health.recover('admin review');
      expect(health.getSnapshot().state).toBe(AccountHealthState.HEALTHY);
    });
  });
});
