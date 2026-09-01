import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../../src/browser/session-manager.js';
import { ProfileStore } from '../../src/profile/profile-store.js';
import { RestApiServer } from '../../src/api/server.js';

describe('Local REST API Server Unit Tests', () => {
  let tempDir: string;
  let manager: SessionManager;
  let server: RestApiServer;
  let baseUrl: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'api-test-'));
    const store = new ProfileStore(join(tempDir, 'profiles'));
    manager = new SessionManager({
      profileRoot: join(tempDir, 'profiles'),
      artifactsRoot: join(tempDir, 'artifacts'),
      profileStore: store,
    });
    server = new RestApiServer(manager, { port: 0, host: '127.0.0.1' });
    const { port, host } = await server.start();
    baseUrl = `http://${host}:${port}`;
  });

  afterEach(async () => {
    await server.stop();
    await manager.shutdown();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should respond to /api/v1/health', async () => {
    const res = await fetch(`${baseUrl}/api/v1/health`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.status).toBe('healthy');
  });

  it('should create, get, list and delete profiles via REST API', async () => {
    // 1. Create Profile
    const createRes = await fetch(`${baseUrl}/api/v1/profiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'REST API Test Store',
        description: 'Store created via REST API',
        proxy: {
          server: 'http://user:pass@127.0.0.1:8080',
        },
        geo: {
          countryCode: 'US',
        },
      }),
    });
    expect(createRes.status).toBe(201);
    const createJson = await createRes.json();
    expect(createJson.success).toBe(true);
    const profileId = createJson.data.profileId;
    expect(profileId).toBeDefined();

    // 2. Get Profile
    const getRes = await fetch(`${baseUrl}/api/v1/profiles/${profileId}`);
    expect(getRes.status).toBe(200);
    const getJson = await getRes.json();
    expect(getJson.data.name).toBe('REST API Test Store');

    // 3. List Profiles
    const listRes = await fetch(`${baseUrl}/api/v1/profiles`);
    expect(listRes.status).toBe(200);
    const listJson = await listRes.json();
    expect(listJson.data.some((p: any) => p.profileId === profileId)).toBe(true);

    // 4. Proxy check
    const checkRes = await fetch(`${baseUrl}/api/v1/proxy/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proxy: 'http://127.0.0.1:59999',
      }),
    });
    expect(checkRes.status).toBe(200);
    const checkJson = await checkRes.json();
    expect(checkJson.data.success).toBe(false);

    // 5. Delete Profile
    const delRes = await fetch(`${baseUrl}/api/v1/profiles/${profileId}`, {
      method: 'DELETE',
    });
    expect(delRes.status).toBe(200);
    const delJson = await delRes.json();
    expect(delJson.data.deleted).toBe(true);

    // 6. Verify 404 after delete
    const getAfterRes = await fetch(`${baseUrl}/api/v1/profiles/${profileId}`);
    expect(getAfterRes.status).toBe(404);
  });
});
