import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserContext, Page } from 'playwright';
import { launchPersistentChromium } from '../../src/browser/chromium-launcher.js';
import { launchPersistentFirefox } from '../../src/browser/firefox-launcher.js';
import { generateFingerprint } from '../../src/fingerprint/generator.js';
import { managedBrowserIdentity } from '../../src/fingerprint/runtime-identity.js';
import { buildStealthInjectionScript } from '../../src/fingerprint/stealth-scripts.js';
import { ENVIRONMENT_PROBE } from '../../src/browser/environment-probe.js';
import { buildEnvironmentDiagnostics, expectedEnvironment, type EnvironmentSurfaceSnapshot } from '../../src/browser/environment-diagnostics.js';
import { SessionManager } from '../../src/browser/session-manager.js';
import { UrlPolicy } from '../../src/policy/url-policy.js';
import { AuditLogger } from '../../src/audit.js';

const shouldRun = process.env.RUN_FINGERPRINT_RUNTIME_SMOKE === '1'
  || process.env.npm_lifecycle_event === 'test:fingerprint-runtime';
const realRuntime = shouldRun ? describe : describe.skip;
const firstScript = `const canvas = new OffscreenCanvas(8, 8);
const ctx = canvas.getContext('2d');
for (let y=0; y<8; y++) for (let x=0; x<8; x++) {
  ctx.fillStyle = 'rgb(' + (x*27) + ',' + (y*29) + ',59)'; ctx.fillRect(x,y,1,1);
}
const gl = new OffscreenCanvas(1,1).getContext('webgl');
const debug = gl && gl.getExtension('WEBGL_debug_renderer_info');
const first = JSON.stringify({
  userAgent: navigator.userAgent, platform: navigator.platform,
  languages: Array.from(navigator.languages), hardwareConcurrency: navigator.hardwareConcurrency,
  deviceMemory: navigator.deviceMemory, deviceMemoryPresent: 'deviceMemory' in navigator,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  uaDataPlatform: navigator.userAgentData && navigator.userAgentData.platform,
  uaDataBrands: navigator.userAgentData && navigator.userAgentData.brands,
  canvas: Array.from(ctx.getImageData(0,0,8,8).data),
  webglAvailable: Boolean(gl), renderer: debug && gl.getParameter(debug.UNMASKED_RENDERER_WEBGL),
  vendor: debug && gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)
});`;

realRuntime('real managed fingerprint runtime identity', () => {
  let server: Server;
  let origin: string;
  const requests: Array<{ url: string; headers: Record<string, string | string[] | undefined> }> = [];
  beforeAll(async () => {
    server = createServer((request, response) => {
      const url = request.url ?? '/';
      requests.push({ url, headers: request.headers });
      if (url === '/transport') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<!doctype html><link rel="stylesheet" href="/transport.css"><script src="/transport-script.js"></script><body>Native transport fixture</body>');
        return;
      }
      if (url === '/transport.css') {
        response.writeHead(200, { 'content-type': 'text/css' });
        response.end('body { background-color: rgb(12, 34, 56); }');
        return;
      }
      if (url === '/transport-data') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"transport":"native"}');
        return;
      }
      if (url === '/transport-script.js') {
        response.writeHead(200, { 'content-type': 'application/javascript' });
        response.end('document.documentElement.dataset.externalScript = "executed";');
        return;
      }
      if (url.endsWith('.js')) {
        response.writeHead(200, { 'content-type': 'application/javascript', 'service-worker-allowed': '/' });
        if (url === '/sw.js') {
          response.end(`${firstScript} addEventListener('message', async event => {
            await fetch('/from-service-worker'); event.ports[0].postMessage(first);
          });`);
        } else if (url === '/shared.js') {
          response.end(`${firstScript} onconnect = event => event.ports[0].postMessage(first);`);
        } else if (url === '/nested.js') {
          response.end(`${firstScript} const child = new Worker('/worker.js');
            child.onmessage = event => { postMessage(JSON.stringify({ parent: first, child: event.data })); child.terminate(); };
            child.onerror = event => { throw new Error(event.message); };`);
        } else response.end(`${firstScript} postMessage(first);`);
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'accept-ch': 'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version',
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
    it(`keeps ${engine} first-script identities, transport and native API contracts aligned`, async () => {
      const root = await mkdtemp(join(tmpdir(), `fingerprint-${engine}-`));
      // Stock Firefox can expose native service workers only in the host timezone.
      const generated = generateFingerprint({
        seed: 20260905, engine, os: engine === 'chromium' ? 'linux' : 'windows', countryCode: 'US',
        ...(engine === 'firefox' ? { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } : {}),
      });
      // Stock Firefox's native worker CPU preference is capped by the host.
      // Use a realizable two-core test profile on standard hosted runners,
      // without changing the generator or weakening observed realm assertions.
      const fingerprint = engine === 'firefox'
        ? { ...generated, hardware: { ...generated.hardware, hardwareConcurrency: 2 } }
        : generated;
      const launch = engine === 'firefox' ? launchPersistentFirefox : launchPersistentChromium;
      let context: BrowserContext | undefined;
      try {
        // Both managed launchers return a real Playwright persistent context.
        const launched = await launch(join(root, 'profile'), {
          headless: true, viewport: fingerprint.viewport, timezoneId: fingerprint.geo.timezoneId,
          locale: fingerprint.geo.locale, geolocation: fingerprint.geo.geolocation, permissions: ['geolocation'],
          userAgent: fingerprint.userAgent, initScript: buildStealthInjectionScript(fingerprint), fingerprintProfile: fingerprint,
          ...(engine === 'chromium' ? { extraHTTPHeaders: { 'aCcEpT-LaNgUaGe': 'EN-us,EN;q=0.9' } } : {}),
        });
        context = launched as unknown as BrowserContext;
        const page = await context.newPage();
        await page.goto(`${origin}/${engine}`);
        await page.reload();
        const observed = await page.evaluate(async (source: string) => {
          // Browser process lifecycle deadlines cannot use Vitest's Node fake clock.
          const within = async <T>(promise: Promise<T>): Promise<T> => {
            // The project DOM library predates Promise.withResolvers.
            let timer = 0;
            const timeout = new Promise<never>((_, reject) => {
              timer = window.setTimeout(() => reject(new Error('Realm probe timed out')), 10000);
            });
            try { return await Promise.race([promise, timeout]); }
            finally { clearTimeout(timer); }
          };
          const workers: Record<string, unknown> = {};
          const blob = URL.createObjectURL(new Blob([source + 'postMessage(first);'], { type: 'text/javascript' }));
          try {
            for (const [name, url, type] of [
              ['url', '/worker.js', 'classic'], ['module', '/module.js', 'module'],
              ['blob', blob, 'classic'], ['nested', '/nested.js', 'classic'],
            ] as const) {
              const worker = new Worker(url, { type });
              try {
                const raw = await within(new Promise<string>((resolve, reject) => {
                  worker.onmessage = event => resolve(event.data);
                  worker.onerror = event => reject(new Error(event.message));
                }));
                if (typeof raw !== 'string') throw new Error('Worker must serialize in its own realm');
                workers[name] = JSON.parse(raw);
              } finally { worker.terminate(); }
            }
          } finally { URL.revokeObjectURL(blob); }
          const shared = new SharedWorker('/shared.js');
          try {
            workers.shared = JSON.parse(await within(new Promise<string>((resolve, reject) => {
              shared.port.onmessage = event => resolve(event.data);
              shared.onerror = event => reject(new Error(event.message));
            })));
          } finally { shared.port.close(); }
          const registration = await within(navigator.serviceWorker.register('/sw.js'));
          try {
            await within(navigator.serviceWorker.ready);
            if (!registration.active) throw new Error('Service worker did not activate');
            const channel = new MessageChannel();
            try {
              workers.service = JSON.parse(await within(new Promise<string>(resolve => {
                channel.port1.onmessage = event => resolve(event.data);
                registration.active!.postMessage('identity', [channel.port2]);
              })));
            } finally { channel.port1.close(); channel.port2.close(); }
          } finally { await registration.unregister(); }
          const top = JSON.parse(new Function(source + 'return first;')());
          return { workers, top, userAgent: navigator.userAgent, platform: navigator.platform };
        }, firstScript);
        expect(context.browser()?.version()).toBe(managedBrowserIdentity(engine).fullVersion);
        const expected = {
          userAgent: fingerprint.userAgent, platform: fingerprint.platform,
          languages: fingerprint.geo.languages, hardwareConcurrency: fingerprint.hardware.hardwareConcurrency,
          timezone: fingerprint.geo.timezoneId,
          deviceMemoryPresent: engine === 'chromium',
          ...(engine === 'chromium' ? { deviceMemory: fingerprint.hardware.deviceMemory } : {}),
          ...(engine === 'chromium' ? { canvas: observed.top.canvas } : {}),
          webglAvailable: true,
          renderer: fingerprint.webgl.unmaskedRenderer || fingerprint.webgl.renderer,
          vendor: fingerprint.webgl.unmaskedVendor || fingerprint.webgl.vendor,
          ...(engine === 'chromium' ? { uaDataPlatform: 'Linux' } : {}),
        };
        expect(observed).toMatchObject({ userAgent: expected.userAgent, platform: expected.platform });
        expect(observed.top).toMatchObject(expected);
        if (engine === 'chromium') {
          expect(observed.top.uaDataBrands).toContainEqual({ brand: 'Chromium', version: managedBrowserIdentity(engine).majorVersion });
          const highEntropy = await page.evaluate(`navigator.userAgentData.getHighEntropyValues(['uaFullVersion', 'fullVersionList'])`);
          expect(highEntropy).toMatchObject({
            uaFullVersion: managedBrowserIdentity(engine).fullVersion,
            fullVersionList: expect.arrayContaining([{ brand: 'Chromium', version: managedBrowserIdentity(engine).fullVersion }]),
          });
        } else {
          expect(observed.top.uaDataBrands).toBeUndefined();
        }
        for (const name of ['url', 'module', 'blob', 'shared', 'service']) {
          expect(observed.workers[name], name).toMatchObject(expected);
          if (engine === 'chromium') {
            expect(observed.workers[name]).toMatchObject({ uaDataBrands: observed.top.uaDataBrands });
          }
        }
        const nested = observed.workers.nested;
        if (!nested || typeof nested !== 'object' || !('parent' in nested) || !('child' in nested)
          || typeof nested.parent !== 'string' || typeof nested.child !== 'string') {
          throw new Error('Nested workers did not return serialized identities');
        }
        expect(JSON.parse(nested.parent), 'nested parent first script').toMatchObject(expected);
        expect(JSON.parse(nested.child), 'nested child first script').toMatchObject(expected);
        const runtimeSurface = await page.evaluate<EnvironmentSurfaceSnapshot>(ENVIRONMENT_PROBE);
        const diagnostics = buildEnvironmentDiagnostics({
          sessionId: `real-${engine}`, engine, headless: true,
          expected: expectedEnvironment(fingerprint), observed: runtimeSurface,
        });
        const realmSnapshots: Record<string, unknown> = {
          ...observed.workers, nestedParent: JSON.parse(nested.parent), nestedChild: JSON.parse(nested.child),
        };
        delete realmSnapshots.nested;
        const canvasParity = Object.fromEntries(Object.entries(realmSnapshots).map(([name, value]) => [
          name, Boolean(value && typeof value === 'object' && 'canvas' in value
            && JSON.stringify(value.canvas) === JSON.stringify(observed.top.canvas)),
        ]));
        const evidenceDirectory = join(process.cwd(), 'artifacts', 'fingerprint-repair-20260905');
        await mkdir(evidenceDirectory, { recursive: true });
        await writeFile(join(evidenceDirectory, `worker-parity-${engine}.json`), JSON.stringify({
          engine, observed, canvasParity, diagnostics,
          strictDeepWorkerAcceptance: engine === 'chromium' && Object.values(canvasParity).every(Boolean)
            ? 'passed' : 'NOT PASSED',
          ...(engine === 'firefox' ? {
            blocker: 'No verified native first-script Worker Canvas bootstrap in stock or currently available custom Firefox core.',
          } : {}),
        }, null, 2));
        if (engine === 'chromium') {
          for (const [name, matches] of Object.entries(canvasParity)) expect(matches, `${name} Canvas parity`).toBe(true);
        } else {
          expect(diagnostics.checks).toContainEqual(expect.objectContaining({ id: 'worker-bootstrap-support', status: 'fail' }));
          expect(diagnostics.consistency).toBe('inconsistent');
        }
        for (const url of [`/${engine}`, '/worker.js', '/module.js', '/shared.js', '/sw.js', '/from-service-worker']) {
          const headers = requests.filter(request => request.url === url).at(-1)?.headers;
          expect(headers?.['user-agent'], url).toBe(fingerprint.userAgent);
          const languageHeader = headers?.['accept-language'];
          expect(typeof languageHeader, url).toBe('string');
          if (typeof languageHeader !== 'string') throw new Error(`${url}: missing Accept-Language`);
          expect(languageHeader.split(',').map(value => value.split(';')[0]!.trim().toLowerCase()), url)
            .toEqual(fingerprint.geo.languages.map(language => language.toLowerCase()));
          // Require document hints and coherence wherever native Chromium sends
          // them; worker destinations normally omit these headers.
          if (engine === 'chromium' && (url === '/chromium' || headers?.['sec-ch-ua'] !== undefined)) {
            expect(headers?.['sec-ch-ua'], url).toContain(`"Chromium";v="${managedBrowserIdentity(engine).majorVersion}"`);
          }
          if (engine === 'chromium' && (url === '/chromium' || headers?.['sec-ch-ua-platform'] !== undefined)) {
            expect(headers?.['sec-ch-ua-platform'], url).toBe('"Linux"');
          }
        }
        const contracts = await page.evaluate<Record<string, boolean>>(DEEP_API_PROBE);
        for (const [name, value] of Object.entries(contracts)) expect(value, name).toBe(true);
      } finally {
        await context?.close();
        await rm(root, { recursive: true, force: true });
      }
    }, 120_000);
  }

  it('rejects an explicit language header that disagrees with the managed profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fingerprint-language-conflict-'));
    const fingerprint = generateFingerprint({ seed: 20260905, engine: 'chromium', os: 'windows', countryCode: 'US' });
    let unexpectedContext: { close(): Promise<void> } | undefined;
    try {
      const launch = launchPersistentChromium(join(root, 'profile'), {
        headless: true, fingerprintProfile: fingerprint,
        extraHTTPHeaders: { 'aCcEpT-LaNgUaGe': 'zh-CN,zh;q=0.9' },
      }).then(context => { unexpectedContext = context; return context; });
      await expect(launch).rejects.toThrow(/^FINGERPRINT_ACCEPT_LANGUAGE_MISMATCH:/);
    } finally {
      await unexpectedContext?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('loads public geo-aligned sessions with native document, script, stylesheet, fetch and worker request semantics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fingerprint-native-transport-'));
    const manager = new SessionManager({
      maxSessions: 1, profileRoot: join(root, 'profiles'), artifactsRoot: join(root, 'artifacts'),
      urlPolicy: new UrlPolicy({ allowedHosts: ['127.0.0.1'], resourceHosts: ['127.0.0.1'], allowHttp: true, allowPrivateNetwork: true }),
      audit: new AuditLogger(join(root, 'audit.jsonl')),
    });
    try {
      const session = await manager.start({ engine: 'chromium', headless: true, fingerprint: true, fingerprintSeed: 20260905, countryCode: 'US' });
      await manager.open(session.sessionId, `${origin}/transport`);
      // This managed session owns a real Playwright page; no fake network layer.
      const page = Reflect.get(session, 'page') as Page;
      await page.waitForFunction(() => document.documentElement.dataset.externalScript === 'executed'
        && getComputedStyle(document.body).backgroundColor === 'rgb(12, 34, 56)', undefined, { timeout: 5000 });
      const received = await page.evaluate(async () => {
        const fetched = await (await fetch('/transport-data')).json();
        const worker = new Worker('/transport-worker.js');
        let timer = 0;
        try {
          // Browser callbacks require a real deadline outside Vitest's fake clock.
          const identity = await new Promise<string>((resolve, reject) => {
            timer = window.setTimeout(() => reject(new Error('Public worker did not execute')), 5000);
            worker.onmessage = event => resolve(event.data);
            worker.onerror = event => reject(new Error(event.message));
          });
          return { fetched, identity: JSON.parse(identity) };
        } finally { clearTimeout(timer); worker.terminate(); }
      });
      expect(received.fetched).toEqual({ transport: 'native' });
      expect(received.identity).toMatchObject({ hardwareConcurrency: 6, languages: ['en-US', 'en'], timezone: 'America/New_York' });
      for (const [url, mode, destination] of [
        ['/transport', 'navigate', 'document'], ['/transport-script.js', 'no-cors', 'script'],
        ['/transport.css', 'no-cors', 'style'], ['/transport-data', 'cors', 'empty'],
        ['/transport-worker.js', 'same-origin', 'worker'],
      ]) {
        const headers = requests.filter(request => request.url === url).at(-1)?.headers;
        expect(headers?.['sec-fetch-mode'], url).toBe(mode);
        expect(headers?.['sec-fetch-dest'], url).toBe(destination);
        if (url !== '/transport') {
          expect(headers?.['sec-fetch-site'], url).toBe('same-origin');
          expect(headers?.['accept'], url).not.toContain('text/html');
        }
      }
    } finally {
      await manager.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);

  it('disables stock Firefox service workers for a foreign timezone without lying about availability', async () => {
    if (process.env.ABS_FIREFOX_EXECUTABLE_PATH) return;
    const root = await mkdtemp(join(tmpdir(), 'fingerprint-firefox-foreign-'));
    const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const fingerprint = generateFingerprint({
      seed: 20260901, engine: 'firefox', os: 'windows', countryCode: 'US',
      timezone: host === 'America/New_York' ? 'Asia/Tokyo' : 'America/New_York',
    });
    let context: BrowserContext | undefined;
    try {
      const launched = await launchPersistentFirefox(join(root, 'profile'), {
        headless: true, viewport: fingerprint.viewport, timezoneId: fingerprint.geo.timezoneId,
        locale: fingerprint.geo.locale, userAgent: fingerprint.userAgent,
        initScript: buildStealthInjectionScript(fingerprint), fingerprintProfile: fingerprint,
      });
      // The managed launcher returns a real Playwright persistent context.
      context = launched as unknown as BrowserContext;
      const page = await context.newPage();
      await page.goto(origin);
      const result = await page.evaluate(() => ({
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        serviceWorker: 'serviceWorker' in navigator,
      }));
      expect(result).toEqual({ timezone: fingerprint.geo.timezoneId, serviceWorker: false });
    } finally {
      await context?.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);
});

const DEEP_API_PROBE = `(async () => {
  const result = {};
  // Native cross-process callbacks need real deadlines, not Node fake timers.
  const within = async (promise, label) => {
    const timeout = Promise.withResolvers();
    const timer = setTimeout(() => timeout.reject(new Error(label + ' timed out')), 5000);
    try { return await Promise.race([promise, timeout.promise]); }
    finally { clearTimeout(timer); }
  };
  const equal = (a, b) => a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const channel = new MessageChannel();
  let removedCalls = 0;
  const removed = () => { removedCalls++; };
  channel.port1.addEventListener('message', removed);
  channel.port1.removeEventListener('message', removed);
  const payload = { timezone: 'business-zone', hardwareConcurrency: 123, platform: 'business-platform', languages: ['business-language'] };
  let timer;
  try {
    const received = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('MessageChannel timed out')), 5000);
      channel.port1.onmessage = event => resolve(event.data);
      channel.port2.postMessage(payload);
    });
    result.businessMessages = JSON.stringify(received) === JSON.stringify(payload) && removedCalls === 0;
  } finally { clearTimeout(timer); channel.port1.close(); channel.port2.close(); }
  const frame = document.createElement('iframe'); document.body.appendChild(frame);
  try {
    for (const name of ['hardwareConcurrency', 'maxTouchPoints', 'webdriver']) {
      const getter = Object.getOwnPropertyDescriptor(Navigator.prototype, name).get;
      result['crossRealmNative:' + name] = frame.contentWindow.Function.prototype.toString.call(getter).includes('[native code]');
      try { getter.call({}); result['illegalReceiver:' + name] = false; }
      catch (error) { result['illegalReceiver:' + name] = error instanceof TypeError; }
    }
  } finally { frame.remove(); }
  result.webdriver = navigator.webdriver === false && 'webdriver' in navigator;
  result.screenCSS = matchMedia('(device-width: ' + screen.width + 'px)').matches
    && matchMedia('(device-height: ' + screen.height + 'px)').matches
    && matchMedia('(resolution: ' + devicePixelRatio + 'dppx)').matches;
  const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16;
  const ctx = canvas.getContext('2d');
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    ctx.fillStyle = 'rgb(' + (x * 13) + ',' + (y * 11) + ',59)'; ctx.fillRect(x, y, 1, 1);
  }
  const whole = ctx.getImageData(0, 0, 16, 16);
  result.canvasCrop = [[1,3,7,5], [9,11,-7,-5], [-3,-1,8,7]].every(([x,y,w,h]) => {
    const image = ctx.getImageData(x,y,w,h); const left = w < 0 ? x+w : x; const top = h < 0 ? y+h : y;
    for (let row=0; row<image.height; row++) for (let col=0; col<image.width; col++) {
      const sx=left+col, sy=top+row;
      const expected=sx<0||sy<0||sx>=16||sy>=16 ? [0,0,0,0] : whole.data.slice((sy*16+sx)*4,(sy*16+sx)*4+4);
      if (!equal(image.data.slice((row*image.width+col)*4,(row*image.width+col)*4+4), expected)) return false;
    } return true;
  });
  ctx.putImageData(whole,0,0); result.canvasWriteback = equal(whole.data,ctx.getImageData(0,0,16,16).data);
  let coercions=0; const mime={ toString() { coercions++; return 'image/png'; } };
  const dataURL=canvas.toDataURL(mime); result.dataURLCoercion=coercions===1;
  coercions=0; const blobReady=Promise.withResolvers(); canvas.toBlob(blobReady.resolve,mime);
  const blob=await within(blobReady.promise,'canvas toBlob'); result.blobCoercion=coercions===1;
  const offscreen=new OffscreenCanvas(16,16); offscreen.getContext('2d').putImageData(whole,0,0);
  coercions=0; const offBlob=await within(offscreen.convertToBlob({type:mime}),'Offscreen convertToBlob'); result.offscreenCoercion=coercions===1;
  result.canvasRoundtrip=true;
  for (const source of [await (await fetch(dataURL)).blob(),blob,offBlob]) {
    const bitmap=await within(createImageBitmap(source),'PNG bitmap decode'); const output=new OffscreenCanvas(16,16); const out=output.getContext('2d');
    try { out.drawImage(bitmap,0,0); result.canvasRoundtrip &&= equal(whole.data,out.getImageData(0,0,16,16).data); }
    finally { bitmap.close(); }
  }
  try { ctx.getImageData(0,0,0,1); result.canvasException=false; }
  catch(error) { result.canvasException=error.name==='IndexSizeError'; }
  try { HTMLCanvasElement.prototype.toDataURL.call({},mime); result.canvasBrand=false; }
  catch(error) { result.canvasBrand=error instanceof TypeError; }
  const gl=document.createElement('canvas').getContext('webgl');
  if (!gl) throw new Error('WebGL context unavailable');
  const extension=gl.getExtension('WEBGL_debug_renderer_info');
  result.webglIdentity=extension!==null && extension===gl.getExtension('WEBGL_debug_renderer_info');
  try { gl.getParameter.call({},gl.VENDOR); result.webglBrand=false; }
  catch(error) { result.webglBrand=error instanceof TypeError; }
  result.audio=true;
  for (const rate of [44100,48000]) {
    const offline=new OfflineAudioContext(1,2048,rate);
    const zero=offline.createBuffer(1,2048,rate);
    result.audio &&= zero.getChannelData(0).every(value=>value===0) && zero.sampleRate===rate && offline.sampleRate===rate;
    zero.getChannelData(0)[17]=0.25; const copy=new Float32Array(32); zero.copyFromChannel(copy,0);
    result.audio &&= copy[17]===0.25;
    const oscillator=offline.createOscillator(); oscillator.connect(offline.destination); oscillator.start();
    const completed=Promise.withResolvers();
    const onComplete=event=>completed.resolve(event.renderedBuffer);
    offline.addEventListener('complete',onComplete,{once:true});
    try {
      const [rendered,eventBuffer]=await within(Promise.all([offline.startRendering(),completed.promise]),'offline rendering and complete event');
      const before=rendered.getChannelData(0).slice(); const copied=new Float32Array(rendered.length); rendered.copyFromChannel(copied,0);
      result.audio &&= rendered===eventBuffer && rendered.sampleRate===rate && equal(before,copied) && before.some(value=>value!==0);
      rendered.getChannelData(0)[31]=0.125; rendered.copyFromChannel(copied,0); result.audio &&= copied[31]===0.125;
    } finally {
      offline.removeEventListener('complete',onComplete);
      oscillator.stop(); oscillator.disconnect();
    }
  }
  const rtc=new RTCPeerConnection({iceServers:[]});
  try { rtc.createDataChannel('business'); const offer=await within(rtc.createOffer(),'RTC createOffer'); await within(rtc.setLocalDescription(offer),'RTC setLocalDescription'); result.rtcOffer=rtc.localDescription.type==='offer'; }
  finally { rtc.close(); }
  return result;
})()`;
