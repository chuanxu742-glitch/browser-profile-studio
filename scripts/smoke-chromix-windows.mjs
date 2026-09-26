import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

// Usage: node scripts/smoke-chromix-windows.mjs <repository-root> <RUNNER_TEMP/evidence.json> <compatibility-only|hosted-gpu-gate|app-acceptance>
// Hosted GPU gate verifies Studio rejects virtual-GPU saved-profile startup; only physical-GPU app-acceptance can prove successful launch.
const rootArgument = process.argv[2];
const evidenceArgument = process.argv[3];
const mode = process.argv[4];
assert.ok(rootArgument && evidenceArgument && process.argv.length === 5, 'Expected repository root, evidence JSON path, and explicit mode');
assert.ok(['compatibility-only', 'hosted-gpu-gate', 'app-acceptance'].includes(mode), 'Mode must be compatibility-only, hosted-gpu-gate, or app-acceptance');
const root = resolve(rootArgument);
const evidencePath = resolve(evidenceArgument);
const runnerTemp = resolve(process.env.RUNNER_TEMP ?? '');
const report = {
  result: 'failed', mode, platform: process.platform, arch: process.arch,
  distribution: 'chromix-152', expectedVersion: '152.0.7977.82',
  physicalGpu: mode === 'app-acceptance' ? 'NOT VERIFIED: native startup and WebGL checks pending' : 'UNVERIFIED virtual runner',
  phases: [],
};
let fixture;
let child;
let token;
let profileId;
let isolatedProfileId;
let api;
let studioLog = '';
const requestEvidence = new Map();
let referenceWorkerHeaders;
const reports = new Map();
const execFileAsync = promisify(execFile);

const identityScript = `async function identity(nav) {
  const uaData = nav.userAgentData;
  if (!uaData || typeof uaData.getHighEntropyValues !== 'function') throw new Error('UA-CH unavailable');
  const high = await uaData.getHighEntropyValues(['fullVersionList', 'platform', 'platformVersion']);
  return { userAgent: nav.userAgent, platform: nav.platform,
    brands: uaData.brands, mobile: uaData.mobile, chPlatform: uaData.platform,
    fullVersionList: high.fullVersionList, highPlatform: high.platform };
}`;
const pageScript = `${identityScript}
(async () => {
  try {
    const phase = new URL(location.href).searchParams.get('phase');
    const key = 'chromix_smoke_state';
    const cookieName = 'chromix_smoke_cookie';
    const previous = { cookie: document.cookie, storage: localStorage.getItem(key) };
    if (phase === 'first') {
      document.cookie = cookieName + '=persisted; Max-Age=600; Path=/; SameSite=Lax';
      localStorage.setItem(key, 'persisted');
    }
    const frame = document.createElement('iframe');
    frame.src = '/frame?phase=' + encodeURIComponent(phase);
    document.body.append(frame);
    await new Promise((done, fail) => { frame.onload = done; frame.onerror = fail; });
    const worker = new Worker('/worker.js?phase=' + encodeURIComponent(phase));
    let workerIdentity;
    try {
      workerIdentity = await new Promise((done, fail) => {
        worker.onmessage = event => event.data.error ? fail(new Error(event.data.error)) : done(event.data.identity);
        worker.onerror = event => fail(new Error(event.message));
      });
    } finally { worker.terminate(); }
    const headers = await fetch('/headers?phase=' + encodeURIComponent(phase));
    if (!headers.ok) throw new Error('Header probe failed: ' + headers.status);
    const payload = { phase, page: await identity(navigator), frame: await identity(frame.contentWindow.navigator),
      worker: workerIdentity, previous, cookie: document.cookie, storage: localStorage.getItem(key),
      headerProbe: await headers.json() };
    const response = await fetch('/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error('Fixture rejected report: ' + response.status);
  } catch (error) {
    await fetch('/report', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phase: new URL(location.href).searchParams.get('phase'), error: String(error) }) });
  }
})();`;

function validateIdentity(value, label) {
  // Chromium's reduced UA carries the major version; full build comes from high-entropy UA-CH.
  assert.match(value.userAgent, /(?:Chrome|Chromium)\/152\.\d+\.\d+\.\d+(?:\b|$)/, `${label}: not Chromium 152`);
  assert.match(value.platform, /Win/i, `${label}: not Windows`);
  assert.equal(value.chPlatform, 'Windows', `${label}: UA-CH platform`);
  assert.equal(value.highPlatform, 'Windows', `${label}: high-entropy platform`);
  assert.equal(value.mobile, false, `${label}: mobile UA-CH`);
  assert.ok(Array.isArray(value.brands) && value.brands.some(brand =>
    /Chromium|Google Chrome/i.test(brand.brand) && brand.version === '152'), `${label}: Chromium 152 UA-CH brand`);
  assert.ok(Array.isArray(value.fullVersionList) && value.fullVersionList.some(brand =>
    /Chromium|Google Chrome/i.test(brand.brand) && brand.version === '152.0.7977.82'), `${label}: Chromium 152 UA-CH full version`);
}

function assertHeaders(headers, label, userAgent) {
  assert.equal(headers['user-agent'], userAgent, `${label}: HTTP and JS user agents differ`);
  assert.match(headers['sec-ch-ua'] ?? '', /(?:Chromium|Google Chrome)";v="152"/,
    `${label}: HTTP Chromium 152 UA-CH missing; observed=${JSON.stringify({
      userAgent: headers['user-agent'] ?? null,
      secChUa: headers['sec-ch-ua'] ?? null,
      platform: headers['sec-ch-ua-platform'] ?? null,
      mobile: headers['sec-ch-ua-mobile'] ?? null,
    })}`);
  assert.equal(headers['sec-ch-ua-platform'], '"Windows"', `${label}: HTTP UA-CH platform`);
  assert.equal(headers['sec-ch-ua-mobile'], '?0', `${label}: HTTP UA-CH mobile`);
}

function validatePhase(phase, result) {
  assert.equal(result.phase, phase);
  assert.ok(!result.error, `${phase}: page script failed: ${result.error}`);
  for (const realm of ['page', 'frame', 'worker']) validateIdentity(result[realm], `${phase}/${realm}`);
  assert.equal(result.frame.userAgent, result.page.userAgent, `${phase}: iframe UA diverges`);
  assert.equal(result.worker.userAgent, result.page.userAgent, `${phase}: Worker UA diverges`);
  for (const realm of ['frame', 'worker']) {
    assert.deepEqual(result[realm].brands, result.page.brands, `${phase}/${realm}: UA-CH brands diverge`);
    assert.deepEqual(result[realm].fullVersionList, result.page.fullVersionList, `${phase}/${realm}: UA-CH full version diverges`);
  }
  for (const route of ['page', 'frame', 'worker', 'headers']) {
    const headers = requestEvidence.get(`${phase}/${route}`);
    assert.ok(headers, `${phase}/${route}: no browser request reached fixture`);
    if (route === 'worker' && referenceWorkerHeaders) {
      assert.equal(headers['user-agent'], result.page.userAgent, `${phase}/worker: HTTP and JS user agents differ`);
      // The same-run Edge reference establishes the dedicated Worker script's exact UA-CH omission.
      for (const name of ['sec-ch-ua', 'sec-ch-ua-platform', 'sec-ch-ua-mobile']) {
        assert.equal(referenceWorkerHeaders[name], undefined, `Edge reference Worker unexpectedly sent ${name}`);
        assert.equal(headers[name], undefined, `${phase}/worker: ${name} differs from reference Edge omission`);
      }
    } else assertHeaders(headers, `${phase}/${route}`, result.page.userAgent);
  }
  assertHeaders(result.headerProbe, `${phase}/header-probe`, result.page.userAgent);
  assert.match(result.headerProbe['sec-ch-ua-full-version-list'] ?? '',
    /(?:Chromium|Google Chrome)";v="152\.0\.7977\.82"/, `${phase}: HTTP high-entropy UA-CH did not report Chromix 152`);
  if (phase === 'isolated') {
    for (const field of ['previous', 'current']) {
      const cookies = field === 'previous' ? result.previous.cookie : result.cookie;
      const storage = field === 'previous' ? result.previous.storage : result.storage;
      assert.doesNotMatch(cookies, /(?:^|; )chromix_smoke_cookie=/, `Second profile inherited first profile's ${field} cookie`);
      assert.equal(storage, null, `Second profile inherited first profile's ${field} localStorage`);
    }
    for (const route of ['page', 'frame', 'worker', 'headers']) {
      assert.doesNotMatch(requestEvidence.get(`isolated/${route}`).cookie ?? '', /(?:^|; )chromix_smoke_cookie=/,
        `Second profile sent first profile's cookie on ${route}`);
    }
  } else {
    assert.match(result.cookie, /(?:^|; )chromix_smoke_cookie=persisted(?:;|$)/);
    assert.equal(result.storage, 'persisted');
    if (phase === 'restart') {
      assert.match(result.previous.cookie, /(?:^|; )chromix_smoke_cookie=persisted(?:;|$)/, 'Cookie did not survive profile stop/start');
      assert.equal(result.previous.storage, 'persisted', 'localStorage did not survive profile stop/start');
      assert.match(requestEvidence.get('restart/page').cookie ?? '', /chromix_smoke_cookie=persisted/, 'Cookie not sent on restarted navigation');
    }
  }
  return { phase, realms: { page: result.page, frame: result.frame, worker: result.worker },
    requestHeaders: Object.fromEntries(['page', 'frame', 'worker', 'headers'].map(route => [route, requestEvidence.get(`${phase}/${route}`)])),
    cookiePresent: phase !== 'isolated', localStoragePresent: phase !== 'isolated',
    ...(phase === 'restart' ? { persistedAcrossRestart: true } : {}),
    ...(phase === 'isolated' ? { isolatedFromFirstProfile: true } : {}) };
}

function fixtureResponse(req, res) {
  const parsed = new URL(req.url, 'http://127.0.0.1');
  const phase = parsed.searchParams.get('phase');
  const route = parsed.pathname === '/' ? 'page' : parsed.pathname.slice(1).replace(/\.js$/, '');
  if (['baseline', 'first', 'restart', 'isolated'].includes(phase) && ['page', 'frame', 'worker', 'headers'].includes(route)) {
    requestEvidence.set(`${phase}/${route}`, { 'user-agent': req.headers['user-agent'],
      'sec-ch-ua': req.headers['sec-ch-ua'], 'sec-ch-ua-platform': req.headers['sec-ch-ua-platform'],
      'sec-ch-ua-mobile': req.headers['sec-ch-ua-mobile'], 'sec-ch-ua-full-version-list': req.headers['sec-ch-ua-full-version-list'],
      cookie: req.headers.cookie });
  }
  res.setHeader('Accept-CH', 'Sec-CH-UA-Full-Version-List');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET' && parsed.pathname === '/') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><title>Chromix hosted smoke</title><body><script>${pageScript}</script></body>`);
  } else if (req.method === 'GET' && parsed.pathname === '/frame') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><title>Chromix iframe</title>');
  } else if (req.method === 'GET' && parsed.pathname === '/worker.js') {
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.end(`${identityScript}\nidentity(self.navigator).then(identity => postMessage({ identity }), error => postMessage({ error: String(error) }));`);
  } else if (req.method === 'GET' && parsed.pathname === '/headers') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(requestEvidence.get(`${phase}/headers`)));
  } else if (req.method === 'POST' && parsed.pathname === '/report') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 65536) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (!['baseline', 'first', 'restart', 'isolated'].includes(data.phase) || reports.has(data.phase)) throw new Error('Invalid or repeated phase');
        reports.set(data.phase, data);
        res.writeHead(204).end();
      } catch { res.writeHead(400).end(); }
    });
  } else res.writeHead(404).end();
}

async function freePort() {
  const server = createServer();
  await new Promise((done, fail) => server.once('error', fail).listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done, fail) => server.close(error => error ? fail(error) : done()));
  return port;
}

async function waitForReport(phase) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (reports.has(phase)) return reports.get(phase);
    if (child && child.exitCode !== null) throw new Error(`Studio exited (${child.exitCode}) while awaiting ${phase}`);
    await delay(500);
  }
  throw new Error(`Timed out waiting for browser ${phase} fixture report`);
}

async function verifyInstalledChromix(executable) {
  const installRoot = dirname(executable);
  assert.equal((await realpath(installRoot)).toLowerCase(), installRoot.toLowerCase(), 'Chromix install directory is linked');
  assert.ok((await lstat(executable)).isFile(), 'Chromix executable is not a regular file');
  const manifestPath = join(installRoot, 'chromix-install.json');
  assert.ok((await lstat(manifestPath)).isFile(), 'Chromix manifest is not a regular file');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.deepEqual(Object.keys(manifest).sort(),
    ['archiveSha256', 'browserVersion', 'distribution', 'files', 'schemaVersion']);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.distribution, 'chromix-152');
  assert.equal(manifest.browserVersion, report.expectedVersion);
  assert.equal(manifest.archiveSha256, '1cfbe638212ba4d463a8c3330fcfbd8c88f9844ff6dfc0722f2c40745e0bc7f8');
  assert.ok(manifest.files && typeof manifest.files === 'object' && !Array.isArray(manifest.files));
  const remaining = new Set(Object.keys(manifest.files));
  assert.ok(remaining.has('chrome.exe') && remaining.has('chrome.dll'), 'Chromix binary inventory incomplete');
  const uniqueNames = new Set();
  for (const name of remaining) {
    assert.ok(name !== 'chromix-install.json' && !name.includes('\\') && !name.includes(':')
      && name.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part)),
    `Unsafe Chromix inventory path: ${name}`);
    assert.ok(!uniqueNames.has(name.toLowerCase()), `Chromix inventory case collision: ${name}`);
    uniqueNames.add(name.toLowerCase());
    assert.match(manifest.files[name], /^[0-9a-f]{64}$/, `Invalid Chromix digest: ${name}`);
  }
  const directories = [installRoot];
  while (directories.length) {
    const directory = directories.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = relative(installRoot, path).split(sep).join('/');
      assert.ok(!entry.isSymbolicLink(), `Linked Chromix file: ${name}`);
      if (entry.isDirectory()) { directories.push(path); continue; }
      assert.ok(entry.isFile(), `Unsupported Chromix filesystem entry: ${name}`);
      if (name === 'chromix-install.json') continue;
      assert.ok(remaining.delete(name), `Unexpected Chromix file: ${name}`);
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      assert.equal(hash.digest('hex'), manifest.files[name], `Chromix file hash mismatch: ${name}`);
    }
  }
  assert.equal(remaining.size, 0, `Missing Chromix files: ${[...remaining].join(', ')}`);
  report.archiveSha256 = manifest.archiveSha256;
}

async function runEdgeReference(cwd, fixtureOrigin, chromium) {
  const edge = join(process.env['ProgramFiles(x86)'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe');
  assert.ok(process.env['ProgramFiles(x86)'] && (await lstat(edge)).isFile(),
    'Installed system Edge reference browser required to distinguish Worker UA-CH behavior');
  let context;
  try {
    context = await chromium.launchPersistentContext(join(cwd, 'edge-reference-data'), {
      executablePath: edge, headless: true,
    });
    const page = context.pages()[0] ?? await context.newPage();
    const version = await (await context.newCDPSession(page)).send('Browser.getVersion');
    await page.goto(`${fixtureOrigin}/?phase=baseline`, { waitUntil: 'domcontentloaded' });
    const observed = await waitForReport('baseline');
    assert.ok(!observed.error, `Edge reference fixture failed: ${observed.error}`);
    assert.match(observed.page.userAgent, /Edg\/\d+\./, 'Reference executable did not report Microsoft Edge');
    referenceWorkerHeaders = requestEvidence.get('baseline/worker');
    assert.ok(referenceWorkerHeaders && observed.worker, 'Edge reference Worker request/identity missing');
    assert.equal(referenceWorkerHeaders['user-agent'], observed.worker.userAgent,
      'Edge reference Worker HTTP and JS user agents differ');
    for (const route of ['page', 'frame', 'headers']) {
      const headers = requestEvidence.get(`baseline/${route}`);
      assert.ok(headers?.['sec-ch-ua'] && headers['sec-ch-ua-platform'] === '"Windows"'
        && headers['sec-ch-ua-mobile'] === '?0', `Edge reference ${route}: ordinary HTTP UA-CH missing`);
    }
    for (const name of ['sec-ch-ua', 'sec-ch-ua-platform', 'sec-ch-ua-mobile']) {
      assert.equal(referenceWorkerHeaders[name], undefined, `Edge reference Worker unexpectedly sent ${name}`);
    }
    report.reference = {
      browser: 'installed Microsoft Edge', cdpBrowserVersion: version.product,
      pageUserAgent: observed.page.userAgent, workerHeaders: referenceWorkerHeaders,
      pageHeaders: requestEvidence.get('baseline/page'),
      workerIdentity: observed.worker,
    };
    console.log(`Edge reference ${version.product}: ${JSON.stringify({
      workerUserAgent: referenceWorkerHeaders['user-agent'],
      workerSecChUa: referenceWorkerHeaders['sec-ch-ua'] ?? null,
      workerSecChUaPlatform: referenceWorkerHeaders['sec-ch-ua-platform'] ?? null,
      workerSecChUaMobile: referenceWorkerHeaders['sec-ch-ua-mobile'] ?? null,
      pageSecChUa: requestEvidence.get('baseline/page')['sec-ch-ua'],
    })}`);
  } finally {
    await context?.close();
  }
}

async function runCompatibility(executable, cwd, fixtureOrigin) {
  const { chromium } = createRequire(join(root, 'package.json'))('playwright');
  const userDataDir = join(cwd, 'chromix-user-data');
  for (const phase of ['first', 'restart']) {
    let context;
    try {
      context = await chromium.launchPersistentContext(userDataDir, { executablePath: executable, headless: true });
      const page = context.pages()[0] ?? await context.newPage();
      const cdp = await context.newCDPSession(page);
      const version = await cdp.send('Browser.getVersion');
      assert.match(version.product, new RegExp(`^(?:Chrome|HeadlessChrome)/${report.expectedVersion.replaceAll('.', '\\.')}$`),
        `${phase}: CDP browser product/version`);
      await page.goto(`${fixtureOrigin}/?phase=${phase}`, { waitUntil: 'domcontentloaded' });
      const observed = await waitForReport(phase);
      const phaseEvidence = validatePhase(phase, observed);
      phaseEvidence.cdpBrowserVersion = version.product;
      report.phases.push(phaseEvidence);
    } finally {
      await context?.close();
    }
  }
  report.productAcceptance = 'NOT RUN: direct Playwright probe bypasses Studio';
  report.result = 'compatibility_only';
}

async function run() {
  assert.equal(process.platform, 'win32', 'Hosted Chromix smoke requires Windows');
  assert.equal(process.arch, 'x64', 'Hosted Chromix smoke requires x64');
  assert.ok(process.env.RUNNER_TEMP && isAbsolute(process.env.RUNNER_TEMP), 'RUNNER_TEMP must be absolute');
  assert.ok(relative(runnerTemp, evidencePath) && !relative(runnerTemp, evidencePath).startsWith('..') && !isAbsolute(relative(runnerTemp, evidencePath)),
    'Evidence JSON must be within RUNNER_TEMP');
  assert.match(basename(evidencePath), /\.json$/i);
  const executable = resolve(process.env.CHROMIX_EXECUTABLE_PATH ?? '');
  assert.equal(executable.toLowerCase(), join(runnerTemp, 'chromix-install', 'chromix', 'chrome.exe').toLowerCase(),
    'CHROMIX_EXECUTABLE_PATH must point to the hosted installed chrome.exe');
  await verifyInstalledChromix(executable);
  const requiredFiles = mode === 'compatibility-only'
    ? ['package.json', 'node_modules/playwright/package.json']
    : ['package.json', 'scripts/start-studio.ts', 'src/api/server.ts', 'public/index.html', 'node_modules/tsx/package.json'];
  for (const name of requiredFiles) await access(join(root, name));
  const cwd = await mkdtemp(join(runnerTemp, 'chromix-smoke-'));
  report.disposableCwd = cwd;
  if (mode !== 'compatibility-only') {
    for (const name of ['scripts', 'src', 'public', 'node_modules']) await symlink(join(root, name), join(cwd, name), 'junction');
  }
  fixture = createServer(fixtureResponse);
  await new Promise((done, fail) => fixture.once('error', fail).listen(0, '127.0.0.1', done));
  const fixtureOrigin = `http://127.0.0.1:${fixture.address().port}`;
  if (mode !== 'hosted-gpu-gate') {
    await runEdgeReference(cwd, fixtureOrigin, createRequire(join(root, 'package.json'))('playwright').chromium);
  }
  if (mode === 'compatibility-only') {
    await runCompatibility(executable, cwd, fixtureOrigin);
    return;
  }
  const studioPort = await freePort();
  const studioOrigin = `http://127.0.0.1:${studioPort}`;
  token = randomBytes(32).toString('hex');
  const env = { ...process.env, CHROMIX_EXECUTABLE_PATH: executable,
    STUDIO_PORT: String(studioPort), STUDIO_ACCESS_TOKEN: token };
  delete env.ABS_CHROMIUM_EXECUTABLE_PATH;
  delete env.ABS_REQUIRE_NATIVE_CHROMIUM;
  delete env.STUDIO_MASTER_KEY;
  child = spawn(process.execPath, ['--import', 'tsx/esm', 'scripts/start-studio.ts'], {
    cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
    studioLog = (studioLog + chunk.toString()).slice(-12000);
  });
  child.on('error', error => { studioLog = (studioLog + String(error)).slice(-12000); });
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error(`Studio exited before readiness (${child.exitCode}): ${studioLog}`);
    try {
      const response = await fetch(`${studioOrigin}/api/v1/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok && (await response.json()).data?.name === 'Browser Profile Isolation Studio API') { ready = true; break; }
    } catch { /* Studio startup is asynchronous. */ }
    await delay(500);
  }
  assert.ok(ready, `Studio readiness timed out: ${studioLog}`);
  assert.equal((await fetch(`${studioOrigin}/api/v1/profiles`, { signal: AbortSignal.timeout(5000) })).status, 401);
  api = async (path, method = 'GET', body) => {
    const response = await fetch(`${studioOrigin}/api/v1${path}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120000),
    });
    const result = await response.json();
    assert.ok(response.ok && result.success, `${method} ${path}: ${result.code} ${result.message ?? ''}`);
    return result.data;
  };
  const profile = await api('/profiles', 'POST', {
    name: `Hosted Chromix ${randomBytes(5).toString('hex')}`, engine: 'chromium', browserDistribution: 'chromix-152',
  });
  profileId = profile.profileId;
  assert.ok(profileId);
  assert.equal(profile.browserDistribution, 'chromix-152');
  if (mode === 'hosted-gpu-gate') {
    const response = await fetch(`${studioOrigin}/api/v1/profiles/${encodeURIComponent(profileId)}/start`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ headless: true }), signal: AbortSignal.timeout(120000),
    });
    const rejection = await response.json();
    assert.equal(response.status, 500, `Virtual GPU startup returned unexpected status: ${JSON.stringify(rejection)}`);
    assert.equal(rejection.success, false, 'Virtual GPU unexpectedly admitted a saved Chromix profile');
    assert.match(rejection.message ?? '', /^GPU_BACKEND_UNVERIFIED:/,
      `Expected native GPU rejection, observed ${JSON.stringify(rejection)}`);
    assert.deepEqual(await api('/sessions'), [], 'Rejected profile created a browser session');
    const saved = await api(`/profiles/${encodeURIComponent(profileId)}`);
    assert.equal(saved.fingerprint?.gpu, undefined, 'Rejected virtual GPU was persisted to the saved profile');
    report.gpuGate = { httpStatus: response.status, code: rejection.code, message: rejection.message,
      savedProfileId: profileId, activeSessions: 0 };
    report.productAcceptance = 'NOT RUN: hosted virtual GPU rejected saved-profile startup before BrowserSession launch';
    report.result = 'gpu_gate_confirmed';
    console.log(`Studio saved-profile GPU admission rejected virtual runner: ${rejection.message}`);
    return;
  }
  for (const phase of ['first', 'restart']) {
    const session = await api(`/profiles/${encodeURIComponent(profileId)}/start`, 'POST', { headless: true });
    assert.ok(session.sessionId);
    assert.equal(session.profileId, profileId);
    assert.equal(session.headless, true);
    assert.equal(session.state, 'READY');
    const url = `${fixtureOrigin}/?phase=${phase}`;
    await api(`/sessions/${encodeURIComponent(session.sessionId)}/open`, 'POST', { url });
    const running = (await api('/sessions')).find(item => item.sessionId === session.sessionId);
    assert.equal(running?.profileId, profileId, `${phase}: session not attached to saved profile`);
    assert.equal(running?.browserDistribution, 'chromix-152', `${phase}: wrong browser distribution`);
    const observed = await waitForReport(phase);
    const phaseEvidence = validatePhase(phase, observed);
    const view = await api(`/sessions/${encodeURIComponent(session.sessionId)}/live-view`);
    assert.equal(view.sessionId, session.sessionId);
    assert.equal(view.url, url);
    assert.ok(typeof view.image === 'string' && view.image.length > 0, `${phase}: live-view screenshot missing`);
    const diagnostics = await api(`/sessions/${encodeURIComponent(session.sessionId)}/diagnostics`);
    assert.equal(diagnostics.engine, 'chromium');
    assert.equal(diagnostics.headless, true);
    assert.equal(diagnostics.expected.browserMajor, '152');
    assert.equal(diagnostics.observed?.userAgent, observed.page.userAgent);
    for (const id of ['browser-version', 'user-agent']) {
      assert.equal(diagnostics.checks.find(check => check.id === id)?.status, 'pass', `${phase}: ${id} diagnostics failed`);
    }
    for (const id of ['webgl-vendor', 'webgl-renderer']) {
      assert.equal(diagnostics.checks.find(check => check.id === id)?.status, 'pass', `${phase}: GPU ${id} observation did not match native profile`);
    }
    assert.notEqual(diagnostics.consistency, 'inconsistent', `${phase}: environment diagnostics contain failed checks`);
    phaseEvidence.sessionId = session.sessionId;
    phaseEvidence.diagnostics = { consistency: diagnostics.consistency,
      nativeGpuAdmission: 'SessionManager.start succeeded for saved chromix-152 profile',
      webgl: { expected: diagnostics.expected.webgl, observed: diagnostics.observed.webgl },
      identityChecks: diagnostics.checks.filter(check =>
        ['browser-version', 'user-agent', 'webgl-vendor', 'webgl-renderer'].includes(check.id)) };
    report.phases.push(phaseEvidence);
    const stopped = await api(`/profiles/${encodeURIComponent(profileId)}/stop`, 'POST');
    assert.equal(stopped.stopped, true);
  }
  assert.notEqual(report.phases[0].sessionId, report.phases[1].sessionId, 'Restart reused the prior session');
  const isolated = await api('/profiles', 'POST', {
    name: `Hosted isolated Chromix ${randomBytes(5).toString('hex')}`,
    engine: 'chromium', browserDistribution: 'chromix-152',
  });
  isolatedProfileId = isolated.profileId;
  assert.ok(isolatedProfileId);
  assert.notEqual(isolatedProfileId, profileId, 'Second profile reused first profile ID');
  assert.equal(isolated.browserDistribution, 'chromix-152');
  const secondSession = await api(`/profiles/${encodeURIComponent(isolatedProfileId)}/start`, 'POST', { headless: true });
  assert.equal(secondSession.profileId, isolatedProfileId);
  assert.equal(secondSession.headless, true);
  assert.equal(secondSession.state, 'READY');
  assert.ok(secondSession.sessionId);
  for (const prior of report.phases) {
    assert.notEqual(secondSession.sessionId, prior.sessionId, 'Second profile reused first profile session');
  }
  const firstDir = await realpath(join(cwd, 'data', 'profiles', profileId, 'chromix-152-browser'));
  const secondDir = await realpath(join(cwd, 'data', 'profiles', isolatedProfileId, 'chromix-152-browser'));
  assert.notEqual(firstDir.toLowerCase(), secondDir.toLowerCase(), 'Chromix profiles share a browser data directory');
  const isolatedUrl = `${fixtureOrigin}/?phase=isolated`;
  await api(`/sessions/${encodeURIComponent(secondSession.sessionId)}/open`, 'POST', { url: isolatedUrl });
  const secondRunning = (await api('/sessions')).find(item => item.sessionId === secondSession.sessionId);
  assert.equal(secondRunning?.profileId, isolatedProfileId);
  assert.equal(secondRunning?.browserDistribution, 'chromix-152');
  const secondObserved = await waitForReport('isolated');
  const isolatedEvidence = validatePhase('isolated', secondObserved);
  const secondView = await api(`/sessions/${encodeURIComponent(secondSession.sessionId)}/live-view`);
  assert.equal(secondView.sessionId, secondSession.sessionId);
  assert.equal(secondView.url, isolatedUrl);
  assert.ok(typeof secondView.image === 'string' && secondView.image.length > 0, 'Isolated profile live-view screenshot missing');
  const secondDiagnostics = await api(`/sessions/${encodeURIComponent(secondSession.sessionId)}/diagnostics`);
  assert.equal(secondDiagnostics.engine, 'chromium');
  assert.equal(secondDiagnostics.expected.browserMajor, '152');
  assert.equal(secondDiagnostics.observed?.userAgent, secondObserved.page.userAgent);
  for (const id of ['browser-version', 'user-agent', 'webgl-vendor', 'webgl-renderer']) {
    assert.equal(secondDiagnostics.checks.find(check => check.id === id)?.status, 'pass',
      `isolated: ${id} diagnostics failed`);
  }
  assert.notEqual(secondDiagnostics.consistency, 'inconsistent', 'Second profile diagnostics contain failed checks');
  isolatedEvidence.sessionId = secondSession.sessionId;
  isolatedEvidence.profileId = isolatedProfileId;
  isolatedEvidence.browserDataDirectory = relative(cwd, secondDir);
  isolatedEvidence.diagnostics = {
    consistency: secondDiagnostics.consistency,
    nativeGpuAdmission: 'SessionManager.start succeeded for a distinct saved chromix-152 profile',
    webgl: { expected: secondDiagnostics.expected.webgl, observed: secondDiagnostics.observed.webgl },
    identityChecks: secondDiagnostics.checks.filter(check =>
      ['browser-version', 'user-agent', 'webgl-vendor', 'webgl-renderer'].includes(check.id)),
  };
  report.phases.push(isolatedEvidence);
  assert.equal((await api(`/profiles/${encodeURIComponent(isolatedProfileId)}/stop`, 'POST')).stopped, true);
  report.isolation = {
    firstProfileId: profileId, secondProfileId: isolatedProfileId,
    firstBrowserDataDirectory: relative(cwd, firstDir),
    secondBrowserDataDirectory: relative(cwd, secondDir),
    secondProfileSawFirstCookie: false, secondProfileSawFirstLocalStorage: false,
  };
  report.profileId = profileId;
  report.physicalGpu = 'Studio native GPU admission and observed WebGL consistency passed; no independent physical-GPU fidelity proof';
  report.result = 'passed';
}

try {
  await run();
} catch (error) {
  report.error = String(error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  if (api) {
    for (const id of [isolatedProfileId, profileId].filter(Boolean)) {
      try { await api(`/profiles/${encodeURIComponent(id)}/stop`, 'POST'); }
      catch (error) {
        report.cleanupErrors ??= [];
        report.cleanupErrors.push(`${id}: ${String(error)}`);
        process.exitCode = 1;
        report.result = 'failed';
      }
    }
  }
  if (child && child.exitCode === null && child.pid) {
    try { await execFileAsync('taskkill', ['/pid', String(child.pid), '/T', '/F']); }
    catch (error) { report.cleanupError = String(error); process.exitCode = 1; report.result = 'failed'; }
  }
  if (fixture) await new Promise(done => fixture.close(done));
  if (token) report.studioLogTail = studioLog.replaceAll(token, '[REDACTED]');
  if (process.env.RUNNER_TEMP && isAbsolute(process.env.RUNNER_TEMP) &&
      !relative(runnerTemp, evidencePath).startsWith('..') && !isAbsolute(relative(runnerTemp, evidencePath))) {
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, JSON.stringify(report, null, 2));
  }
}
if (['passed', 'compatibility_only', 'gpu_gate_confirmed'].includes(report.result)) {
  console.log(`Chromix ${report.mode} ${report.result}: ${evidencePath}`);
}
