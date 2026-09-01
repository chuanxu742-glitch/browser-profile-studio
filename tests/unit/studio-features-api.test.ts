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
    tcp = createTcpServer((socket) => socket.end());
    await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => tcp.close(() => resolve()));
    await rpa.shutdown();
    await api.stop();
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  it('connects profile update/clone, healthy proxy rotation and scheduled RPA lifecycle', async () => {
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

    const tcpAddress = tcp.address();
    const tcpPort = tcpAddress && typeof tcpAddress === 'object' ? tcpAddress.port : 0;
    const proxy = await fetch(`${baseUrl}/proxies`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'local', server: `http://127.0.0.1:${tcpPort}`, tags: ['US'] }),
    }).then((response) => response.json()) as any;
    expect((await fetch(`${baseUrl}/proxies/${proxy.data.proxyId}/check`, { method: 'POST' })).status).toBe(200);
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
});
