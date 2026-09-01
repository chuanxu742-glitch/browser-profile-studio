import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicWriteFile, readJsonWithBackup } from '../../src/storage/atomic-file.js';
import { ProfileStore } from '../../src/profile/profile-store.js';
import { TeamAccessStore } from '../../src/team/access-store.js';
import { checkProxy } from '../../src/proxy/checker.js';

describe('product hardening', () => {
  let root: string | undefined;
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

  it('retains a last-good backup and recovers JSON from it', async () => {
    root = await mkdtemp(join(tmpdir(), 'atomic-state-'));
    const path = join(root, 'state.json');
    await atomicWriteFile(path, JSON.stringify({ version: 1 }));
    await atomicWriteFile(path, JSON.stringify({ version: 2 }));
    expect(JSON.parse(await readFile(`${path}.bak`, 'utf8'))).toEqual({ version: 1 });
    await atomicWriteFile(path, '{broken', { backup: false });
    expect(await readJsonWithBackup(path)).toEqual({ version: 1 });
  });

  it('moves profiles to trash, restores them and supports permanent purge', async () => {
    root = await mkdtemp(join(tmpdir(), 'profile-trash-'));
    const store = new ProfileStore(join(root, 'profiles'));
    const profile = await store.createProfile({ name: 'Recover me' });
    expect(await store.deleteProfile(profile.profileId)).toBe(true);
    expect(await store.getProfile(profile.profileId)).toBeNull();
    expect((await store.listDeletedProfiles())[0]?.name).toBe('Recover me');
    expect((await store.restoreProfile(profile.profileId)).name).toBe('Recover me');
    await store.deleteProfile(profile.profileId);
    expect(await store.purgeDeletedProfile(profile.profileId)).toBe(true);
    expect(await store.listDeletedProfiles()).toEqual([]);
  });

  it('hashes API keys, authenticates active members and enforces resource grants', async () => {
    root = await mkdtemp(join(tmpdir(), 'team-access-'));
    const path = join(root, 'team.json');
    const store = new TeamAccessStore(path); await store.init();
    const workspace = await store.createWorkspace('Operations');
    const member = await store.createMember({ workspaceId: workspace.workspaceId, name: 'Alice', role: 'operator', grants: { profile: ['prf_allowed'] } });
    const issued = await store.issueApiKey(member.memberId, 'automation');
    expect(await readFile(path, 'utf8')).not.toContain(issued.token);
    const identity = store.authenticate(issued.token)!;
    expect(store.canAccess(identity, 'profile', 'prf_allowed')).toBe(true);
    expect(store.canAccess(identity, 'profile', 'prf_denied')).toBe(false);
    expect(await store.revokeApiKey(issued.keyId)).toBe(true);
    expect(store.authenticate(issued.token)).toBeUndefined();
  });

  it('distinguishes reachable proxies from verified egress proxies', async () => {
    const proxy = createServer((socket) => {
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk.toString('latin1');
        if (data.startsWith('CONNECT ') && data.includes('\r\n\r\n')) {
          data = '';
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        } else if (data.startsWith('GET ') && data.includes('\r\n\r\n')) {
          const body = JSON.stringify({ ip: '203.0.113.7', country: 'US' });
          socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
        }
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const address = proxy.address(); const port = address && typeof address === 'object' ? address.port : 0;
    const result = await checkProxy(`http://127.0.0.1:${port}`, { ipCheckServiceUrl: 'http://egress.test/check', timeoutMs: 1_000 });
    await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
    expect(result).toMatchObject({ success: true, verified: true, checkLevel: 'egress', outboundIp: '203.0.113.7', country: 'US' });
  });
});
