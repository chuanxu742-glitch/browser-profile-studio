// Native acceptance only: no init scripts, context locale or timezone emulation.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const lock = JSON.parse(await readFile(new URL('./core.lock.json', import.meta.url), 'utf8'));
const executable = process.env.ABS_CHROMIUM_EXECUTABLE_PATH;
assert(executable, 'Set ABS_CHROMIUM_EXECUTABLE_PATH to the freshly built chrome');

function probe() {
  let prototype = Object.getPrototypeOf(navigator);
  while (prototype && !Object.getOwnPropertyDescriptor(prototype, 'hardwareConcurrency')) {
    prototype = Object.getPrototypeOf(prototype);
  }
  return {
    language: navigator.language, languages: Array.from(navigator.languages),
    cores: navigator.hardwareConcurrency,
    locale: new Intl.DateTimeFormat().resolvedOptions().locale,
    timezone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
    offsets: [new Date('2026-01-15T12:00:00Z').getTimezoneOffset(),
      new Date('2026-07-15T12:00:00Z').getTimezoneOffset()],
    nativeGetter: String(Object.getOwnPropertyDescriptor(prototype, 'hardwareConcurrency').get).includes('[native code]'),
    ownProperty: Object.hasOwn(navigator, 'hardwareConcurrency'),
  };
}
const source = `const probe = ${probe.toString()}; const initial = probe();`;
const server = createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  if (request.url === '/headers') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ language: request.headers['accept-language'] }));
  } else if (request.url === '/dedicated.js') {
    response.setHeader('Content-Type', 'text/javascript');
    response.end(`${source} postMessage(initial);`);
  } else if (request.url === '/shared.js') {
    response.setHeader('Content-Type', 'text/javascript');
    response.end(`${source} onconnect = e => e.ports[0].postMessage(initial);`);
  } else if (request.url === '/sw.js') {
    response.setHeader('Content-Type', 'text/javascript');
    response.end(`${source}
      self.addEventListener('install', e => e.waitUntil(self.skipWaiting()));
      self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
      self.addEventListener('message', e => e.ports[0].postMessage(initial));`);
  } else {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Native Chromium acceptance</title>');
  }
});
await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const report = { chromiumRevision: lock.chromiumRevision, results: [] };
const profiles = [
  { locale: 'fr-FR', languages: ['fr-FR', 'fr'], timezone: 'Europe/Paris', cores: 3, offsets: [-60, -120] },
  { locale: 'ja-JP', languages: ['ja-JP', 'ja'], timezone: 'Asia/Tokyo', cores: 7, offsets: [-540, -540] },
];

async function runProfile(profile) {
  const directory = await mkdtemp(join(tmpdir(), 'abs-native-smoke-'));
  const processHandle = spawn(resolve(executable), [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${directory}`, '--disable-background-networking',
    '--site-per-process', `--lang=${profile.locale}`,
    `--accept-lang=${profile.languages.join(',')}`,
    `--abs-locale=${profile.locale}`, `--abs-languages=${profile.languages.join(',')}`,
    `--abs-timezone=${profile.timezone}`, `--abs-hardware-concurrency=${profile.cores}`,
    ...(process.env.ABS_CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : []), 'about:blank',
  ], { env: { ...process.env, TZ: 'UTC', LANG: 'en_US.UTF-8' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '', spawnError;
  processHandle.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-10000); });
  processHandle.on('error', error => { spawnError = error; });
  const exited = new Promise(resolve => processHandle.once('close', resolve));
  let browser;
  const watchdog = setTimeout(() => processHandle.kill('SIGKILL'), 60000);
  try {
    let endpoint;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (spawnError) throw spawnError;
      if (processHandle.exitCode !== null) throw new Error(`Chromium exited: ${stderr}`);
      const portFile = await readFile(join(directory, 'DevToolsActivePort'), 'utf8').catch(() => '');
      const [port, path] = portFile.trim().split(/\r?\n/);
      if (/^\d+$/.test(port) && path?.startsWith('/devtools/browser/')) {
        endpoint = `ws://127.0.0.1:${port}${path}`;
        break;
      }
      await delay(200);
    }
    assert(endpoint, `Native Chromium startup timed out: ${stderr}`);
    browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
    assert.equal(browser.version(), lock.browserVersion);
    const context = browser.contexts()[0];
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    await page.goto(origin);
    const results = { page: await page.evaluate(probe) };
    const navigation = page.waitForEvent('framenavigated', {
      predicate: frame => frame.url().startsWith('http://localhost:'),
    });
    await page.evaluate(url => {
      const iframe = document.createElement('iframe');
      iframe.src = url;
      document.body.append(iframe);
    }, origin.replace('127.0.0.1', 'localhost'));
    const frame = await navigation;
    assert(frame, 'Cross-site iframe did not load');
    results.iframe = await frame.evaluate(probe);
    Object.assign(results, await page.evaluate(async () => {
      const dedicated = await new Promise((resolve, reject) => {
        const worker = new Worker('/dedicated.js');
        worker.onmessage = e => { resolve(e.data); worker.terminate(); };
        worker.onerror = reject;
      });
      const shared = await new Promise((resolve, reject) => {
        const worker = new SharedWorker('/shared.js');
        worker.port.onmessage = e => { resolve(e.data); worker.port.close(); };
        worker.onerror = reject;
      });
      await navigator.serviceWorker.register('/sw.js');
      const registration = await navigator.serviceWorker.ready;
      const service = await new Promise(resolve => {
        const channel = new MessageChannel();
        channel.port1.onmessage = e => { resolve(e.data); channel.port1.close(); };
        registration.active.postMessage('probe', [channel.port2]);
      });
      return { dedicated, shared, service };
    }));
    const expected = { language: profile.locale, languages: profile.languages, cores: profile.cores,
      locale: profile.locale, timezone: profile.timezone, offsets: profile.offsets,
      nativeGetter: true, ownProperty: false };
    for (const [realm, actual] of Object.entries(results)) {
      assert.deepEqual(actual, expected, `Native profile mismatch in ${realm}`);
    }
    const headers = await page.evaluate(async () => (await fetch('/headers')).json());
    assert.equal(headers.language.split(',')[0], profile.locale);
    const session = await context.newCDPSession(page);
    await session.send('Emulation.setTimezoneOverride', { timezoneId: 'America/New_York' });
    assert.equal((await page.evaluate(probe)).timezone, 'America/New_York');
    await session.send('Emulation.setTimezoneOverride', { timezoneId: '' });
    assert.deepEqual(await page.evaluate(probe), expected, 'CDP clear must restore native baseline');
    report.results.push({ profile, realms: results, headers, cdpRestore: true });
  } finally {
    clearTimeout(watchdog);
    await browser?.close().catch(() => {});
    processHandle.kill();
    await Promise.race([exited, delay(5000)]);
    if (processHandle.exitCode === null && processHandle.signalCode === null && !spawnError) {
      processHandle.kill('SIGKILL');
      await exited;
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

try {
  for (const profile of profiles) await runProfile(profile);
  if (process.env.ABS_CHROMIUM_SMOKE_REPORT) {
    await writeFile(process.env.ABS_CHROMIUM_SMOKE_REPORT, JSON.stringify(report, null, 2) + '\n');
  }
  console.log('PASS: native page, cross-site iframe, dedicated/shared/service workers, headers and CDP restore');
} finally {
  await new Promise(resolve => server.close(resolve));
}
