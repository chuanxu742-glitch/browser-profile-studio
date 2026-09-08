import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../../src/browser/session-manager.js';
import { ProfileStore } from '../../src/profile/profile-store.js';
import { UrlPolicy } from '../../src/policy/url-policy.js';
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
      urlPolicy: new UrlPolicy({
        allowedHosts: ['example.com'],
        resourceHosts: ['example.com'],
        resolver: () => ['93.184.216.34'],
      }),
    });
    server = new RestApiServer(manager, { port: 0, host: '127.0.0.1' });
    const { port, host } = await server.start();
    baseUrl = `http://${host}:${port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
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

  it('keeps internal exceptions out of live-view, interaction, and resume responses', async () => {
    const privateTrace = 'Error: secret-token at C:\\private\\browser-profile\\session.js:42:7';
    vi.spyOn(manager, 'status').mockImplementation(() => { throw new Error(privateTrace); });
    vi.spyOn(manager, 'dispatchDirectMouse').mockRejectedValue(privateTrace);
    vi.spyOn(manager, 'resume').mockRejectedValue({ toString: () => privateTrace });
    const routes = [
      { path: 'live-view', method: 'GET', status: 500, code: 'SCREENSHOT_FAILED' },
      { path: 'interact', method: 'POST', status: 500, code: 'INTERACTION_FAILED' },
      { path: 'resume', method: 'POST', status: 400, code: 'RESUME_FAILED' },
    ];

    for (const route of routes) {
      const response = await fetch(`${baseUrl}/api/v1/sessions/private-session/${route.path}`, {
        method: route.method,
        ...(route.method === 'POST' ? {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'mouse', humanConfirmed: true }),
        } : {}),
      });
      expect(response.status).toBe(route.status);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({ success: false, code: route.code });
      for (const secret of ['secret-token', 'browser-profile', 'session.js', '42:7']) {
        expect.soft(text).not.toContain(secret);
      }
    }
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
    const listJson = await listRes.json() as {
      data: { items: Array<{ profileId: string }>; total: number };
    };
    expect(listJson.data.items.some((profile) => profile.profileId === profileId)).toBe(true);
    expect(typeof listJson.data.total).toBe('number');

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

  it('executes profile lifecycle actions through the bulk endpoint', async () => {
    const profileIds: string[] = [];
    for (const name of ['Bulk A', 'Bulk B', 'Bulk C']) {
      const response = await fetch(`${baseUrl}/api/v1/profiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      expect(response.status).toBe(201);
      const created = await response.json() as { data?: { profileId?: unknown } };
      if (typeof created.data?.profileId !== 'string') throw new Error('Profile ID missing from create response');
      profileIds.push(created.data.profileId);
    }

    const batch = await fetch(`${baseUrl}/api/v1/profiles/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', profileIds }),
    });

    expect(batch.status).toBe(200);
    const result = await batch.json() as { data?: unknown };
    expect(result.data).toEqual(profileIds.map((profileId) => ({ profileId, success: true })));
  });

  it('does not duplicate login cookies when cloning unless explicitly requested', async () => {
    await manager.createProfile({
      profileId: 'clone_source',
      name: 'Clone source',
      initialCookies: [{ name: 'session', value: 'secret', domain: 'example.com', path: '/' }],
    });

    const isolatedResponse = await fetch(`${baseUrl}/api/v1/profiles/clone_source/clone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Isolated clone' }),
    });
    const isolated = await isolatedResponse.json() as { data?: { profileId?: unknown } };
    if (typeof isolated.data?.profileId !== 'string') throw new Error('Clone profile ID missing');
    await expect(manager.getStore().getCookies(isolated.data.profileId)).resolves.toEqual([]);

    const sharedResponse = await fetch(`${baseUrl}/api/v1/profiles/clone_source/clone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Explicit cookie clone', includeCookies: true }),
    });
    const shared = await sharedResponse.json() as { data?: { profileId?: unknown } };
    if (typeof shared.data?.profileId !== 'string') throw new Error('Clone profile ID missing');
    await expect(manager.getStore().getCookies(shared.data.profileId)).resolves.toEqual([
      { name: 'session', value: 'secret', domain: 'example.com', path: '/' },
    ]);
  });

  it('filters profiles and follows an opaque cursor without duplicates', async () => {
    await Promise.all([
      manager.createProfile({ profileId: 'page_alpha', name: 'Alpha', tags: ['group-a'] }),
      manager.createProfile({ profileId: 'page_beta', name: 'Beta', tags: ['group-b'] }),
      manager.createProfile({ profileId: 'page_gamma', name: 'Gamma', tags: ['group-a'] }),
    ]);

    const firstResponse = await fetch(`${baseUrl}/api/v1/profiles?limit=2`);
    const first = await firstResponse.json() as {
      data: { items: Array<{ profileId: string }>; nextCursor: string | null; total: number };
    };
    expect(firstResponse.status).toBe(200);
    expect(first.data.items).toHaveLength(2);
    expect(first.data.total).toBe(3);
    expect(typeof first.data.nextCursor).toBe('string');

    const secondResponse = await fetch(
      `${baseUrl}/api/v1/profiles?limit=2&cursor=${encodeURIComponent(first.data.nextCursor!)}`,
    );
    const second = await secondResponse.json() as {
      data: { items: Array<{ profileId: string }>; nextCursor: string | null; total: number };
    };
    expect(second.data.items).toHaveLength(1);
    expect(new Set([...first.data.items, ...second.data.items].map((profile) => profile.profileId)).size).toBe(3);
    expect(second.data.nextCursor).toBeNull();

    const filteredResponse = await fetch(`${baseUrl}/api/v1/profiles?tag=group-b`);
    const filtered = await filteredResponse.json() as {
      data: { items: Array<{ profileId: string }>; total: number };
    };
    expect(filtered.data).toEqual({
      items: [expect.objectContaining({ profileId: 'page_beta' })],
      total: 1,
      nextCursor: null,
    });

    expect((await fetch(`${baseUrl}/api/v1/profiles?cursor=invalid`)).status).toBe(400);
  });

  it('submits and filters distributed crawl tasks through the Studio API', async () => {
    const submit = await fetch(`${baseUrl}/api/v1/cluster/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://example.com/catalog',
        projectId: 'catalog',
        runId: 'run-001',
        mode: 'fetch',
        priority: 'HIGH',
      }),
    });
    expect(submit.status).toBe(202);
    const submitted = await submit.json() as { data?: { id?: unknown } };
    if (typeof submitted.data?.id !== 'string') throw new Error('Task ID missing from submit response');

    const listed = await fetch(`${baseUrl}/api/v1/cluster/tasks?projectId=catalog&runId=run-001`);
    expect(listed.status).toBe(200);
    const listedJson = await listed.json() as { data?: Array<{ id?: unknown; projectId?: unknown; runId?: unknown }> };
    expect(listedJson.data).toEqual([expect.objectContaining({ id: submitted.data.id, tenantId: 'default', projectId: 'catalog', runId: 'run-001', url: 'https://example.com/catalog', mode: 'fetch', priority: 'HIGH', state: 'PENDING', retries: 0, maxRetries: 3, timeoutMs: 30_000, createdAt: expect.any(Number), events: [expect.objectContaining({ phase: 'queued', state: 'PENDING', message: '任务已排队' })] })]);

    const detail = await fetch(`${baseUrl}/api/v1/cluster/tasks/${encodeURIComponent(submitted.data.id)}`);
    expect(detail.status).toBe(200);
  });

  it('preflights task URLs, applies filters, paginates, and exposes safe task actions', async () => {
    const preflight = await fetch(`${baseUrl}/api/v1/cluster/tasks/preflight`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/catalog' }),
    });
    expect(preflight.status).toBe(200);
    expect((await preflight.json()).data).toMatchObject({ allowed: true, origin: 'https://example.com', policy: 'allow' });

    const denied = await fetch(`${baseUrl}/api/v1/cluster/tasks/preflight`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://private.example/catalog' }),
    });
    expect((await denied.json()).data).toMatchObject({ allowed: false, policy: 'deny' });

    const submit = await fetch(`${baseUrl}/api/v1/cluster/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/action', projectId: 'actions', mode: 'browser', priority: 'HIGH' }),
    });
    const task = (await submit.json()).data;
    const listed = await fetch(`${baseUrl}/api/v1/cluster/tasks?mode=browser&priority=HIGH&limit=1`);
    expect(listed.headers.get('X-Limit')).toBe('1');
    expect((await listed.json()).data[0]).toMatchObject({ id: task.id, mode: 'browser', priority: 'HIGH' });

    const cancelled = await fetch(`${baseUrl}/api/v1/cluster/tasks/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel', ids: [task.id] }),
    });
    expect((await cancelled.json()).data[0]).toMatchObject({ id: task.id, success: true, task: { state: 'CANCELLED' } });
    const detail = await fetch(`${baseUrl}/api/v1/cluster/tasks/${encodeURIComponent(task.id)}`);
    const detailJson = await detail.json();
    expect(detailJson.data.leaseId).toBeUndefined();
    expect(detailJson.data.events.at(-1)).toMatchObject({ phase: 'cancelled', state: 'CANCELLED' });
  });
});
