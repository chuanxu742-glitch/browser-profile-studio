import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { launchPersistentChromium } from '../../src/browser/chromium-launcher.js';
import { launchPersistentFirefox } from '../../src/browser/firefox-launcher.js';
import { generateFingerprint, HOST_OS } from '../../src/fingerprint/generator.js';
import { buildStealthInjectionScript } from '../../src/fingerprint/stealth-scripts.js';

async function storageSnapshot(page: Page, marker: string | null) {
  return page.evaluate(async (value) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('isolation', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('records');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      if (value !== null) {
        document.cookie = `marker=${value};path=/;max-age=3600;SameSite=Lax`;
        localStorage.setItem('marker', value);
        await (await caches.open('isolation')).put('/cached', new Response(value));
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction('records', 'readwrite');
          transaction.objectStore('records').put(value, 'marker');
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
        });
      }
      const indexed = await new Promise<unknown>((resolve, reject) => {
        const request = db.transaction('records').objectStore('records').get('marker');
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error);
      });
      return {
        cookie: document.cookie,
        local: localStorage.getItem('marker'), indexed,
        cache: await (await caches.match('/cached'))?.text() ?? null,
        geolocation: (await navigator.permissions.query({ name: 'geolocation' })).state,
        notifications: Notification.permission,
        workerRegistrations: (await navigator.serviceWorker.getRegistrations()).length,
      };
    } finally { db.close(); }
  }, marker);
}

async function workerIdentity(page: Page) {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return new Promise<unknown>((resolve, reject) => {
      if (!registration.active) { reject(new Error('Service Worker inactive')); return; }
      const channel = new MessageChannel();
      channel.port1.onmessage = event => { channel.port1.close(); resolve(event.data); };
      registration.active.postMessage('identity', [channel.port2]);
    });
  });
}

describe('persistent fingerprint profiles', () => {
  for (const engine of ['chromium', 'firefox'] as const) {
    it(`${engine} isolates storage, permissions and service workers and restores its own first-script identity`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'fingerprint-isolation-'));
      const server = createServer((request, response) => {
        if (request.url === '/service.js') {
          response.setHeader('content-type', 'application/javascript');
          response.end(`const first={ua:navigator.userAgent,cpu:navigator.hardwareConcurrency,languages:Array.from(navigator.languages),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone};addEventListener('install',e=>e.waitUntil(skipWaiting()));addEventListener('activate',e=>e.waitUntil(clients.claim()));addEventListener('message',e=>e.ports[0].postMessage(first));`);
        } else { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><body>isolation</body>'); }
      });
      let a: BrowserContext | undefined;
      let b: BrowserContext | undefined;
      try {
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
        const origin = `http://127.0.0.1:${address.port}`;
        const profile = generateFingerprint({ seed: 91234, engine, os: HOST_OS, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
        const launch = async (name: string): Promise<BrowserContext> => (engine === 'chromium' ? launchPersistentChromium : launchPersistentFirefox)(join(root, name), {
          headless: true, fingerprintProfile: profile, userAgent: profile.userAgent,
          timezoneId: profile.geo.timezoneId, locale: profile.geo.locale,
          initScript: buildStealthInjectionScript(profile),
        }) as unknown as Promise<BrowserContext>;
        a = await launch('a');
        const pageA = await a.newPage();
        await pageA.goto(origin);
        b = await launch('b');
        const pageB = await b.newPage();
        await pageB.goto(origin);
        const untouchedB = await storageSnapshot(pageB, null);
        expect(untouchedB).toMatchObject({ cookie: '', local: null, indexed: null, cache: null, workerRegistrations: 0 });
        await a.grantPermissions(['geolocation'], { origin });
        await pageA.evaluate(async () => { await navigator.serviceWorker.register('/service.js'); });
        expect(await workerIdentity(pageA)).toEqual({ ua: profile.userAgent, cpu: profile.hardware.hardwareConcurrency, languages: profile.geo.languages, timezone: profile.geo.timezoneId });
        const saved = await storageSnapshot(pageA, 'profile-a');
        expect(saved).toMatchObject({ cookie: 'marker=profile-a', local: 'profile-a', indexed: 'profile-a', cache: 'profile-a', geolocation: 'granted', workerRegistrations: 1 });
        expect(await storageSnapshot(pageB, null)).toEqual(untouchedB);
        await storageSnapshot(pageB, 'profile-b');
        expect(await storageSnapshot(pageA, null)).toEqual(saved);
        await a.close();
        a = await launch('a');
        const restoredPage = await a.newPage();
        await restoredPage.goto(origin);
        // Native engines differ in permission persistence; restarting A must not change B's permissions.
        expect(await storageSnapshot(restoredPage, null)).toMatchObject({ cookie: 'marker=profile-a', local: 'profile-a', indexed: 'profile-a', cache: 'profile-a', workerRegistrations: 1 });
        expect(await workerIdentity(restoredPage)).toEqual({ ua: profile.userAgent, cpu: profile.hardware.hardwareConcurrency, languages: profile.geo.languages, timezone: profile.geo.timezoneId });
        expect(await storageSnapshot(pageB, null)).toMatchObject({ cookie: 'marker=profile-b', local: 'profile-b', indexed: 'profile-b', cache: 'profile-b', geolocation: untouchedB.geolocation, notifications: untouchedB.notifications, workerRegistrations: 0 });
      } finally {
        try {
          try { await a?.close(); }
          finally { await b?.close(); }
        } finally {
          try { await new Promise<void>(resolve => server.close(() => resolve())); }
          finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
        }
      }
    }, 60_000);
  }
});
