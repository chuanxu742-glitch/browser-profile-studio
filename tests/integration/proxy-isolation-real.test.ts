import { createServer, request as httpRequest, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrowserContext } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import { launchPersistentChromium } from '../../src/browser/chromium-launcher.js';
import { launchPersistentFirefox } from '../../src/browser/firefox-launcher.js';
import { generateFingerprint } from '../../src/fingerprint/generator.js';
import { buildStealthInjectionScript } from '../../src/fingerprint/stealth-scripts.js';
import { RawCdpConnection } from '../../src/browser/raw-cdp-connection.js';

// Reserved .invalid names cannot resolve locally. A successful load proves that
// this fixture's proxy resolved the destination; it does not certify public DNS.
describe('browser proxy transport isolation', () => {
  const scenarios = (['chromium', 'firefox'] as const).flatMap(engine =>
    ['127.0.0.1', '::1'].map(host => ({ engine, host, username: 'fixture' })));
  scenarios.push({ engine: 'chromium', host: '127.0.0.1', username: '' });
  for (const { engine, host, username } of scenarios) {
    it(`${engine} ${host}${username === '' ? ' password-only' : ''} routes navigation, scripts and workers through the proxy and never falls back to direct`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'proxy-isolation-'));
      const hits: string[] = [];
      const proxyHits: string[] = [];
      const origin = createServer((request, response) => {
        const url = request.url ?? '/';
        hits.push(url);
        if (url.endsWith('.js')) {
          response.setHeader('content-type', 'application/javascript');
          response.end(url === '/worker.js'
            ? "fetch('/worker-fetch').then(r=>r.text()).then(postMessage);"
            : url === '/service-worker.js'
              ? "self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));self.addEventListener('message',event=>event.waitUntil(fetch(event.data).then(r=>r.text()).catch(()=>'proxy-failed').then(value=>event.ports[0].postMessage(value))));"
              : 'window.scriptLoaded=true;');
        } else if (url === '/worker-fetch' || url === '/service-worker-fetch') response.end('through-proxy');
        else { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><script src="/script.js"></script><body>proxy fixture</body>'); }
      });
      let context: BrowserContext | undefined;
      let proxy: Server | undefined;
      const sockets = new Set<Socket>();
      try {
        await new Promise<void>((resolve, reject) => { origin.once('error', reject); origin.listen(0, host, resolve); });
        const originAddress = origin.address();
        if (!originAddress || typeof originAddress === 'string') throw new Error('Origin did not bind');
        const originPort = originAddress.port;
        let enabled = true;
        const authorization = `Basic ${Buffer.from(`${username}:secret`).toString('base64')}`;
        proxy = createServer((request, response) => {
          if (!enabled) { request.socket.destroy(); return; }
          if (request.headers['proxy-authorization'] !== authorization) {
            response.writeHead(407, { 'proxy-authenticate': 'Basic realm="fixture"' }); response.end(); return;
          }
          const target = new URL(request.url!, 'http://fixture.invalid');
          proxyHits.push(target.pathname + target.search);
          const headers = { ...request.headers };
          delete headers['proxy-authorization'];
          const upstream = httpRequest({ hostname: host, port: originPort, path: target.pathname + target.search, method: request.method, headers }, incoming => {
            response.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(response);
          });
          upstream.on('error', () => response.destroy()); request.pipe(upstream);
        });
        proxy.on('connect', (request, client, head) => {
          if (!enabled) { client.destroy(); return; }
          if (request.headers['proxy-authorization'] !== authorization) {
            client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="fixture"\r\nContent-Length: 0\r\n\r\n'); return;
          }
          const upstream = connect(originPort, host, () => {
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length) upstream.write(head);
            client.pipe(upstream); upstream.pipe(client);
          });
          upstream.on('error', () => client.destroy());
          client.on('error', () => upstream.destroy());
          client.on('close', () => upstream.destroy());
        });
        proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
        await new Promise<void>(resolve => proxy!.listen(0, '127.0.0.1', resolve));
        const proxyAddress = proxy.address();
        if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('Proxy did not bind');
        const profile = generateFingerprint({ seed: 42, engine, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
        // The adapter returns the real Playwright context, narrowed for production DI.
        context = await (engine === 'chromium' ? launchPersistentChromium : launchPersistentFirefox)(root, {
          headless: true, proxy: { server: `http://127.0.0.1:${proxyAddress.port}`, username, password: 'secret' },
          fingerprintProfile: profile, userAgent: profile.userAgent, locale: profile.geo.locale,
          timezoneId: profile.geo.timezoneId, initScript: buildStealthInjectionScript(profile),
        }) as unknown as BrowserContext;
        const page = await context.newPage();
        await context.route('**/*', route => route.continue());
        await page.goto(`http://fixture.invalid:${originPort}/`);
        expect(await page.evaluate(() => 'scriptLoaded' in window && window.scriptLoaded === true)).toBe(true);
        const workerResult = await page.evaluate(() => new Promise<unknown>((resolve, reject) => {
          const worker = new Worker('/worker.js');
          worker.onmessage = event => { worker.terminate(); resolve(event.data); };
          worker.onerror = event => { worker.terminate(); reject(new Error(event.message)); };
        }));
        expect(workerResult).toBe('through-proxy');
        expect(hits).toEqual(expect.arrayContaining(['/', '/script.js', '/worker.js', '/worker-fetch']));
        expect(proxyHits).toEqual(expect.arrayContaining(['/', '/script.js', '/worker.js', '/worker-fetch']));
        if (engine === 'chromium') {
          await context.unroute('**/*');
          await page.waitForLoadState('networkidle');
          const send = RawCdpConnection.prototype.send;
          let interceptNext = true;
          let finish!: (error: unknown) => void;
          const continuationResult = new Promise<unknown>(resolve => { finish = resolve; });
          let resume!: () => void;
          const resumeContinuation = new Promise<void>(resolve => { resume = resolve; });
          let markPaused!: () => void;
          const requestPaused = new Promise<void>(resolve => { markPaused = resolve; });
          // Delay the real native continuation so AbortController deterministically
          // removes its interception job first; the browser itself is not mocked.
          const delayed = vi.spyOn(RawCdpConnection.prototype, 'send').mockImplementation(async function (this: RawCdpConnection, method, params, sessionId, timeoutMs) {
            if (interceptNext && method === 'Fetch.continueRequest') {
              interceptNext = false;
              markPaused();
              await resumeContinuation;
              try {
                const result = await send.call(this, method, params, sessionId, timeoutMs);
                finish(undefined);
                return result;
              } catch (error) { finish(error); throw error; }
            }
            return send.call(this, method, params, sessionId, timeoutMs);
          });
          try {
            const cancelledFetch = page.evaluate(() => {
              const controller = new AbortController();
              Object.assign(window, { proxyAbort: controller });
              return fetch('/cancelled', { signal: controller.signal }).catch(error => error.name);
            });
            await requestPaused;
            await page.evaluate(() => {
              if (!('proxyAbort' in window) || !(window.proxyAbort instanceof AbortController)) throw new Error('Missing cancellation controller');
              window.proxyAbort.abort();
            });
            expect(await cancelledFetch).toBe('AbortError');
            resume();
            expect(await continuationResult).toMatchObject({ message: 'Invalid InterceptionId.' });
            await page.reload();
            expect(hits).not.toContain('/cancelled');
          } finally {
            resume();
            delayed.mockRestore();
          }
        }
        // Loopback is intentionally included: native implicit bypasses must not
        // silently route a configured proxy session directly to this origin.
        const directOrigin = `http://${host === '::1' ? '[::1]' : host}:${originPort}`;
        await page.goto(`${directOrigin}/before-failure`);
        const serviceWorkerResult = await page.evaluate(async () => {
          await navigator.serviceWorker.register('/service-worker.js');
          const registration = await navigator.serviceWorker.ready;
          const channel = new MessageChannel();
          const response = new Promise<unknown>(resolve => { channel.port1.onmessage = event => { channel.port1.close(); resolve(event.data); }; });
          registration.active!.postMessage('/service-worker-fetch', [channel.port2]);
          return response;
        });
        expect(serviceWorkerResult).toBe('through-proxy');
        expect(proxyHits).toEqual(expect.arrayContaining(['/before-failure', '/service-worker.js', '/service-worker-fetch']));
        enabled = false;
        for (const socket of sockets) socket.destroy();
        const previousHits = hits.length;
        const workerFailure = await page.evaluate(async () => {
          const registration = await navigator.serviceWorker.ready;
          const channel = new MessageChannel();
          const response = new Promise<unknown>(resolve => { channel.port1.onmessage = event => { channel.port1.close(); resolve(event.data); }; });
          registration.active!.postMessage('/service-worker-failure', [channel.port2]);
          return response;
        });
        expect(workerFailure).toBe('proxy-failed');
        expect(hits.slice(previousHits)).not.toContain('/service-worker-failure');
        await expect(page.goto(`${directOrigin}/must-not-connect-directly`, { timeout: 5000 })).rejects.toThrow();
        expect(hits.slice(previousHits)).not.toContain('/must-not-connect-directly');
      } finally {
        await context?.close();
        for (const socket of sockets) socket.destroy();
        if (proxy) await new Promise<void>(resolve => proxy!.close(() => resolve()));
        await new Promise<void>(resolve => origin.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    }, 45_000);
  }
});
