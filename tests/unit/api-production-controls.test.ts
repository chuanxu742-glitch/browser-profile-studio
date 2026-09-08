import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountHealthStore } from '../../src/account/account-health-store.js';
import { RestApiServer } from '../../src/api/server.js';
import { SessionManager } from '../../src/browser/session-manager.js';
import { AccountMetrics } from '../../src/operations/account-metrics.js';
import { ProfileStore } from '../../src/profile/profile-store.js';
import { ProfileBackupService } from '../../src/security/profile-backup.js';
import { SecretVault } from '../../src/security/secret-vault.js';

describe('REST production account controls', () => {
  let tempDir: string;
  let manager: SessionManager;
  let server: RestApiServer;
  let baseUrl: string;
  let metrics: AccountMetrics;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'api-prod-test-'));
    const profileStore = new ProfileStore(join(tempDir, 'profiles'));
    await profileStore.init();
    const backupDir = join(tempDir, 'backups');
    await mkdir(backupDir, { recursive: true });
    metrics = new AccountMetrics();
    manager = new SessionManager({
      profileRoot: join(tempDir, 'profiles'),
      artifactsRoot: join(tempDir, 'artifacts'),
      profileStore,
      accountHealthStore: new AccountHealthStore(profileStore),
      accountMetrics: metrics,
      cluster: false,
    });
    server = new RestApiServer(manager, {
      port: 0,
      host: '127.0.0.1',
      credentials: [
        { token: 'owner-token', role: 'owner' },
        { token: 'manager-token', role: 'manager' },
        { token: 'viewer-token', role: 'viewer' },
      ],
      metrics,
      backupService: new ProfileBackupService(),
      backupDir,
      vault: new SecretVault(randomBytes(32)),
    });
    const address = await server.start();
    baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
  });

  afterEach(async () => {
    await server.stop();
    await manager.shutdown();
    await rm(tempDir, { recursive: true, force: true });
  });

  async function request(path: string, method: string, token?: string, body?: unknown) {
    return new Promise<{ status: number; body: Record<string, unknown> }>((resolvePromise, reject) => {
      const req = http.request(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
      }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          data += chunk;
        });
        res.on('end', () => {
          resolvePromise({ status: res.statusCode ?? 500, body: JSON.parse(data || '{}') as Record<string, unknown> });
        });
      });
      req.once('error', reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  }

  it('requires manager access for account health and persists valid transitions', async () => {
    const profile = await manager.createProfile({ name: 'test' });
    expect((await request(`/profiles/${profile.profileId}/health`, 'GET', 'viewer-token')).status).toBe(403);
    expect((await request(`/profiles/${profile.profileId}/health`, 'GET', 'manager-token')).status).toBe(200);

    const update = await request(
      `/profiles/${profile.profileId}/health`,
      'PUT',
      'manager-token',
      { state: 'QUARANTINED', reason: 'manual review' },
    );
    expect(update.status).toBe(200);
    expect((update.body.data as Record<string, unknown>).state).toBe('QUARANTINED');
    expect((await manager.getAccountHealth(profile.profileId))?.state).toBe('QUARANTINED');
  });

  it('exposes bounded account metrics and alert state only to authenticated callers', async () => {
    metrics.increment('proxy_quarantine', { profileId: 'raw-profile-id' });
    expect((await request('/metrics', 'GET')).status).toBe(401);
    const response = await request('/metrics', 'GET', 'viewer-token');
    expect(response.status).toBe(200);
    const data = response.body.data as Record<string, unknown>;
    expect(data.accountOperations).toBeDefined();
    expect(data.accountAlerts).toBeDefined();
    expect(JSON.stringify(data)).not.toContain('raw-profile-id');
  });

  it('backs up and restores by opaque server-owned backup ID', async () => {
    const profile = await manager.createProfile({ name: 'test' });
    const markerPath = join(manager.getStore().getProfileDir(profile.profileId), 'marker.txt');
    await writeFile(markerPath, 'before');

    const backup = await request(`/profiles/${profile.profileId}/backups`, 'POST', 'owner-token');
    expect(backup.status).toBe(200);
    const backupId = (backup.body.data as Record<string, unknown>).backupId;
    expect(backupId).toMatch(/^bkp_[A-Za-z0-9_-]+\.backup$/);
    expect(JSON.stringify(backup.body)).not.toContain(tempDir);

    await writeFile(markerPath, 'after');
    const restore = await request(
      `/profiles/${profile.profileId}/backups/${encodeURIComponent(String(backupId))}/restore`,
      'POST',
      'owner-token',
    );
    expect(restore.status).toBe(200);
    expect((restore.body.data as Record<string, unknown>).restored).toBe(true);
    expect(await readFile(markerPath, 'utf8')).toBe('before');
  });

  it('rejects encoded directory traversal and does not accept caller filesystem paths', async () => {
    const profile = await manager.createProfile({ name: 'test' });
    const traversal = await request(
      `/profiles/${profile.profileId}/backups/${encodeURIComponent('../outside.backup')}/restore`,
      'POST',
      'owner-token',
    );
    expect(traversal.status).toBe(400);
    expect(traversal.body.code).toBe('BACKUP_ID_INVALID');

    const legacyPathBody = await request(
      `/profiles/${profile.profileId}/backups`,
      'POST',
      'owner-token',
      { backupPath: 'C:\\outside.backup' },
    );
    expect(legacyPathBody.status).toBe(200);
    expect(JSON.stringify(legacyPathBody.body)).not.toContain('outside.backup');
  });
});
