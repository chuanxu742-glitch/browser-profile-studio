import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { test, expect, describe, beforeAll, afterAll } from 'vitest';
import {
  VersionedCheckpointStore,
  CheckpointConflictError,
} from '../../src/profile/versioned-checkpoint-store.js';
import { SecretVault } from '../../src/security/secret-vault.js';
import type { BrowserStorageState } from '../../src/profile/types.js';


const mockState = (): BrowserStorageState => ({
  cookies: [
    { name: 'session', value: '123', domain: 'example.com', path: '/' }
  ],
  origins: []
});

describe('VersionedCheckpointStore', () => {
  let baseDir: string;

  beforeAll(async () => {
    baseDir = path.join(process.cwd(), 'temp-checkpoints-' + randomUUID());
    await fs.mkdir(baseDir, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });


  test('first save creates checkpoint_1 and latest pointer', async () => {
    const store = new VersionedCheckpointStore(baseDir);
    const profileId = 'prof-first-save';

    const version = await store.saveState(profileId, mockState());
    expect(version).toBe(1);

    const latest = await store.getLatestState(profileId);
    expect(latest).not.toBeNull();
    expect(latest?.version).toBe(1);
    expect(latest!.state.cookies[0]!.name).toBe('session');

    // Verify files on disk
    const profileDir = path.join(baseDir, profileId);
    const files = await fs.readdir(profileDir);
    expect(files).toContain('checkpoint_1.json');
    expect(files).toContain('latest');

    const latestContent = await fs.readFile(path.join(profileDir, 'latest'), 'utf8');
    expect(latestContent.trim()).toBe('1');
  });

  test('CAS conflict throws CheckpointConflictError', async () => {
    const store = new VersionedCheckpointStore(baseDir);
    const profileId = 'prof-cas';

    // Save v1
    await store.saveState(profileId, mockState());
    
    // Attempt to save with expectedVersion = 0 (which is wrong, it's 1)
    await expect(store.saveState(profileId, mockState(), 0))
      .rejects.toThrow(CheckpointConflictError);

    // Save with expectedVersion = 1 should succeed
    const v2 = await store.saveState(profileId, mockState(), 1);
    expect(v2).toBe(2);
  });

  test('retention pruning keeps only maxCheckpoints', async () => {
    const store = new VersionedCheckpointStore(baseDir, { maxCheckpoints: 3 });
    const profileId = 'prof-prune';

    // Save 5 checkpoints
    for (let i = 0; i < 5; i++) {
      await store.saveState(profileId, mockState());
    }

    const latest = await store.getLatestState(profileId);
    expect(latest!.version).toBe(5);

    const profileDir = path.join(baseDir, profileId);
    const files = await fs.readdir(profileDir);
    
    expect(files.filter(f => f.startsWith('checkpoint_'))).toHaveLength(3);
    // Should keep 5, 4, 3
    expect(files).toContain('checkpoint_5.json');
    expect(files).toContain('checkpoint_4.json');
    expect(files).toContain('checkpoint_3.json');
    expect(files).not.toContain('checkpoint_2.json');
    expect(files).not.toContain('checkpoint_1.json');
  });

  test('encrypted-at-rest files work seamlessly with vault', async () => {
    const vault = new SecretVault(Buffer.alloc(32, 'a')); // 32 bytes of 'a'
    const store = new VersionedCheckpointStore(baseDir, { vault });
    const profileId = 'prof-enc';

    await store.saveState(profileId, mockState());
    
    const latest = await store.getLatestState(profileId);
    expect(latest!.version).toBe(1);

    // Verify it's actually encrypted on disk
    const profileDir = path.join(baseDir, profileId);
    const rawContent = await fs.readFile(path.join(profileDir, 'checkpoint_1.json'), 'utf8');
    expect(rawContent).toMatch(/^enc:v1:/);
    expect(rawContent).not.toContain('session'); // The cookie name shouldn't be in plaintext
  });

  test('corrupt-latest recovery finds the highest valid checkpoint', async () => {
    const store = new VersionedCheckpointStore(baseDir);
    const profileId = 'prof-corrupt';

    await store.saveState(profileId, mockState()); // v1
    await store.saveState(profileId, mockState()); // v2
    await store.saveState(profileId, mockState()); // v3

    const profileDir = path.join(baseDir, profileId);

    // Corrupt v3
    await fs.writeFile(path.join(profileDir, 'checkpoint_3.json'), 'this is not valid json');

    // Now if we request latest, it should skip v3 and return v2
    const latest = await store.getLatestState(profileId);
    expect(latest!.version).toBe(2);

    // And it should have fixed the latest pointer
    const latestPointer = await fs.readFile(path.join(profileDir, 'latest'), 'utf8');
    expect(latestPointer.trim()).toBe('2');

    // Corrupt the latest pointer completely
    await fs.writeFile(path.join(profileDir, 'latest'), 'garbage');
    const latest2 = await store.getLatestState(profileId);
    expect(latest2!.version).toBe(2);
  });

  test('cross-profile isolation prevents state bleeding', async () => {
    const store = new VersionedCheckpointStore(baseDir);
    const p1 = 'prof-iso-1';
    const p2 = 'prof-iso-2';

    const state1 = mockState();
    const cookies1 = [...state1.cookies];
    cookies1[0] = { ...cookies1[0]!, value: 'val1' };
    await store.saveState(p1, { ...state1, cookies: cookies1 });

    const state2 = mockState();
    const cookies2 = [...state2.cookies];
    cookies2[0] = { ...cookies2[0]!, value: 'val2' };
    await store.saveState(p2, { ...state2, cookies: cookies2 });

    const l1 = await store.getLatestState(p1);
    expect(l1!.state.cookies[0]!.value).toBe('val1');
    expect(l1!.version).toBe(1);

    const l2 = await store.getLatestState(p2);
    expect(l2!.state.cookies[0]!.value).toBe('val2');
    expect(l2!.version).toBe(1);
  });
});