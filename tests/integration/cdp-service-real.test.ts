import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { startCdpService } from '../../src/cdp/service.js';

const real = process.env.RUN_CDP_SMOKE === '1' || process.env.npm_lifecycle_event === 'test:cdp' ? describe : describe.skip;
real('CDP service', () => {
  it('authenticates, drives the persistent context, reconnects and restores cookies after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cdp-service-'));
    const token = 'test-cdp-token-with-at-least-24-characters';
    const env = { CDP_PROFILE_DIR: root, CDP_HOST: '127.0.0.1', CDP_PORT: '0', CDP_TOKEN: token,
      CDP_COUNTRY: 'JP', CDP_OS: 'linux', CDP_SEED: '31337', CDP_MAX_CONNECTIONS: '1' };
    const fixture = createServer((req, res) => { res.setHeader('content-type', 'text/html');
      res.end('<input><button onclick="document.title=document.querySelector(\'input\').value">Save</button>'); });
    await new Promise<void>(r => fixture.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${(fixture.address() as any).port}`;
    let service;
    let browser;
    try {
      service = await startCdpService(env);
      const endpoint = `http://127.0.0.1:${service.port}`;
      expect((await fetch(`${endpoint}/json/version`)).status).toBe(401);
      expect((await fetch(`${endpoint}/status`)).status).toBe(401);
      await expect(chromium.connectOverCDP(`${endpoint.replace('http:', 'ws:')}/cdp`, { timeout: 2000 })).rejects.toThrow();
      browser = await chromium.connectOverCDP(endpoint, { headers: { Authorization: `Bearer ${token}` }, noDefaults: true });
      const status = await (await fetch(`${endpoint}/status`, { headers: { Authorization: `Bearer ${token}` } })).json();
      expect(status).toMatchObject({ ready: true, connections: 1, maxConnections: 1, configured: { seed: 31337 } });
      expect(JSON.stringify(status)).not.toContain(token);
      await expect(chromium.connectOverCDP(endpoint, { headers: { Authorization: `Bearer ${token}` }, timeout: 2000 })).rejects.toThrow('429');
      const context = browser.contexts()[0]!;
      const page = await context.newPage();
      await page.goto(origin);
      await page.locator('input').fill('CDP connected');
      await page.getByRole('button').click();
      expect(await page.title()).toBe('CDP connected');
      expect(await page.evaluate(() => ({ language: navigator.language, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })))
        .toEqual({ language: 'ja-JP', timezone: 'Asia/Tokyo' });
      expect((await page.screenshot()).byteLength).toBeGreaterThan(100);
      await context.addCookies([{ name: 'persist', value: 'yes', url: origin, expires: Date.now() / 1000 + 3600 }]);
      await browser.close(); browser = undefined;
      await expect.poll(async () => (await (await fetch(`${endpoint}/status`, { headers: { Authorization: `Bearer ${token}` } })).json()).connections).toBe(0);
      expect((await fetch(`${endpoint}/health`)).status).toBe(200);
      await service.stop(); service = undefined;
      await expect(startCdpService({ ...env, CDP_SEED: '2' })).rejects.toThrow('CDP_PROFILE_CONFIG_CONFLICT:seed');
      service = await startCdpService(env);
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${service.port}`, { headers: { Authorization: `Bearer ${token}` } });
      expect((await browser.contexts()[0]!.cookies(origin)).find(c => c.name === 'persist')?.value).toBe('yes');
      await service.stop();
      await expect.poll(() => browser!.isConnected()).toBe(false);
    } finally {
      await browser?.close();
      await service?.stop();
      await new Promise<void>(r => fixture.close(() => r()));
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 45000);

  it('releases the profile after a port collision and stops when the browser exits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cdp-lifecycle-'));
    const occupied = createServer();
    await new Promise<void>(r => occupied.listen(0, '127.0.0.1', r));
    const env = { CDP_PROFILE_DIR: root, CDP_HOST: '127.0.0.1', CDP_PORT: String((occupied.address() as any).port) };
    let service;
    let browser;
    try {
      await expect(startCdpService(env)).rejects.toMatchObject({ code: 'EADDRINUSE' });
      service = await startCdpService({ ...env, CDP_PORT: '0' });
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${service.port}`);
      const cdp = await browser.newBrowserCDPSession();
      await cdp.send('Browser.close').catch(() => undefined);
      await service.closed;
      await expect.poll(() => browser!.isConnected()).toBe(false);
    } finally {
      await browser?.close();
      await service?.stop();
      await new Promise<void>(r => occupied.close(() => r()));
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 45000);
});
