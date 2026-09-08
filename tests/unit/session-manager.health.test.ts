import { describe, expect, it, vi } from 'vitest';
import type { BrowserSessionOptions } from '../../src/browser/browser-session.js';
import { BrowserSession, BrowserSessionError } from '../../src/browser/browser-session.js';
import { SessionManager } from '../../src/browser/session-manager.js';
import type { AccountHealthStore } from '../../src/account/account-health-store.js';
import { AccountHealthState, type AccountHealthSnapshot } from '../../src/account/account-health.js';
import { AccountMetrics } from '../../src/operations/account-metrics.js';
import type { VersionedCheckpointStore } from '../../src/profile/versioned-checkpoint-store.js';
import type { ProfileStore } from '../../src/profile/profile-store.js';

describe('SessionManager profile lifecycle controls', () => {
  it('restores the newest checkpoint, persists with CAS, records challenge state, and clears timers', async () => {
    const clock = {
      now: () => 1_000,
      setTimeout: vi.fn().mockReturnValue(123),
      clearTimeout: vi.fn(),
    };
    const profileStore = {
      getProfile: vi.fn().mockResolvedValue({ profileId: 'p1' }),
      getCookies: vi.fn().mockResolvedValue([]),
      getStorageState: vi.fn().mockResolvedValue(undefined),
      saveCookies: vi.fn().mockResolvedValue(undefined),
      saveStorageState: vi.fn().mockResolvedValue(undefined),
    } as unknown as ProfileStore;
    const checkpointStore = {
      getLatestState: vi.fn().mockResolvedValue({ version: 2, state: { cookies: [], origins: [] } }),
      saveState: vi.fn().mockResolvedValue(3),
    } as unknown as VersionedCheckpointStore;

    const persistedHealth: { current: AccountHealthSnapshot | null } = { current: null };
    const healthStore = {
      getHealth: vi.fn().mockResolvedValue(null),
      setHealth: vi.fn(async (_profileId: string, snapshot: AccountHealthSnapshot) => {
        persistedHealth.current = snapshot;
      }),
      updateHealth: vi.fn(async (_profileId: string, update: (snapshot: AccountHealthSnapshot | null) => AccountHealthSnapshot) => {
        persistedHealth.current = update(persistedHealth.current);
        return persistedHealth.current;
      }),
    } as unknown as AccountHealthStore;
    const metrics = new AccountMetrics();
    vi.spyOn(metrics, 'increment');

    let capturedOptions: BrowserSessionOptions | undefined;
    const session = {
      sessionId: 'ses_session1',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue({ sessionId: 'ses_session1', state: 'STOPPED' }),
      status: () => ({ sessionId: 'ses_session1', state: 'STOPPED' }),
      checkpointStorageState: vi.fn().mockResolvedValue(undefined),
      state: 'READY',
    } as unknown as BrowserSession;
    const manager = new SessionManager({
      clock,
      profileStore,
      checkpointStore,
      accountHealthStore: healthStore,
      accountMetrics: metrics,
      checkpointIntervalMs: 60_000,
      sessionFactory: (options) => {
        capturedOptions = options;
        return session;
      },
      policyProfile: 'standard',
    });

    await manager.start({ profileId: 'p1' });

    expect(checkpointStore.getLatestState).toHaveBeenCalledWith('p1');
    expect(capturedOptions?.initialStorageState).toEqual({ cookies: [], origins: [] });
    expect(metrics.increment).toHaveBeenCalledWith('login_restore', {});
    expect(metrics.increment).toHaveBeenCalledWith('starts', {});
    expect(clock.setTimeout).toHaveBeenCalledWith(expect.any(Function), 60_000);
    expect(healthStore.setHealth).toHaveBeenCalledWith('p1', expect.objectContaining({ state: AccountHealthState.HEALTHY }));

    const state = { cookies: [], origins: [] };
    await capturedOptions?.onStorageStatePersist?.(state);
    expect(checkpointStore.saveState).toHaveBeenCalledWith('p1', state, 2);
    expect(profileStore.saveStorageState).toHaveBeenCalledWith('p1', state);

    await capturedOptions?.onChallengeStateChange?.({
      detected: true,
      category: 'captcha',
      signals: [],
      observedAt: new Date(1_000).toISOString(),
    });
    expect(persistedHealth.current).toMatchObject({ state: AccountHealthState.CHALLENGE_REQUIRED });

    await manager.stop('ses_session1');
    expect(clock.clearTimeout).toHaveBeenCalled();
    expect(metrics.increment).toHaveBeenCalledWith('stops', {});
  });

  it('falls back to flat storage state when checkpoint recovery fails', async () => {
    const flatState = { cookies: [], origins: [] };
    let capturedOptions: BrowserSessionOptions | undefined;
    const manager = new SessionManager({
      profileStore: {
        getProfile: vi.fn().mockResolvedValue({ profileId: 'p1' }),
        getCookies: vi.fn().mockResolvedValue([]),
        getStorageState: vi.fn().mockResolvedValue(flatState),
      } as unknown as ProfileStore,
      checkpointStore: {
        getLatestState: vi.fn().mockRejectedValue(new Error('checkpoint volume unavailable')),
      } as unknown as VersionedCheckpointStore,
      sessionFactory: (options) => {
        capturedOptions = options;
        return {
          sessionId: 'ses_session2',
          start: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn().mockResolvedValue({ sessionId: 'ses_session2', state: 'STOPPED' }),
          status: () => ({ sessionId: 'ses_session2', state: 'STOPPED' }),
          state: 'READY',
        } as unknown as BrowserSession;
      },
      policyProfile: 'standard',
    });

    await manager.start({ profileId: 'p1' });
    expect(capturedOptions?.initialStorageState).toBe(flatState);
    await manager.stop('ses_session2');
  });

  it('rejects starts for disabled profiles before constructing a browser session', async () => {
    const healthStore = {
      getHealth: vi.fn().mockResolvedValue({
        state: AccountHealthState.DISABLED,
        reason: 'operator disabled',
        lastUpdated: 0,
        failureCount: 0,
        nextRetryAvailableAt: null,
      }),
    } as unknown as AccountHealthStore;
    const metrics = new AccountMetrics();
    vi.spyOn(metrics, 'increment');
    const sessionFactory = vi.fn();
    const manager = new SessionManager({
      profileStore: { getProfile: vi.fn().mockResolvedValue({ profileId: 'p1' }) } as unknown as ProfileStore,
      accountHealthStore: healthStore,
      accountMetrics: metrics,
      sessionFactory,
      policyProfile: 'standard',
    });

    await expect(manager.start({ profileId: 'p1' })).rejects.toBeInstanceOf(BrowserSessionError);
    expect(metrics.increment).toHaveBeenCalledWith('admission_rejection', {});
    expect(sessionFactory).not.toHaveBeenCalled();
  });
});
