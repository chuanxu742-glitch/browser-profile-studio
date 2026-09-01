import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A browser-only manager must not construct a queue adapter, even when the
// process happens to carry Redis configuration. Throwing from either Redis
// constructor makes an accidental connection attempt fail deterministically
// instead of relying on a network timeout.
vi.mock('ioredis', () => ({
  Redis: class UnexpectedRedisConnection {
    public constructor() {
      throw new Error('Redis must not be initialized by a browser-only SessionManager');
    }
  },
  Cluster: class UnexpectedRedisClusterConnection {
    public constructor() {
      throw new Error('Redis Cluster must not be initialized by a browser-only SessionManager');
    }
  },
}));

import { SessionManager } from '../../src/browser/session-manager.js';
import type { BrowserSession, BrowserSessionOptions, BrowserSessionStatus } from '../../src/browser/browser-session.js';
import type { DistributedTaskDefinition } from '../../src/distributed/types.js';
import { ProfileStore } from '../../src/profile/profile-store.js';

const originalRedisUrl = process.env.REDIS_URL;
const task: DistributedTaskDefinition = { url: 'https://example.com/queue-task' };

function fakeSession(sessionId: string): { session: BrowserSession; stopCalls: number } {
  let state: BrowserSessionStatus['state'] = 'STOPPED';
  let stopCalls = 0;
  const status = (): BrowserSessionStatus => ({
    sessionId,
    state,
    headless: true,
    pageGeneration: 0,
    queueDepth: 0,
    challenge: { detected: false },
    interrupts: { latestSequence: 0, total: 0, recent: [] },
    control: {
      state: 'AGENT_CONTROLLED',
      controlState: 'AGENT_CONTROLLED',
      owner: 'agent',
      handoffState: 'NONE',
      leaseState: 'NONE',
      phase: 'NONE',
      hardStop: false,
      agentWriteAllowed: true,
      userControlActive: false,
      leaseActive: false,
      hasActiveLease: false,
    },
  });
  const session = {
    sessionId,
    get state() { return state; },
    async start(): Promise<BrowserSessionStatus> {
      state = 'READY';
      return status();
    },
    async stop(): Promise<BrowserSessionStatus> {
      stopCalls += 1;
      state = 'STOPPED';
      return status();
    },
    status,
  } as unknown as BrowserSession;
  return {
    session,
    get stopCalls() { return stopCalls; },
  };
}
function controllableFakeSession(sessionId: string): {
  session: BrowserSession;
  open: ReturnType<typeof vi.fn>;
  leaseToken: string;
} {
  let state: BrowserSessionStatus['state'] = 'STOPPED';
  const leaseToken = 'lease-token-for-workspace-test';
  const open = vi.fn(async (url: string) => ({ url, pageGeneration: 1 }));
  const status = (): BrowserSessionStatus => {
    const userControlled = state === 'USER_CONTROLLED';
    return {
      sessionId,
      state,
      headless: true,
      pageGeneration: 1,
      queueDepth: 0,
      challenge: { detected: false },
      interrupts: { latestSequence: 0, total: 0, recent: [] },
      control: {
        state: userControlled ? 'USER_CONTROLLED' : 'AGENT_CONTROLLED',
        controlState: userControlled ? 'USER_CONTROLLED' : 'AGENT_CONTROLLED',
        owner: userControlled ? 'user' : 'agent',
        handoffState: userControlled ? 'ACTIVE' : 'NONE',
        leaseState: userControlled ? 'ACTIVE' : 'NONE',
        phase: userControlled ? 'USER_ACTIVE' : 'NONE',
        hardStop: userControlled,
        agentWriteAllowed: !userControlled,
        userControlActive: userControlled,
        leaseActive: userControlled,
        hasActiveLease: userControlled,
      },
    };
  };
  const session = {
    sessionId,
    get state() { return state; },
    async start(): Promise<BrowserSessionStatus> {
      state = 'READY';
      return status();
    },
    async stop(): Promise<BrowserSessionStatus> {
      state = 'STOPPED';
      return status();
    },
    async handoff(): Promise<unknown> {
      state = 'USER_CONTROLLED';
      return { state, leaseToken, control: { expiresAt: Date.now() + 60_000 } };
    },
    async takeover(token: string, confirmed: boolean): Promise<BrowserSessionStatus> {
      if (token !== leaseToken || !confirmed) throw new Error('takeover rejected');
      state = 'READY';
      return status();
    },
    open,
    status,
  } as unknown as BrowserSession;
  return { session, open, leaseToken };
}


function fakeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clearCalls: unknown[] = [];
  const clock = {
    now: () => now,
    setTimeout: (callback: () => void, delayMs: number): unknown => {
      const id = ++nextId;
      timers.set(id, { at: now + delayMs, callback });
      return id;
    },
    clearTimeout: (handle: unknown): void => {
      clearCalls.push(handle);
      timers.delete(handle as number);
    },
  };
  return {
    clock,
    timers,
    clearCalls,
    async advanceBy(milliseconds: number): Promise<void> {
      now += milliseconds;
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= now)
        .map(([id, timer]) => [id, timer.callback] as const);
      for (const [id, callback] of due) {
        timers.delete(id);
        callback();
      }
      // Expiry callback -> manager.stop -> fake session.stop is an async
      // chain; flush it before asserting slot release.
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

afterEach(() => {
  if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = originalRedisUrl;
});

describe('browser-only SessionManager', () => {
  it('binds a saved profile to persistent storage, stable fingerprint settings, and cookie persistence', async () => {
    const workRoot = await mkdtemp(join(tmpdir(), 'saved-profile-manager-'));
    const profileRoot = join(workRoot, 'profiles');
    const store = new ProfileStore(profileRoot);
    await store.createProfile({
      profileId: 'account-a',
      name: 'Account A',
      engine: 'firefox',
      geo: { countryCode: 'JP' },
      fingerprint: {
        seed: 424242,
        os: 'windows',
        hardwareConcurrency: 16,
        screen: { width: 2560, height: 1440 },
      },
      initialCookies: [{ name: 'session', value: 'old', domain: '.example.com', path: '/' }],
    });
    const fixture = fakeSession('ses_saved_profile_0001');
    let captured: BrowserSessionOptions | undefined;
    const manager = new SessionManager({
      cluster: false,
      profileRoot,
      profileStore: store,
      sessionFactory: (options) => {
        captured = options;
        return fixture.session;
      },
    });

    try {
      await manager.start({ profileId: 'account-a', fingerprint: true });
      expect(captured).toMatchObject({
        profileName: 'account-a',
        persistentProfile: true,
        fingerprintSeed: 424242,
        initialCookies: [{ name: 'session', value: 'old', domain: '.example.com', path: '/' }],
        fingerprint: {
          os: 'windows',
          hardware: { hardwareConcurrency: 16, screenWidth: 2560, screenHeight: 1440 },
        },
      });
      await captured?.onCookiesPersist?.([
        { name: 'session', value: 'new', domain: '.example.com', path: '/', secure: true },
      ]);
      await expect(store.getCookies('account-a')).resolves.toMatchObject([
        { name: 'session', value: 'new', domain: '.example.com', path: '/', secure: true },
      ]);
    } finally {
      await manager.shutdown();
      await rm(workRoot, { recursive: true, force: true });
    }
  });

  it('cluster:false 下所有集群方法都稳定拒绝为 INVALID_STATE', async () => {
    const manager = new SessionManager({ cluster: false });

    await expect(manager.submitClusterTask(task)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(manager.submitClusterBatch([task])).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(manager.getClusterStatus()).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(manager.getClusterTask('task_missing')).rejects.toMatchObject({ code: 'INVALID_STATE' });

    await expect(manager.shutdown()).resolves.toBeUndefined();
  });

  it('cluster:false 的 shutdown 可重复调用且不会初始化队列连接', async () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:1';

    const manager = new SessionManager({ cluster: false });

    await expect(manager.shutdown()).resolves.toBeUndefined();
    await expect(manager.shutdown()).resolves.toBeUndefined();
  });

  it('会话达到绝对 TTL 后自动停止、释放并发槽，并拒绝后续访问', async () => {
    const timer = fakeClock();
    const sessions = [fakeSession('ses_ttl_0001'), fakeSession('ses_ttl_0002')];
    let created = 0;
    const manager = new SessionManager({
      cluster: false,
      maxSessions: 1,
      sessionTtlMs: 1_000,
      clock: timer.clock,
      sessionFactory: () => sessions[created++]!.session,
    });

    const first = await manager.start();
    expect(manager.size).toBe(1);
    await timer.advanceBy(999);
    expect(manager.size).toBe(1);
    await timer.advanceBy(1);
    expect(sessions[0]!.stopCalls).toBe(1);
    expect(manager.size).toBe(0);
    await expect(Promise.resolve().then(() => manager.status(first.sessionId))).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
    });
    await expect(manager.open(first.sessionId, 'https://example.com/expired')).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
    });

    // The cleaned session no longer occupies the maxSessions slot.
    await expect(manager.start()).resolves.toBe(sessions[1]!.session);
    await manager.shutdown();
  });

  it('shutdown 会清理所有 TTL timer，避免 manager 被定时器保持常驻', async () => {
    const timer = fakeClock();
    const created = fakeSession('ses_ttl_0003');
    const manager = new SessionManager({
      cluster: false,
      sessionTtlMs: 1_000,
      clock: timer.clock,
      sessionFactory: () => created.session,
    });

    await manager.start();
    expect(timer.timers.size).toBe(1);
    await manager.shutdown();
    expect(created.stopCalls).toBe(1);
    expect(timer.clearCalls).toHaveLength(1);
    expect(timer.timers.size).toBe(0);

    // Repeated shutdown is idempotent and does not try to clear a removed timer.
    await manager.shutdown();
    expect(timer.clearCalls).toHaveLength(1);
  });
  it('scopes workspace ownership by tenant and garbage-collects retained records', async () => {
    const timer = fakeClock();
    const fixture = fakeSession('ses_workspace_tenant_0001');
    const manager = new SessionManager({
      cluster: false,
      workspaceTtlMs: 60_000,
      clock: timer.clock,
      sessionFactory: () => fixture.session,
    });

    await manager.start({ workspaceRetention: 'retain', tenantId: 'tenant-a' });
    const workspace = manager.listWorkspaces('tenant-a')[0];
    expect(workspace?.tenantId).toBe('tenant-a');
    expect(manager.listWorkspaces('tenant-b')).toEqual([]);
    expect(() => manager.get(fixture.session.sessionId, 'tenant-b')).toThrowError(
      expect.objectContaining({ code: 'PERMISSION_DENIED' }),
    );
    expect(() => manager.getWorkspace(workspace!.workspaceId, 'tenant-b')).toThrowError(
      expect.objectContaining({ code: 'PERMISSION_DENIED' }),
    );

    await manager.shutdown();
    expect(manager.listWorkspaces('tenant-a')).toHaveLength(1);
    await timer.advanceBy(59_999);
    expect(manager.listWorkspaces('tenant-a')).toHaveLength(1);
    await timer.advanceBy(1);
    expect(manager.listWorkspaces('tenant-a')).toEqual([]);
  });

  it('creates a workspace, hard-stops writes during handoff, and resumes with the lease', async () => {
    const fixture = controllableFakeSession('ses_workspace_0001');
    const manager = new SessionManager({
      cluster: false,
      sessionFactory: () => fixture.session,
      handoffTtlMs: 30_000,
    });

    await manager.start({ workspaceName: 'checkout', workspaceRetention: 'retain' });
    const workspace = manager.listWorkspaces()[0];
    expect(workspace).toMatchObject({
      name: 'checkout',
      owner: 'agent',
      controlState: 'AGENT_CONTROLLED',
      retention: 'retain',
      sessionId: fixture.session.sessionId,
    });
    if (!workspace) throw new Error('workspace fixture was not created');

    const handoff = await manager.workspaceHandoff(workspace.workspaceId, 'operator review');
    expect(handoff.workspace).toMatchObject({ owner: 'user', controlState: 'USER_CONTROLLED' });
    await expect(manager.open(fixture.session.sessionId, 'https://example.test/blocked')).rejects.toMatchObject({
      code: 'USER_CONTROL_HARD_STOP',
    });
    expect(fixture.open).not.toHaveBeenCalled();

    await expect(manager.workspaceResume(workspace.workspaceId, 'wrong-lease', true)).rejects.toMatchObject({
      code: 'HUMAN_HANDOFF_EXPIRED',
    });
    const resumed = await manager.workspaceResume(workspace.workspaceId, handoff.leaseId, true);
    expect(resumed.workspace).toMatchObject({ owner: 'agent', controlState: 'AGENT_CONTROLLED' });
    await expect(manager.open(fixture.session.sessionId, 'https://example.test/allowed')).resolves.toMatchObject({
      url: 'https://example.test/allowed',
    });
    expect(fixture.open).toHaveBeenCalledTimes(1);

    expect(manager.capabilities(['page_open'])).toMatchObject({
      supportedTools: ['page_open'],
      maxConcurrentSessions: 2,
      maxTabsPerSession: 12,
      policy: 'standard',
      workspaceDefaultTtlMs: 7 * 24 * 60 * 60_000,
      privateNetworkEnabled: false,
      forbiddenCapabilities: expect.arrayContaining(['raw_evaluate', 'raw_cdp', 'unmanaged_extension_loading', 'arbitrary_extension_path']),
    });
    await manager.shutdown();
    expect(manager.listWorkspaces()).toHaveLength(1);
  });

  it('exposes the administrator policy and profile-specific effective ceilings', async () => {
    const manager = new SessionManager({ cluster: false, policyProfile: 'strict' });
    expect(manager.capabilities()).toMatchObject({
      policy: 'strict',
      maxTabsPerSession: 5,
      limits: {
        maxWorkflowSteps: 10,
        maxScrollAmount: 3,
        sessionTtlMs: 30 * 60_000,
      },
      sessionDefaultTtlMs: 30 * 60_000,
      workspaceDefaultTtlMs: 24 * 60 * 60_000,
    });
    await manager.shutdown();
  });
});
