import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProxyPoolStore } from '../../src/proxy/pool-store.js';
import { SecretVault } from '../../src/security/secret-vault.js';
import { createServer } from 'node:net';

describe('ProxyPoolStore', () => {
  let root: string | undefined;
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

  it('persists encrypted credentials and rotates enabled matching records', async () => {
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
    const rotated = [(await pool.next(['US']))?.proxyId, (await pool.next(['US']))?.proxyId];
    expect(new Set(rotated)).toEqual(new Set([first.proxyId, second.proxyId]));
    await pool.update(first.proxyId, { enabled: false });
    expect((await pool.next(['US']))?.proxyId).toBe(second.proxyId);
    expect(await pool.delete(second.proxyId)).toBe(true);
    expect(await pool.next(['US'])).toBeUndefined();
  });

  it('handles proxy quarantine, cooldown, recovery and persistence', async () => {
    root = await mkdtemp(join(tmpdir(), 'proxy-pool-'));
    const path = join(root, 'pool2.json');
    let currentTime = 1_000_000;
    let checkSuccess = true;
    const clock = () => currentTime;
    const checker = async () => ({ success: checkSuccess, server: 'mock', proxyType: 'http' as const });
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