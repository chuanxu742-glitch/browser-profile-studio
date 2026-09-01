import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchPersistentChromium } from '../../src/browser/chromium-launcher.js';
import { launchPersistentFirefox } from '../../src/browser/firefox-launcher.js';
import { generateFingerprint } from '../../src/fingerprint/generator.js';
import { managedBrowserIdentity } from '../../src/fingerprint/runtime-identity.js';
import { buildStealthInjectionScript } from '../../src/fingerprint/stealth-scripts.js';

const shouldRun = process.env.RUN_FINGERPRINT_RUNTIME_SMOKE === '1'
  || process.env.npm_lifecycle_event === 'test:fingerprint-runtime';
const realRuntime = shouldRun ? describe : describe.skip;

realRuntime('real managed fingerprint runtime identity', () => {
  let server: Server;
  let origin: string;
  const requests: Array<{ url: string; headers: Record<string, string | string[] | undefined> }> = [];

  beforeAll(async () => {
    server = createServer((_request, response) => {
      requests.push({ url: _request.url ?? '/', headers: _request.headers });
      if (_request.url === '/sw.js') {
        response.writeHead(200, {
          'content-type': 'application/javascript; charset=utf-8',
          'service-worker-allowed': '/',
        });
        response.end(`addEventListener('message', async (event) => {
          await fetch('/from-service-worker');
          const data = navigator.userAgentData;
          event.ports[0].postMessage({
            userAgent: navigator.userAgent,
            appVersion: navigator.appVersion,
            platform: navigator.platform,
            languages: Array.from(navigator.languages),
            hardwareConcurrency: navigator.hardwareConcurrency,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            uaDataPlatform: data && data.platform,
            highEntropy: data && await data.getHighEntropyValues(['uaFullVersion']),
          });
        });`);
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'accept-ch': 'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Full-Version, Sec-CH-UA-Platform-Version, Sec-CH-UA-Arch, Sec-CH-UA-Bitness, Sec-CH-UA-Model, Sec-CH-UA-WoW64, Sec-CH-UA-Form-Factors',
      });
      response.end('<!doctype html><title>runtime identity</title>');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture server did not bind');
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  for (const engine of ['firefox', 'chromium'] as const) {
    it(`keeps ${engine} core version, UA and exposed capabilities aligned`, async () => {
      const root = await mkdtemp(join(tmpdir(), `fingerprint-${engine}-`));
      const os = engine === 'chromium' ? 'linux' : 'windows';
      const fingerprint = generateFingerprint({ seed: 20260901, engine, os, countryCode: 'US' });
      const launch = engine === 'firefox' ? launchPersistentFirefox : launchPersistentChromium;
      const context = await launch(join(root, 'profile'), {
        headless: true,
        viewport: fingerprint.viewport,
        timezoneId: fingerprint.geo.timezoneId,
        locale: fingerprint.geo.locale,
        geolocation: fingerprint.geo.geolocation,
        permissions: ['geolocation'],
        userAgent: fingerprint.userAgent,
        initScript: buildStealthInjectionScript(fingerprint),
        fingerprintProfile: fingerprint,
      }) as any;

      try {
        const page = await context.newPage();
        const insecureHasUserAgentData = await page.evaluate(() => 'userAgentData' in navigator);
        await page.goto(`${origin}/${engine}`);
        await page.reload();
        const observed = await page.evaluate(async () => {
          const uaData = (navigator as Navigator & { userAgentData?: {
            brands: Array<{ brand: string; version: string }>;
            platform: string;
            getHighEntropyValues(hints: string[]): Promise<Record<string, unknown>>;
          } }).userAgentData;
          return {
            userAgent: navigator.userAgent,
            platform: navigator.platform,
            hasUserAgentData: Boolean(uaData),
            brands: uaData?.brands,
            uaDataPlatform: uaData?.platform,
            highEntropy: uaData ? await uaData.getHighEntropyValues(['fullVersionList', 'uaFullVersion']) : undefined,
            workerIdentity: await new Promise<Record<string, unknown>>((resolve, reject) => {
              const source = `navigator.userAgentData
                ? navigator.userAgentData.getHighEntropyValues(['uaFullVersion']).then((high) => postMessage({
                    userAgent: navigator.userAgent,
                    platform: navigator.platform,
                    uaDataPlatform: navigator.userAgentData.platform,
                    uaFullVersion: high.uaFullVersion,
                  }))
                : postMessage({ userAgent: navigator.userAgent, platform: navigator.platform });`;
              const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
              worker.onmessage = (event) => { resolve(event.data); worker.terminate(); };
              worker.onerror = (event) => { reject(new Error(event.message)); worker.terminate(); };
            }),
          };
        });
        const serviceWorkerIdentity = await page.evaluate(async () => {
          const registration = await navigator.serviceWorker.register('/sw.js');
          await navigator.serviceWorker.ready;
          if (!registration.active) throw new Error('Service Worker did not activate');
          return await new Promise<Record<string, unknown>>((resolve) => {
            const channel = new MessageChannel();
            channel.port1.onmessage = (event) => resolve(event.data);
            registration.active!.postMessage('identity', [channel.port2]);
          });
        });
        expect(context.browser()?.version()).toBe(managedBrowserIdentity(engine).fullVersion);
        expect(observed.userAgent).toBe(fingerprint.userAgent);
        expect(observed.platform).toBe(fingerprint.platform);
        if (engine === 'chromium') {
          expect(insecureHasUserAgentData).toBe(false);
          expect(observed.hasUserAgentData).toBe(true);
          expect(observed.uaDataPlatform).toBe('Linux');
          expect(observed.brands).toContainEqual({ brand: 'Chromium', version: managedBrowserIdentity(engine).majorVersion });
          expect(observed.brands?.some((brand: { brand: string }) => brand.brand.includes('Headless'))).toBe(false);
          expect(observed.highEntropy).toMatchObject({ uaFullVersion: managedBrowserIdentity(engine).fullVersion });
          expect(observed.workerIdentity).toMatchObject({
            userAgent: fingerprint.userAgent,
            platform: fingerprint.platform,
            uaDataPlatform: 'Linux',
            uaFullVersion: managedBrowserIdentity(engine).fullVersion,
          });
          expect(serviceWorkerIdentity).toMatchObject({
            userAgent: fingerprint.userAgent,
            platform: fingerprint.platform,
            uaDataPlatform: 'Linux',
            highEntropy: { uaFullVersion: managedBrowserIdentity(engine).fullVersion },
          });
          const networkHeaders = requests.filter((request) => request.url === '/chromium').at(-1)?.headers;
          expect(networkHeaders?.['sec-ch-ua']).not.toContain('Headless');
          expect(networkHeaders?.['sec-ch-ua']).toContain(`"Chromium";v="${managedBrowserIdentity(engine).majorVersion}"`);
          expect(networkHeaders?.['sec-ch-ua-platform']).toBe('"Linux"');
          expect(networkHeaders?.['sec-ch-ua-full-version-list']).toContain(managedBrowserIdentity(engine).fullVersion);
          expect(requests.filter((request) => request.url === '/sw.js').at(-1)?.headers['user-agent']).toBe(fingerprint.userAgent);
          expect(requests.filter((request) => request.url === '/from-service-worker').at(-1)?.headers['user-agent']).toBe(fingerprint.userAgent);
        } else {
          expect(serviceWorkerIdentity).toMatchObject({
            userAgent: fingerprint.userAgent,
            appVersion: fingerprint.appVersion,
            platform: fingerprint.platform,
            languages: fingerprint.geo.languages,
            hardwareConcurrency: fingerprint.hardware.hardwareConcurrency,
          });
          expect(serviceWorkerIdentity.timezone).toEqual(expect.any(String));
          expect(requests.filter((request) => request.url === '/sw.js').at(-1)?.headers['user-agent']).toBe(fingerprint.userAgent);
          expect(requests.filter((request) => request.url === '/from-service-worker').at(-1)?.headers['user-agent']).toBe(fingerprint.userAgent);
          expect(requests.filter((request) => request.url === '/from-service-worker').at(-1)?.headers['accept-language']).toContain('en-US');
        }
      } finally {
        await context.close();
        await rm(root, { recursive: true, force: true });
      }
    }, 45_000);
  }
});
