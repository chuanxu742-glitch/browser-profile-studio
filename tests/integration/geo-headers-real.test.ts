import { createServer, type IncomingHttpHeaders } from 'node:http';
import { chromium, firefox } from 'playwright';
import { describe, expect, it } from 'vitest';
import { alignGeoEnvironment } from '../../src/geoip/aligner.js';

const realBrowser = process.env.RUN_GEO_HEADERS_SMOKE === '1'
  || process.env.npm_lifecycle_event === 'test:geo-headers' ? describe : describe.skip;

realBrowser('geographic configuration preserves native request semantics', () => {
  for (const engine of [chromium, firefox]) {
    it(`${engine.name()} distinguishes navigation, stylesheet and fetch headers`, async () => {
      const requests = new Map<string, IncomingHttpHeaders>();
      const server = createServer((request, response) => {
        requests.set(request.url!, request.headers);
        if (request.url === '/style.css') {
          response.writeHead(200, { 'content-type': 'text/css' });
          response.end('body { color: black; }');
        } else if (request.url === '/api') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end('{"ok":true}');
        } else {
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end('<!doctype html><link rel="stylesheet" href="/style.css"><title>Geo headers</title>');
        }
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      let browser;
      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
        const aligned = alignGeoEnvironment({ countryCode: 'JP', locale: 'de-DE' });
        browser = await engine.launch({ headless: true });
        const page = await browser.newPage({ locale: aligned.locale, extraHTTPHeaders: aligned.extraHeaders });
        await page.goto(`http://127.0.0.1:${address.port}/`);
        await page.evaluate(async () => (await fetch('/api', { headers: { Accept: 'application/json' } })).json());
        expect(requests.get('/')?.['sec-fetch-dest']).toBe('document');
        expect(requests.get('/style.css')?.['sec-fetch-dest']).toBe('style');
        expect(requests.get('/api')?.['sec-fetch-dest']).toBe('empty');
        expect(requests.get('/api')?.['sec-fetch-mode']).toBe('cors');
        expect(requests.get('/api')?.accept).toBe('application/json');
        expect(requests.get('/api')?.['sec-fetch-user']).toBeUndefined();
        expect(requests.get('/api')?.['accept-language']).toBe('de-DE');
      } finally {
        await browser?.close();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    }, 30_000);
  }
});
