import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { SessionManager } from '../../src/browser/session-manager.js';
import { UrlPolicy } from '../../src/policy/url-policy.js';

describe('Managed Chromium profile determinism', () => {
  it('preserves rendered output across restart and respects explicit regional settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'profile-determinism-'));
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<!doctype html><title>Profile determinism fixture</title>');
    });
    const manager = new SessionManager({
      maxSessions: 1,
      profileRoot: join(root, 'profiles'),
      artifactsRoot: join(root, 'artifacts'),
      urlPolicy: new UrlPolicy({ allowedHosts: ['127.0.0.1'], resourceHosts: ['127.0.0.1'], allowHttp: true, allowPrivateNetwork: true }),
    });
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
      const samples: unknown[] = [];
      for (const [seed, countryCode] of [[1001, 'US'], [1001, 'US'], [2002, 'JP']] as const) {
        const session = await manager.start({ engine: 'chromium', headless: true, fingerprint: true, fingerprintSeed: seed, countryCode });
        try {
          await manager.open(session.sessionId, `http://127.0.0.1:${address.port}/`);
          // BrowserSession owns this real Playwright page; no external data crosses this test boundary.
          const internalSession = session as unknown as { page: Page };
          const page = internalSession.page;
          samples.push(await page.evaluate(() => {
            const canvas = document.createElement('canvas');
            canvas.width = 160;
            canvas.height = 40;
            const context = canvas.getContext('2d');
            if (!context) throw new Error('2D canvas unavailable');
            context.font = '16px sans-serif';
            context.fillText('Stable rendered output', 3, 24);
            return {
              userAgent: navigator.userAgent,
              platform: navigator.platform,
              language: navigator.language,
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              hardwareConcurrency: navigator.hardwareConcurrency,
              screen: { width: screen.width, height: screen.height },
              png: canvas.toDataURL(),
              pixels: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data),
            };
          }));
        } finally {
          await manager.stop(session.sessionId, 'test_done');
        }
      }
      expect(samples[0]).toEqual(samples[1]);
      expect(samples[0]).toMatchObject({ timezone: 'America/New_York', language: 'en-US' });
      expect(samples[2]).toMatchObject({ timezone: 'Asia/Tokyo', language: 'ja-JP' });
    } finally {
      await manager.shutdown();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 45_000);
});
