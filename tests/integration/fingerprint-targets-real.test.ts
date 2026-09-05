import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserContext } from 'playwright';
import { launchPersistentChromium } from '../../src/browser/chromium-launcher.js';
import { launchPersistentFirefox } from '../../src/browser/firefox-launcher.js';
import { generateFingerprint, HOST_OS } from '../../src/fingerprint/generator.js';
import { buildStealthInjectionScript } from '../../src/fingerprint/stealth-scripts.js';

const snapshotSource = `(() => ({userAgent:navigator.userAgent,appVersion:navigator.appVersion,platform:navigator.platform,hardwareConcurrency:navigator.hardwareConcurrency,...('deviceMemory' in navigator?{deviceMemory:navigator.deviceMemory}:{}),language:navigator.language,languages:Array.from(navigator.languages),locale:Intl.DateTimeFormat().resolvedOptions().locale,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,offset:new Date(2026,0,1).getTimezoneOffset()}))()`;

describe('pre-execution fingerprint identity and native network policy', () => {
  let server: Server;
  let origin: string;
  const requests: Array<{ url: string; headers: Record<string, string | string[] | undefined> }> = [];
  beforeAll(async () => {
    server = createServer((request, response) => {
      const url = request.url ?? '/';
      requests.push({ url, headers: request.headers });
      response.setHeader('cache-control', 'no-store');
      if (url.endsWith('.js')) {
        response.setHeader('content-type', 'application/javascript');
        if (url === '/shared.js') response.end(`const identity=${snapshotSource};onconnect=e=>e.ports[0].postMessage(JSON.stringify(identity));`);
        else if (url === '/service.js') response.end(`const identity=${snapshotSource};self.addEventListener('install',e=>e.waitUntil(skipWaiting()));self.addEventListener('activate',e=>e.waitUntil(clients.claim()));self.addEventListener('message',e=>e.ports[0].postMessage(JSON.stringify(identity)));`);
        else if (url === '/worker.js') response.end(`importScripts('/import.js');postMessage(JSON.stringify(${snapshotSource}));`);
        else if (url === '/module.js') response.end(`import './import.js';postMessage(JSON.stringify(${snapshotSource}));`);
        else if (url === '/first.js') response.end(`globalThis.initialIdentity=${snapshotSource};`);
        else response.end('/* relative import preserves the original worker URL */');
      } else {
        response.setHeader('content-type', 'text/html');
        response.setHeader('accept-ch', 'Sec-CH-UA-Platform, Sec-CH-UA-Full-Version-List');
        response.setHeader('content-security-policy', "script-src 'self'; worker-src 'self' blob:");
        response.end('<!doctype html><script src="/first.js"></script><body>Target lifecycle fixture</body>');
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
    origin = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

  it('rejects a formatting locale unavailable to stock Firefox Service Workers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'firefox-locale-boundary-'));
    try {
      const profile = generateFingerprint({ seed: 42, engine: 'firefox', locale: 'de-DE', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      await expect(launchPersistentFirefox(root, { headless: true, fingerprintProfile: profile })).rejects.toThrow('FIREFOX_LOCALE_UNSUPPORTED');
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 30_000);

  for (const engine of ['chromium', 'firefox'] as const) for (const headless of [true, false]) {
    it(`${engine} ${headless ? 'headless' : 'headed'} configures first-script identities without changing messages or imports`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'fingerprint-targets-'));
      const timezone = engine === 'chromium' ? 'Asia/Tokyo' : Intl.DateTimeFormat().resolvedOptions().timeZone;
      const profile = generateFingerprint({ seed: 91234, engine, os: HOST_OS, timezone });
      let context: BrowserContext | undefined;
      try {
        // The launch adapter is deliberately narrower than Playwright's test surface.
        context = await (engine === 'chromium' ? launchPersistentChromium : launchPersistentFirefox)(root, {
          headless, fingerprintProfile: profile, userAgent: profile.userAgent,
          timezoneId: profile.geo.timezoneId, locale: profile.geo.locale,
          initScript: buildStealthInjectionScript(profile),
        }) as unknown as BrowserContext;
        const page = await context.newPage();
        await page.goto(origin);
        const identity: unknown = await page.evaluate(snapshotSource);
        expect(identity).toMatchObject({ userAgent: profile.userAgent, platform: profile.platform, hardwareConcurrency: profile.hardware.hardwareConcurrency, timezone: profile.geo.timezoneId, locale: profile.geo.locale });
        expect(await page.evaluate('globalThis.initialIdentity')).toEqual(identity);
        const workers: unknown[] = await page.evaluate(async (source) => {
          const results: unknown[] = [];
          const blob = URL.createObjectURL(new Blob([`postMessage(JSON.stringify(${source}));`], { type: 'application/javascript' }));
          try {
            for (const [url, type] of [['/worker.js', 'classic'], ['/module.js', 'module'], [blob, 'classic']] as const) {
              results.push(await new Promise<unknown>((resolve, reject) => {
                const worker = new Worker(url, { type });
                worker.onmessage = event => { worker.terminate(); resolve(JSON.parse(event.data)); };
                worker.onerror = event => { worker.terminate(); reject(new Error(event.message)); };
              }));
            }
            results.push(await new Promise<unknown>((resolve, reject) => {
              const shared = new SharedWorker('/shared.js');
              shared.port.onmessage = event => { shared.port.close(); resolve(JSON.parse(event.data)); };
              shared.onerror = event => reject(new Error(event.message));
            }));
            const registration = await navigator.serviceWorker.register('/service.js');
            await navigator.serviceWorker.ready;
            results.push(await new Promise<unknown>((resolve) => {
              const channel = new MessageChannel();
              channel.port1.onmessage = event => { channel.port1.close(); resolve(JSON.parse(event.data)); };
              registration.active!.postMessage('identity', [channel.port2]);
            }));
            await registration.unregister();
            return results;
          } finally { URL.revokeObjectURL(blob); }
        }, snapshotSource);
        for (const [index, worker] of workers.entries()) expect(worker, ['URL worker', 'module worker', 'Blob worker', 'SharedWorker', 'ServiceWorker'][index]).toEqual(identity);
        const [popup] = await Promise.all([
          page.waitForEvent('popup'),
          page.evaluate(url => { window.open(url); }, `${origin}/popup`),
        ]);
        await popup.waitForLoadState('domcontentloaded');
        expect(await popup.evaluate(snapshotSource)).toEqual(identity);
        expect(await popup.evaluate('globalThis.initialIdentity')).toEqual(identity);
        const frameUrl = `${origin.replace('127.0.0.1', 'localhost')}/cross-site`;
        const [frame] = await Promise.all([
          page.waitForEvent('framenavigated', frame => frame.url() === frameUrl),
          page.evaluate(url => { const frame = document.createElement('iframe'); frame.src = url; document.body.append(frame); }, frameUrl),
        ]);
        await frame.waitForLoadState('domcontentloaded');
        expect(await frame.evaluate('globalThis.initialIdentity')).toEqual(identity);
        expect(await page.evaluate(() => {
          try { return document.querySelector('iframe')!.contentWindow!.navigator.userAgent; }
          catch (error) { return error instanceof Error ? error.name : String(error); }
        })).toBe('SecurityError');
        if (engine === 'chromium') {
          const debuggerSession = await context.browser()!.newBrowserCDPSession();
          const { targetInfos } = await debuggerSession.send('Target.getTargets');
          expect(targetInfos.some(target => target.type === 'iframe' && target.url === frameUrl)).toBe(true);
          await debuggerSession.detach();
        }
        const popupHeaders = requests.filter(request => request.url === '/popup').at(-1)?.headers;
        expect(popupHeaders?.['user-agent']).toBe(profile.userAgent);
        await page.reload();
        expect(await page.evaluate(snapshotSource)).toEqual(identity);
        const rtc = await page.evaluate(async () => {
          const pc = new RTCPeerConnection(Object.freeze({
            iceTransportPolicy: 'all',
            get unused() { throw new Error('Native dictionaries must not inspect unknown keys'); },
          }));
          pc.setConfiguration(Object.freeze({ iceTransportPolicy: 'all' }));
          const failure = (operation: () => unknown): string => {
            try { operation(); return 'accepted'; }
            catch (error) { return error instanceof Error ? error.name : String(error); }
          };
          const invalidConstructor = failure(() => Reflect.construct(RTCPeerConnection, [17]));
          const invalidPolicy = failure(() => Reflect.construct(RTCPeerConnection, [{ iceTransportPolicy: 'invalid' }]));
          const missingConfiguration = failure(() => Reflect.apply(pc.setConfiguration, pc, []));
          const received: string[] = [];
          const listener = (event: RTCPeerConnectionIceEvent) => { if (event.candidate) received.push(event.candidate.candidate); };
          pc.addEventListener('icecandidate', listener);
          for (const ip of ['192.168.1.2', '10.1.2.3', '172.16.1.2', '127.0.0.1', 'fe80::1']) {
            pc.dispatchEvent(new RTCPeerConnectionIceEvent('icecandidate', { candidate: new RTCIceCandidate({ candidate: `candidate:1 1 udp 2122260223 ${ip} 55555 typ host`, sdpMid: '0' }) }));
          }
          pc.removeEventListener('icecandidate', listener);
          pc.dispatchEvent(new RTCPeerConnectionIceEvent('icecandidate', { candidate: new RTCIceCandidate({ candidate: 'candidate:1 1 udp 1 203.0.113.1 55555 typ relay', sdpMid: '0' }) }));
          pc.createDataChannel('fixture');
          const offer = await pc.createOffer();
          const policy = pc.getConfiguration().iceTransportPolicy;
          pc.close();
          return { received, policy, offer: offer.sdp, constructorAligned: RTCPeerConnection.prototype.constructor === RTCPeerConnection, invalidConstructor, invalidPolicy, missingConfiguration };
        });
        expect(rtc.received).toEqual([]);
        expect(rtc.policy).toBe('relay');
        expect(rtc.constructorAligned).toBe(true);
        expect([rtc.invalidConstructor, rtc.invalidPolicy, rtc.missingConfiguration]).toEqual(['TypeError', 'TypeError', 'accepted']);
        expect(rtc.offer).not.toMatch(/192\.168\.1\.2|10\.1\.2\.3/);
      } finally {
        try { await context?.close(); }
        finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
      }
    }, 60_000);
  }
});
