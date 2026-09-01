import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '../../src/browser/session-manager.js';
import { ProfileStore } from '../../src/profile/profile-store.js';
import { RestApiServer } from '../../src/api/server.js';

describe('Studio REST authentication and RBAC', () => {
  let root: string;
  let manager: SessionManager;
  let server: RestApiServer;
  let baseUrl: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'api-auth-'));
    const store = new ProfileStore(join(root, 'profiles'));
    manager = new SessionManager({ profileStore: store, profileRoot: join(root, 'profiles'), artifactsRoot: join(root, 'artifacts') });
    server = new RestApiServer(manager, {
      port: 0,
      host: '127.0.0.1',
      credentials: [
        { token: 'viewer-token-012345678901234567890123', role: 'viewer', label: 'reader' },
        { token: 'owner-token-0123456789012345678901234', role: 'owner', label: 'owner' },
      ],
      bootstrapToken: 'one-time-bootstrap',
    });
    const address = await server.start();
    baseUrl = `http://${address.host}:${address.port}`;
  });

  afterEach(async () => {
    await server.stop();
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  it('requires authentication and enforces viewer/owner permissions', async () => {
    expect((await fetch(`${baseUrl}/api/v1/profiles`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/v1/profiles`, { headers: { Authorization: 'Bearer viewer-token-012345678901234567890123' } })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/v1/profiles`, {
      method: 'POST',
      headers: { Authorization: 'Bearer viewer-token-012345678901234567890123', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'denied' }),
    })).status).toBe(403);

    const create = await fetch(`${baseUrl}/api/v1/profiles`, {
      method: 'POST',
      headers: { Authorization: 'Bearer owner-token-0123456789012345678901234', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'allowed', twoFactorSecret: 'SERVER_ONLY', proxy: { server: 'http://localhost:8080', password: 'SERVER_ONLY_PASSWORD' } }),
    });
    expect(create.status).toBe(201);
    const payload = await create.json() as any;
    expect(payload.data.twoFactorSecret).toBeUndefined();
    expect(payload.data.hasTwoFactorSecret).toBe(true);
    expect(payload.data.proxy.password).toBeUndefined();
    expect(payload.data.proxy.hasPassword).toBe(true);
  });

  it('exchanges the bootstrap token once for an HttpOnly owner cookie', async () => {
    const first = await fetch(`${baseUrl}/?bootstrap=one-time-bootstrap`, { redirect: 'manual' });
    expect(first.status).toBe(303);
    expect(first.headers.get('set-cookie')).toContain('HttpOnly');
    expect(first.headers.get('set-cookie')).toContain('SameSite=Strict');
    expect((await fetch(`${baseUrl}/?bootstrap=one-time-bootstrap`, { redirect: 'manual' })).status).toBe(403);
  });
});
