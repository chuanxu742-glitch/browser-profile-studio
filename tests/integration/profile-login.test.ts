import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProfileStore } from '../../src/profile/profile-store.js';
import { SecretVault } from '../../src/security/secret-vault.js';
import { SessionManager } from '../../src/browser/session-manager.js';
import { RestApiServer } from '../../src/api/server.js';
import type { BrowserStorageState } from '../../src/profile/types.js';

describe('Durable Saved-Account Login State', () => {
  let tempDir: string;
  let manager: SessionManager | undefined;
  let api: RestApiServer | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'profile-login-test-'));
  });

  afterEach(async () => {
    try {
      await api?.stop();
    } finally {
      try {
        await manager?.shutdown();
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  }, 60_000);

  it('restores and atomically checkpoints storage state, with encryption and corrupt-primary backup recovery', async () => {
    const vault = new SecretVault('0123456789abcdef0123456789abcdef');
    const store = new ProfileStore(tempDir, { vault });
    await store.init();
    await store.createProfile({ profileId: 'prof1', name: 'Profile 1' });

    const state: BrowserStorageState = {
      cookies: [{ name: 'test_cookie', value: 'secret_val', domain: 'example.com', path: '/' }],
      origins: [{
        origin: 'https://example.com',
        localStorage: [{ name: 'test_ls', value: 'ls_val' }],
      }],
    };

    await store.saveStorageState('prof1', state);
    
    // Second write to create .bak from the first write
    const state2: BrowserStorageState = {
      cookies: [{ name: 'test_cookie2', value: 'secret_val2', domain: 'example.com', path: '/' }],
      origins: [],
    };
    await store.saveStorageState('prof1', state2);

    const statePath = store.getStorageStatePath('prof1');
    const rawContent = await readFile(statePath, 'utf8');
    
    // 1. Encrypted-at-rest data
    expect(rawContent.startsWith('enc:v1:')).toBe(true);
    expect(rawContent).not.toContain('secret_val');

    // Restore should decrypt
    const restored = await store.getStorageState('prof1');
    expect(restored?.cookies[0]?.name).toBe('test_cookie2');

    // 2. Corrupt-primary backup recovery
    // Corrupt the primary file.
    await writeFile(statePath, 'corrupt data');
    
    // getStorageState should fall back to backup (which was the first write, state)
    const recovered = await store.getStorageState('prof1');
    expect(recovered?.cookies[0]?.name).toBe('test_cookie');
    if (!recovered) throw new Error('Expected backup storage state');

    // REST and the real manager own the persistent Firefox profile and checkpoint.
    manager = new SessionManager({
      cluster: false,
      profileRoot: tempDir,
      artifactsRoot: join(tempDir, 'artifacts'),
      profileStore: store,
    });
    api = new RestApiServer(manager, { port: 0, host: '127.0.0.1' });
    const { host, port } = await api.start();
    const endpoint = `http://${host}:${port}/api/v1/profiles/prof1`;
    const start = async (): Promise<string> => {
      const response = await fetch(`${endpoint}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ headless: true }),
      });
      expect(response.status).toBe(200);
      const result = await response.json() as { data: { sessionId: string; state: string } };
      expect(result.data.state).toBe('READY');
      return result.data.sessionId;
    };
    const stop = async (): Promise<void> => {
      const response = await fetch(`${endpoint}/stop`, { method: 'POST' });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ data: { stopped: true, profileId: 'prof1' } });
    };
    const firstSessionId = await start();
    expect(manager.get(firstSessionId).profileDirectory).toBe(store.getProfileDir('prof1'));
    expect(manager.get(firstSessionId).status().profilePersistent).toBe(true);
    await stop();
    await access(store.getProfileDir('prof1'));

    const checkpoint = await store.getStorageState('prof1');
    expect(checkpoint?.cookies).toContainEqual(expect.objectContaining({
      name: 'test_cookie',
      value: 'secret_val',
    }));
    expect(checkpoint?.origins).toContainEqual(expect.objectContaining({
      origin: 'https://example.com',
      localStorage: [{ name: 'test_ls', value: 'ls_val' }],
    }));
    const encryptedCheckpoint = await readFile(statePath, 'utf8');
    expect(encryptedCheckpoint.startsWith('enc:v1:')).toBe(true);
    expect(encryptedCheckpoint).not.toContain('secret_val');

    // A fresh browser process reopens the same persistent profile via REST.
    const secondSessionId = await start();
    expect(secondSessionId).not.toBe(firstSessionId);
    expect(manager.get(secondSessionId).profileDirectory).toBe(store.getProfileDir('prof1'));
    await stop();
    const restarted = await store.getStorageState('prof1');
    expect(restarted?.cookies).toContainEqual(expect.objectContaining({
      name: 'test_cookie',
      value: 'secret_val',
    }));
    expect(restarted?.origins).toContainEqual(expect.objectContaining({
      origin: 'https://example.com',
      localStorage: [{ name: 'test_ls', value: 'ls_val' }],
    }));
  }, 60_000);

  it('reports a failed checkpoint and releases the persistent browser for restart', async () => {
    const store = new ProfileStore(tempDir);
    await store.createProfile({ profileId: 'prof1', name: 'Profile 1' });
    manager = new SessionManager({
      cluster: false,
      profileRoot: tempDir,
      artifactsRoot: join(tempDir, 'artifacts'),
      profileStore: store,
    });
    api = new RestApiServer(manager, { port: 0, host: '127.0.0.1' });
    const { host, port } = await api.start();
    const endpoint = `http://${host}:${port}/api/v1/profiles/prof1`;
    const start = () => fetch(`${endpoint}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ headless: true }),
    });

    const first = await start();
    expect(first.status).toBe(200);
    const firstSessionId = (await first.json() as { data: { sessionId: string } }).data.sessionId;
    vi.spyOn(store, 'saveStorageState').mockRejectedValueOnce(new Error('checkpoint write failed'));
    const failedStop = await fetch(`${endpoint}/stop`, { method: 'POST' });
    expect(failedStop.status).toBe(500);
    expect(await failedStop.json()).toMatchObject({ success: false, code: 'INTERNAL' });
    expect(manager.size).toBe(0);

    const second = await start();
    expect(second.status).toBe(200);
    const secondSessionId = (await second.json() as { data: { sessionId: string } }).data.sessionId;
    expect(secondSessionId).not.toBe(firstSessionId);
    expect(manager.get(secondSessionId).profileDirectory).toBe(store.getProfileDir('prof1'));
    const stopped = await fetch(`${endpoint}/stop`, { method: 'POST' });
    expect(stopped.status).toBe(200);
    await access(store.getStorageStatePath('prof1'));
  }, 60_000);
});
