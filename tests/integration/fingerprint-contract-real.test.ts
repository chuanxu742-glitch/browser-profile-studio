import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserContext } from 'playwright';
import { launchPersistentChromium } from '../../src/browser/chromium-launcher.js';
import { launchPersistentFirefox } from '../../src/browser/firefox-launcher.js';
import { generateFingerprint } from '../../src/fingerprint/generator.js';
import { buildStealthInjectionScript } from '../../src/fingerprint/stealth-scripts.js';

// Native behavior, not a detector score: these are deterministic regressions
// for data corruption and contradictory observations in the managed runtime.
describe('managed fingerprint native contracts', () => {
  let server: Server;
  let origin: string;
  beforeAll(async () => {
    server = createServer((request, response) => {
      response.setHeader('content-type', request.url?.includes('worker') ? 'application/javascript' : 'text/html');
      if (request.url === '/worker.js' || request.url === '/module-worker.js') {
        response.end(`postMessage(JSON.stringify({ userAgent: navigator.userAgent, platform: navigator.platform, hardwareConcurrency: navigator.hardwareConcurrency, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, offset: new Date(2026, 0, 1).getTimezoneOffset() }));`);
      } else {
        response.end('<!doctype html><body>Native contract fixture</body>');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No fixture address');
    origin = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  for (const engine of ['chromium', 'firefox'] as const) {
    it(`${engine} preserves communication, pixel, audio and native receiver contracts`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'fingerprint-contract-'));
      const generated = generateFingerprint({ seed: 31337, engine, os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux' });
      const fingerprint = { ...generated, hardware: { ...generated.hardware, hardwareConcurrency: Math.min(8, cpus().length) }, geo: { ...generated.geo, timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone } };
      let context: BrowserContext | undefined;
      try {
        context = await (engine === 'chromium' ? launchPersistentChromium : launchPersistentFirefox)(root, {
          headless: true, fingerprintProfile: fingerprint, userAgent: fingerprint.userAgent,
          timezoneId: fingerprint.geo.timezoneId, locale: fingerprint.geo.locale,
          initScript: buildStealthInjectionScript(fingerprint),
        // Launchers expose a narrow production adapter; this test exercises Playwright's DOM API.
        }) as unknown as BrowserContext;
        const page = await context.newPage();
        await page.goto(origin);
        const result = await page.evaluate(async () => {
          const within = <T>(promise: Promise<T>): Promise<T> => {
            // This timeout bounds real cross-process browser events, not a guessed completion delay.
            let timer = 0;
            const timeout = new Promise<never>((_, reject) => {
              timer = window.setTimeout(() => reject(new Error('Probe timeout')), 5000);
            });
            return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
          };
          const channel = new MessageChannel();
          const sent = { timezone: 'application-value', platform: 'billing', hardwareConcurrency: 123, userAgent: 'business-value' };
          const payload = await within(new Promise((resolve) => { channel.port1.onmessage = (event) => resolve(event.data); channel.port2.postMessage(sent); }));
          channel.port1.close(); channel.port2.close();
          const second = new MessageChannel();
          let removedCalls = 0;
          const listener = () => { removedCalls++; };
          second.port1.addEventListener('message', listener);
          second.port1.removeEventListener('message', listener);
          const delivered = within(new Promise<void>((resolve) => { second.port1.onmessage = () => resolve(); }));
          second.port2.postMessage('delivery barrier');
          await delivered;
          second.port1.close(); second.port2.close();
          const canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 8;
          const ctx = canvas.getContext('2d')!; ctx.fillStyle = 'rgb(100,100,100)'; ctx.fillRect(0, 0, 8, 8);
          const full = ctx.getImageData(0, 0, 8, 8);
          const crop = ctx.getImageData(1, 1, 3, 3);
          const negative = ctx.getImageData(4, 4, -3, -3);
          const expectedCrop: number[] = [];
          for (let y = 1; y < 4; y++) for (let x = 1; x < 4; x++) expectedCrop.push(...full.data.slice((y * 8 + x) * 4, (y * 8 + x + 1) * 4));
          ctx.putImageData(full, 0, 0);
          const roundTrip = Array.from(ctx.getImageData(0, 0, 8, 8).data);
          const offline = new OfflineAudioContext(1, 44100, 44100);
          const rendered = await offline.startRendering();
          const audio = offline.createBuffer(1, 200, 44100);
          const copied = new Float32Array(200); audio.copyFromChannel(copied, 0);
          const channelData = Array.from(audio.getChannelData(0));
          let illegalReceiver = false;
          const getter = Object.getOwnPropertyDescriptor(Navigator.prototype, 'hardwareConcurrency')!.get!;
          try { getter.call({}); } catch (error) { illegalReceiver = error instanceof TypeError; }
          const frame = document.createElement('iframe');
          const loaded = within(new Promise<void>((resolve) => { frame.onload = () => resolve(); }));
          frame.src = '/frame'; document.body.appendChild(frame); await loaded;
          const frameWindow = frame.contentWindow as Window & typeof globalThis;
          const foreignToString = frameWindow.Function.prototype.toString.call(getter);
          const workers = [];
          for (const [url, type] of [['/worker.js', 'classic'], ['/module-worker.js', 'module']] as const) {
            workers.push(await within(new Promise((resolve, reject) => {
              const worker = new Worker(url, { type });
              worker.onmessage = (event) => { worker.terminate(); resolve(JSON.parse(event.data)); };
              worker.onerror = (event) => { worker.terminate(); reject(new Error(event.message)); };
            })));
          }
          return {
            sent, payload, removedCalls, workerConstructorAligned: Worker.prototype.constructor === Worker,
            crop: Array.from(crop.data), negative: Array.from(negative.data), expectedCrop,
            full: Array.from(full.data), roundTrip,
            audioRate: offline.sampleRate, renderedRate: rendered.sampleRate,
            copied: Array.from(copied), channelData, illegalReceiver, foreignToString, workers,
            pageIdentity: { userAgent: navigator.userAgent, platform: navigator.platform, hardwareConcurrency: navigator.hardwareConcurrency, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, offset: new Date(2026, 0, 1).getTimezoneOffset() },
          };
        });
        expect(result.payload).toEqual(result.sent);
        expect(result.removedCalls).toBe(0);
        expect(result.workerConstructorAligned).toBe(true);
        expect(result.crop).toEqual(result.expectedCrop);
        expect(result.negative).toEqual(result.expectedCrop);
        expect(result.roundTrip).toEqual(result.full);
        expect(result.audioRate).toBe(44100);
        expect(result.renderedRate).toBe(44100);
        expect(result.channelData).toEqual(result.copied);
        expect(result.illegalReceiver).toBe(true);
        expect(result.foreignToString).toContain('[native code]');
        for (const worker of result.workers) expect(worker).toEqual(result.pageIdentity);
      } finally {
        await context?.close();
        await rm(root, { recursive: true, force: true });
      }
    }, 60_000);
  }
});
