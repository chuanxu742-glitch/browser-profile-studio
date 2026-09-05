import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readJsonWithBackup, atomicWriteFile } from '../../src/storage/atomic-file.js';
import { RedisLeaseManager } from '../../src/distributed/profile-lease.js';
import type { Redis } from 'ioredis';
import type { FirefoxContextLike, FirefoxPageLike } from '../../src/browser/firefox-launcher.js';
import { SessionManager } from '../../src/browser/session-manager.js';
import { ProfileStore } from '../../src/profile/index.js';
import { DirectScheduler } from '../../src/input/direct-scheduler.js';

// 1. Mock fs.promises for atomicWriteFile to simulate EPERM without chmod
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: vi.fn(actual.rename),
  };
});

// Fake Redis
class FakeRedis {
  public store = new Map<string, { value: string; expiresAt: number }>();

  async set(key: string, value: string | Buffer | number, ...args: unknown[]) {
    const now = Date.now();
    let ttl = 30000;
    if (args[0] === 'PX' && typeof args[1] === 'number') {
      ttl = args[1];
    }
    const existing = this.store.get(key);
    if (existing && existing.expiresAt > now) return null;
    this.store.set(key, { value: String(value), expiresAt: now + ttl });
    return 'OK';
  }

  async eval(script: string, numKeys: number, key: string, ...args: unknown[]) {
    const now = Date.now();
    const existing = this.store.get(key);
    if (script.includes('pexpire')) {
      const leaseToken = args[0];
      const ttl = Number(args[1]);
      if (existing && existing.value === leaseToken && existing.expiresAt > now) {
        existing.expiresAt = now + ttl;
        return 1;
      }
      return 0;
    } else if (script.includes('del')) {
      const leaseToken = args[0];
      if (existing && existing.value === leaseToken && existing.expiresAt > now) {
        this.store.delete(key);
        return 1;
      }
      return 0;
    }
    return 0;
  }
}

class FakePage {
  private currentUrl = 'about:blank';
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  url(): string { return this.currentUrl; }
  title(): Promise<string> { return Promise.resolve('Fixture'); }
  on(event: string, listener: (...args: unknown[]) => void): void {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
  locator(): never {
    throw new Error('no locator in lifecycle fake');
  }
  async goto(url: string): Promise<void> {
    this.currentUrl = url;
    this.emit('framenavigated');
  }
  async screenshot(): Promise<Buffer> { return Buffer.from('fixture-png'); }
  async close(): Promise<void> { return undefined; }
  async bringToFront(): Promise<void> { return undefined; }
}

class FakeContext {
  public readonly page = new FakePage();
  public readonly addedCookies: Array<Record<string, unknown>> = [];
  private cookieJar: Array<{name: string; value: string; domain: string; path: string}> = [];
  pages(): FirefoxPageLike[] { return [this.page as unknown as FirefoxPageLike]; }
  async close(): Promise<void> { return undefined; }
  on(_event: string, _listener: (...args: unknown[]) => void): void {}
  emit(_event: string, ..._args: unknown[]): void {}
  async route(): Promise<void> { return undefined; }
  async addCookies(cookies: Array<Record<string, unknown>>): Promise<void> { this.addedCookies.push(...cookies); }
  async cookies() { return this.cookieJar; }
  setCookies(cookies: Array<{name: string; value: string; domain: string; path: string}>): void { this.cookieJar = cookies; }
}

describe('Deterministic Chaos Coverage', () => {

  describe('Atomic Files', () => {
    it('simulates corrupt primary with valid backup (readJsonWithBackup)', async () => {
      const dir = await fs.mkdtemp(join(tmpdir(), 'chaos-'));
      const path = join(dir, 'test.json');
      try {
        await fs.writeFile(path, '{ corrupt json');
        await fs.writeFile(`${path}.bak`, '{"valid": true}');
        
        const data = await readJsonWithBackup(path);
        expect(data).toEqual({ valid: true });
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('interrupted atomic replacement/disk write errors (atomicWriteFile)', async () => {
      const dir = await fs.mkdtemp(join(tmpdir(), 'chaos-'));
      const path = join(dir, 'target.json');
      
      try {
        // Simulate EPERM on Windows or other disk error without platform-fragile chmod
        const renameSpy = vi.mocked(fs.rename).mockRejectedValueOnce(new Error('EPERM: operation not permitted'));
        
        await expect(atomicWriteFile(path, '{"test": 1}')).rejects.toThrow('EPERM');
        
        const files = await fs.readdir(dir);
        // should clean up temporary files
        expect(files.filter(f => f.endsWith('.tmp'))).toHaveLength(0);
        
        renameSpy.mockRestore();
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('Profile Leases', () => {
    it('stale Redis lease release/renew fencing with a fake Redis', async () => {
      const fakeRedis = new FakeRedis();
      const manager = new RedisLeaseManager(fakeRedis as unknown as Redis, 100);
      
      // Acquire lease A
      const leaseA = await manager.acquire('tenant1', 'profile1');
      expect(leaseA.leaseToken).toBeDefined();
      
      // Expire lease A in fake redis
      fakeRedis.store.get('browser:profile:lease:tenant1:profile1')!.expiresAt = Date.now() - 1;
      
      // Another client acquires lease B
      const leaseB = await manager.acquire('tenant1', 'profile1');
      expect(leaseB.leaseToken).toBeDefined();
      expect(leaseA.leaseToken).not.toBe(leaseB.leaseToken);
      
      // Client A attempts to renew -> should fail
      await expect(manager.renew('tenant1', 'profile1', leaseA.leaseToken)).rejects.toThrow('LEASE_LOST');
      
      // Client A attempts to release -> should not delete B's lease
      await manager.release('tenant1', 'profile1', leaseA.leaseToken);
      
      const currentLease = fakeRedis.store.get('browser:profile:lease:tenant1:profile1');
      expect(currentLease).toBeDefined();
      expect(currentLease!.value).toBe(leaseB.leaseToken);
    });
  });
  
  describe('SessionManager Fail-Closed Behavior', () => {
    it('closes session if lease renewal fails', async () => {
      const fakeStore = {
        getProfile: vi.fn().mockResolvedValue({ profileId: 'fake' }),
        getCookies: vi.fn().mockResolvedValue([]),
        getStorageState: vi.fn().mockResolvedValue(undefined),
        createProfile: vi.fn(),
      } as unknown as ProfileStore;

      const scheduleSpy = vi.fn();
      let scheduledTimerFn: (() => void) | undefined;
      const mockLeaseManager = {
        acquire: vi.fn().mockResolvedValue({ profileId: 'fake', leaseToken: 'token123', expiresAt: Date.now() + 100 }),
        renew: vi.fn().mockRejectedValue(new Error('LEASE_LOST')),
        release: vi.fn(),
        shutdown: vi.fn(),
      };
      const manager = new SessionManager({
        maxSessions: 1,
        launcher: { launchPersistentContext: async () => new FakeContext() as unknown as FirefoxContextLike },
        scheduler: new DirectScheduler(),
        urlPolicy: { assertAllowed: () => true },
        profileStore: fakeStore,
        profileLeaseManager: mockLeaseManager,
        cluster: false,
        clock: {
          now: () => Date.now(),
          setTimeout: (fn, ms) => {
            if (ms === 15_000) scheduledTimerFn = fn;
            scheduleSpy();
            return 123;
          },
          clearTimeout: () => {},
        },
      });

      const session = await manager.start({ headless: true, profileId: 'fake' });
      
      expect(mockLeaseManager.acquire).toHaveBeenCalled();
      expect(scheduleSpy).toHaveBeenCalled();
      expect(scheduledTimerFn).toBeDefined();
      scheduledTimerFn!();
      
      // Wait for async session.stop() to finish due to the renewal failure without timer waits
      for (let i = 0; i < 50; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (session.status().state === 'STOPPED') break;
      }
      
      
      expect(session.status().state).toBe('STOPPED');
    });
  });
});
