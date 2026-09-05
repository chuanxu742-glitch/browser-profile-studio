import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProfileStore } from '../../src/profile/profile-store.js';
import { SecretVault } from '../../src/security/secret-vault.js';
import { BrowserSession } from '../../src/browser/browser-session.js';
import type { BrowserStorageState } from '../../src/profile/types.js';

describe('Durable Saved-Account Login State', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'profile-login-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

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

    // A real browser restart restores and checkpoints the state.
    let resolvePersisted!: (state: BrowserStorageState) => void;
    const persisted = new Promise<BrowserStorageState>((resolve) => {
      resolvePersisted = resolve;
    });
    const session1 = new BrowserSession({
      sessionId: 'ses_test1234',
      profileRoot: tempDir,
      profileName: 'prof1',
      persistentProfile: false,
      initialStorageState: recovered,
      onStorageStatePersist: resolvePersisted,
    });

    try {
      await session1.start();
    } finally {
      await session1.stop();
    }

    const persistedState = await persisted;
    expect(persistedState.cookies.find((cookie) => cookie.name === 'test_cookie')).toBeDefined();
  }, 30_000);
});
