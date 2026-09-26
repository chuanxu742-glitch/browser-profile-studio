import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { SessionManager } from '../../src/browser/session-manager.js';
import { ProfileStore } from '../../src/profile/profile-store.js';
import { RestApiServer } from '../../src/api/server.js';
import { ProxyPoolStore } from '../../src/proxy/pool-store.js';
import { RpaService } from '../../src/rpa/service.js';
import { TeamAccessStore } from '../../src/team/access-store.js';
import { z } from 'zod';
import { SecretVault } from '../../src/security/secret-vault.js';

describe('Studio feature REST wiring', () => {
  let root: string;
  let manager: SessionManager;
  let api: RestApiServer;
  let rpa: RpaService;
  let tcp: TcpServer;
  let baseUrl: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'studio-features-'));
    manager = new SessionManager({ profileStore: new ProfileStore(join(root, 'profiles')), artifactsRoot: join(root, 'artifacts') });
    const vault = new SecretVault('0123456789abcdef0123456789abcdef');
    const proxyPool = new ProxyPoolStore(join(root, 'proxies.json'), vault);
    rpa = new RpaService(manager, join(root, 'rpa.json'));
    api = new RestApiServer(manager, { port: 0, host: '127.0.0.1', proxyPool, rpa });
    const address = await api.start();
    baseUrl = `http://${address.host}:${address.port}/api/v1`;
    tcp = createTcpServer((socket) => {
      // Drain probe bytes so the peer's FIN is consumed and close can complete.
      socket.resume();
      socket.end();
    });
    await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => tcp.close(() => resolve()));
    await rpa.shutdown();
    await api.stop();
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  it('connects profile update/clone, TCP-reachable proxy rotation and scheduled RPA lifecycle', async () => {
    const createProfile = await fetch(`${baseUrl}/profiles`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'source', twoFactorSecret: 'JBSWY3DPEHPK3PXP' }),
    }).then((response) => response.json()) as any;
    const profileId = createProfile.data.profileId as string;
    expect((await fetch(`${baseUrl}/profiles/${profileId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'updated', tags: ['US'] }),
    })).status).toBe(200);
    expect((await fetch(`${baseUrl}/profiles/${profileId}/clone`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'clone' }),
    })).status).toBe(201);
    const missingBatch = await fetch(`${baseUrl}/profiles/batch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start', profileIds: ['prf_missing'], headless: true }),
    });
    expect(missingBatch.status).toBe(200);
    expect(z.object({ data: z.array(z.object({ profileId: z.string(), success: z.boolean(), code: z.string(), message: z.string() })) }).parse(await missingBatch.json()).data)
      .toEqual([{ profileId: 'prf_missing', success: false, code: 'PROFILE_NOT_FOUND', message: 'Profile no longer exists; refresh the list' }]);

    const tcpAddress = tcp.address();
    const tcpPort = tcpAddress && typeof tcpAddress === 'object' ? tcpAddress.port : 0;
    const proxy = await fetch(`${baseUrl}/proxies`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'local', server: `http://127.0.0.1:${tcpPort}`, tags: ['US'] }),
    }).then((response) => response.json()) as any;
    const checked = z.object({ data: z.object({ health: z.string(), lastCheck: z.object({ verified: z.boolean() }) }) }).parse(
      await (await fetch(`${baseUrl}/proxies/${proxy.data.proxyId}/check`, { method: 'POST' })).json(),
    );
    expect(checked.data).toMatchObject({ health: 'reachable', lastCheck: { verified: false } });
    const rotated = await fetch(`${baseUrl}/profiles/${profileId}/rotate-proxy`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tags: ['US'] }),
    }).then((response) => response.json()) as any;
    expect(rotated.data.proxy.proxyId).toBe(proxy.data.proxyId);
    expect(rotated.data.profile.proxy.password).toBeUndefined();

    const workflow = await fetch(`${baseUrl}/rpa/workflows`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'first', steps: [{ op: 'snapshot' }] }),
    }).then((response) => response.json()) as any;
    expect((await fetch(`${baseUrl}/rpa/workflows/${workflow.data.workflowId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'updated workflow' }),
    })).status).toBe(200);
    const task = await fetch(`${baseUrl}/rpa/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: workflow.data.workflowId, profileId, scheduledAt: Date.now() + 60_000 }),
    }).then((response) => response.json()) as any;
    const cancelled = await fetch(`${baseUrl}/rpa/tasks/${task.data.taskId}/cancel`, { method: 'POST' }).then((response) => response.json()) as any;
    expect(cancelled.data.state).toBe('CANCELLED');
  });

  it('enforces team grants on RPA runs, task visibility, workflows and proxy lists', async () => {
    await api.stop();
    const team = new TeamAccessStore(join(root, 'team.json'));
    await team.init();
    api = new RestApiServer(manager, {
      port: 0, host: '127.0.0.1', rpa, teamAccess: team,
      proxyPool: new ProxyPoolStore(join(root, 'proxies.json'), new SecretVault('0123456789abcdef0123456789abcdef')),
      credentials: [{ token: 'test-owner', role: 'owner' }],
    });
    const address = await api.start();
    baseUrl = `http://${address.host}:${address.port}/api/v1`;
    const request = async (path: string, method = 'GET', body?: object, token = 'test-owner') => {
      const response = await fetch(`${baseUrl}${path}`, {
        method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, json: z.object({ success: z.boolean(), data: z.unknown().optional() }).parse(await response.json()) };
    };
    const id = (result: { json: { data?: unknown } }, field: string) =>
      z.string().parse(z.record(z.string(), z.unknown()).parse(result.json.data)[field]);
    const first = id(await request('/profiles', 'POST', { name: 'allowed' }), 'profileId');
    const second = id(await request('/profiles', 'POST', { name: 'private' }), 'profileId');
    const workflowId = id(await request('/rpa/workflows', 'POST', { name: 'snapshot', steps: [{ op: 'snapshot' }] }), 'workflowId');
    const hiddenWorkflowId = id(await request('/rpa/workflows', 'POST', { name: 'private', steps: [{ op: 'snapshot' }] }), 'workflowId');
    const proxyId = id(await request('/proxies', 'POST', { name: 'allowed', server: 'http://127.0.0.1:8890' }), 'proxyId');
    await request('/proxies', 'POST', { name: 'private', server: 'http://127.0.0.1:8891' });
    const workspaceId = id(await request('/team/workspaces', 'POST', { name: 'local' }), 'workspaceId');
    const memberId = id(await request('/team/members', 'POST', {
      workspaceId, name: 'operator', role: 'operator',
      grants: { profile: [first], workflow: [workflowId], proxy: [proxyId] },
    }), 'memberId');
    const issued = await request(`/team/members/${memberId}/api-keys`, 'POST', { label: 'test' });
    const token = id(issued, 'token');
    const keyId = id(issued, 'keyId');
    const scheduledAt = Date.now() + 60_000;
    expect((await request('/rpa/tasks', 'POST', { workflowId, profileId: second, scheduledAt }, token)).status).toBe(403);
    expect((await request('/rpa/tasks', 'POST', { workflowId: hiddenWorkflowId, profileId: first, scheduledAt }, token)).status).toBe(403);
    expect(z.array(z.unknown()).parse((await request('/rpa/tasks')).json.data)).toHaveLength(0);
    const queued = await request('/rpa/tasks', 'POST', { workflowId, profileId: first, scheduledAt }, token);
    expect(queued.status).toBe(202);
    expect(id(queued, 'profileId')).toBe(first);
    const hidden = await request('/rpa/tasks', 'POST', { workflowId: hiddenWorkflowId, profileId: first, scheduledAt });
    expect(hidden.status).toBe(202);
    expect(z.array(z.object({ taskId: z.string() })).parse((await request('/rpa/tasks', 'GET', undefined, token)).json.data).map(task => task.taskId)).toEqual([id(queued, 'taskId')]);
    expect((await request(`/rpa/tasks/${id(hidden, 'taskId')}`, 'GET', undefined, token)).status).toBe(403);
    expect((await request(`/rpa/tasks/${id(hidden, 'taskId')}/cancel`, 'POST', undefined, token)).status).toBe(403);
    expect(z.array(z.object({ workflowId: z.string() })).parse((await request('/rpa/workflows', 'GET', undefined, token)).json.data).map(item => item.workflowId)).toEqual([workflowId]);
    expect(z.array(z.object({ proxyId: z.string() })).parse((await request('/proxies', 'GET', undefined, token)).json.data).map(item => item.proxyId)).toEqual([proxyId]);
    expect((await request(`/team/api-keys/${keyId}/revoke`, 'POST')).status).toBe(200);
    expect((await request('/rpa/workflows', 'GET', undefined, token)).status).toBe(401);
  });
});
