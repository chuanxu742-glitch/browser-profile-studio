import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProxyPoolStore } from '../../src/proxy/pool-store.js';
import { SecretVault } from '../../src/security/secret-vault.js';
import { createServer } from 'node:net';
import type { ProxyCheckResult } from '../../src/proxy/types.js';

describe('ProxyPoolStore', () => {
  let root: string | undefined;
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

  it('persists encrypted credentials but excludes TCP-only endpoints from rotation', async () => {
    root = await mkdtemp(join(tmpdir(), 'proxy-pool-'));
    const path = join(root, 'pool.json');
    const pool = new ProxyPoolStore(path, new SecretVault('0123456789abcdef0123456789abcdef'));
    const tcpServer = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => tcpServer.listen(0, '127.0.0.1', resolve));
    const address = tcpServer.address();
    const port = address && typeof address === 'object' ? address.port : 0;
    const first = await pool.create({ name: 'one', server: `http://127.0.0.1:${port}`, username: 'alice', password: 'top-secret', tags: ['US'] });
    const second = await pool.create({ name: 'two', server: `socks5://127.0.0.1:${port}`, tags: ['US'] });
    await pool.check(first.proxyId);
    await pool.check(second.proxyId);
    await new Promise<void>((resolve, reject) => tcpServer.close((error) => error ? reject(error) : resolve()));
    expect(await readFile(path, 'utf8')).not.toContain('top-secret');
    expect((await pool.get(first.proxyId))?.password).toBe('top-secret');
    expect(await pool.next(['US'])).toBeUndefined();
    await pool.update(first.proxyId, { enabled: false });
    expect(await pool.next(['US'])).toBeUndefined();
    expect(await pool.delete(second.proxyId)).toBe(true);
    expect(await pool.next(['US'])).toBeUndefined();
  });

  it.each(['update', 'delete'] as const)('does not apply an old egress probe after a concurrent %s', async action => {
    root = await mkdtemp(join(tmpdir(), 'proxy-pool-'));
    let release!: (result: ProxyCheckResult) => void;
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const pool = new ProxyPoolStore(join(root, 'pool.json'), undefined, Date.now, () => {
      markStarted();
      return new Promise(resolve => { release = resolve; });
    });
    const proxy = await pool.create({ server: 'http://127.0.0.1:8080', username: 'alice', password: 'secret', bypass: 'localhost' });
    const checking = pool.check(proxy.proxyId);
    await started;
    if (action === 'delete') await pool.delete(proxy.proxyId);
    else await pool.update(proxy.proxyId, { server: 'http://127.0.0.1:8081', username: '', password: '', bypass: '', enabled: false });
    release({ success: true, verified: true, checkLevel: 'egress', outboundIp: '203.0.113.9', server: proxy.server, proxyType: 'http' });
    if (action === 'delete') {
      await expect(checking).rejects.toThrow('PROXY_NOT_FOUND');
      expect(await pool.get(proxy.proxyId)).toBeUndefined();
    } else {
      const updated = await checking;
      expect(updated).toMatchObject({ server: 'http://127.0.0.1:8081', enabled: false });
      expect(updated.username).toBeUndefined();
      expect(updated.password).toBeUndefined();
      expect(updated.bypass).toBeUndefined();
      expect(updated.lastCheck).toBeUndefined();
    }
    expect(await pool.next()).toBeUndefined();
  });

  it('requires two consecutive verified probes after cooldown and invalidates verification on credential changes', async () => {
    root = await mkdtemp(join(tmpdir(), 'proxy-pool-'));
    let now = 1000;
    const verified: ProxyCheckResult = { success: true, verified: true, checkLevel: 'egress', outboundIp: '203.0.113.9', server: 'http://127.0.0.1:8080', proxyType: 'http' };
    let result = verified;
    const pool = new ProxyPoolStore(join(root, 'pool.json'), undefined, () => now, async () => result);
    const proxy = await pool.create({ server: verified.server, password: 'old' });
    await pool.check(proxy.proxyId);
    expect((await pool.next())?.proxyId).toBe(proxy.proxyId);
    result = { ...verified, success: false, verified: false, checkLevel: 'none' };
    await pool.check(proxy.proxyId); await pool.check(proxy.proxyId); await pool.check(proxy.proxyId);
    now += 5 * 60 * 1000;
    for (const checkLevel of ['connectivity', 'handshake'] as const) {
      result = { ...verified, verified: false, checkLevel };
      await pool.check(proxy.proxyId);
      expect(await pool.next()).toBeUndefined();
      expect((await pool.get(proxy.proxyId))?.quarantineUntil).toBeDefined();
    }
    result = verified;
    await pool.check(proxy.proxyId);
    expect(await pool.next()).toBeUndefined();
    result = { ...verified, verified: false, checkLevel: 'handshake' };
    await pool.check(proxy.proxyId);
    result = verified;
    await pool.check(proxy.proxyId);
    expect(await pool.next()).toBeUndefined();
    await pool.check(proxy.proxyId);
    expect((await pool.next())?.proxyId).toBe(proxy.proxyId);
    await pool.update(proxy.proxyId, { name: 'metadata only' });
    expect((await pool.next())?.proxyId).toBe(proxy.proxyId);
    await pool.update(proxy.proxyId, { password: 'new' });
    expect(await pool.next()).toBeUndefined();
    await pool.check(proxy.proxyId);
    expect((await pool.next())?.password).toBe('new');
  });

  it('handles proxy quarantine, cooldown, recovery and persistence', async () => {
    root = await mkdtemp(join(tmpdir(), 'proxy-pool-'));
    const path = join(root, 'pool2.json');
    let currentTime = 1_000_000;
    let checkSuccess = true;
    const clock = () => currentTime;
    const checker = async () => ({ success: checkSuccess, verified: checkSuccess, server: 'mock', proxyType: 'http' as const });
    let pool = new ProxyPoolStore(path, undefined, clock, checker);
    const p1 = await pool.create({ name: 'p1', server: 'http://127.0.0.1:8080', tags: ['EU'] });
    const p2 = await pool.create({ name: 'p2', server: 'http://127.0.0.1:8081', tags: ['EU'] });

    await pool.check(p1.proxyId);
    await pool.check(p2.proxyId);
    expect(new Set([(await pool.next(['EU']))?.proxyId, (await pool.next(['EU']))?.proxyId]))
      .toEqual(new Set([p1.proxyId, p2.proxyId]));

    checkSuccess = false;
    await pool.check(p1.proxyId);
    await pool.check(p1.proxyId);
    await pool.check(p1.proxyId);
    expect((await pool.next(['EU']))?.proxyId).toBe(p2.proxyId);

    currentTime += 5 * 60 * 1_000;
    checkSuccess = true;
    await pool.check(p1.proxyId);
    expect((await pool.next(['EU']))?.proxyId).toBe(p2.proxyId);
    await pool.check(p1.proxyId);
    expect(new Set([(await pool.next(['EU']))?.proxyId, (await pool.next(['EU']))?.proxyId]).has(p1.proxyId))
      .toBe(true);

    checkSuccess = false;
    await pool.check(p1.proxyId);
    await pool.check(p1.proxyId);
    await pool.check(p1.proxyId);
    await pool.check(p1.proxyId);
    pool = new ProxyPoolStore(path, undefined, clock, checker);
    expect((await pool.next(['EU']))?.proxyId).toBe(p2.proxyId);

    currentTime += 5 * 60 * 1_000;
    expect((await pool.next(['EU']))?.proxyId).toBe(p2.proxyId);
    currentTime += 5 * 60 * 1_000;
    checkSuccess = true;
    await pool.check(p1.proxyId);
    await pool.check(p1.proxyId);
    expect(new Set([(await pool.next(['EU']))?.proxyId, (await pool.next(['EU']))?.proxyId]).has(p1.proxyId))
      .toBe(true);

    checkSuccess = false;
    await pool.check(p1.proxyId);
    checkSuccess = true;
    await pool.check(p1.proxyId);
    expect(new Set([(await pool.next(['EU']))?.proxyId, (await pool.next(['EU']))?.proxyId]).has(p1.proxyId))
      .toBe(true);
  });
});