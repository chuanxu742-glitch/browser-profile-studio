import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { access, readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(process.argv[2]);
const evidence = resolve(process.argv[3]);
await mkdir(evidence, { recursive: true });
const manifest = await readFile(join(root, 'PACKAGE-CONTENTS.sha256'), 'utf8');
let filesVerified = 0;
for (const line of manifest.replace(/^\uFEFF/, '').trim().split(/\r?\n/)) {
  const [, expected, relative] = /^([a-f0-9]{64})  (.+)$/.exec(line) ?? [];
  assert.ok(relative && expected, 'Invalid package content manifest');
  const actual = createHash('sha256').update(await readFile(join(root, relative))).digest('hex');
  assert.equal(actual, expected, `Package file changed: ${relative}`);
  filesVerified++;
}
const requirePackage = createRequire(join(root, 'package.json'));
const { chromium } = requirePackage('playwright');
const token = randomBytes(32).toString('hex');
const port = 43000 + Math.floor(Math.random() * 10000);
const origin = `http://127.0.0.1:${port}`;
const studioEnv = { ...process.env, STUDIO_PORT: String(port), STUDIO_ACCESS_TOKEN: token };
delete studioEnv.STUDIO_MASTER_KEY;
const child = spawn(process.execPath, ['--import', 'tsx/esm', 'scripts/start-studio.ts'], {
  cwd: root,
  env: studioEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (data) => { output += data; });
child.stderr.on('data', (data) => { output += data; });
let browser;
const runtime = [];
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error(`Studio exited: ${child.exitCode}`);
    try {
      const response = await fetch(`${origin}/api/v1/health`, { signal: AbortSignal.timeout(1000) });
      const health = await response.json();
      if (response.ok && health.data?.name === 'Browser Profile Isolation Studio API') { ready = true; break; }
    } catch { /* Startup is asynchronous; bounded readiness polling only. */ }
    await delay(500);
  }
  assert.ok(ready, 'Extracted Studio did not become healthy');
  assert.equal((await fetch(`${origin}/api/v1/profiles`)).status, 401);
  async function api(path, method = 'GET', body) {
    const response = await fetch(`${origin}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(90000),
    });
    const result = await response.json();
    assert.ok(response.ok && result.success, `${method} ${path}: ${result.code} ${result.message ?? ''}`);
    return result.data;
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: 'studio_token', value: token, url: origin, httpOnly: true, sameSite: 'Strict' }]);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  for (const engine of ['firefox', 'chromium']) {
    const name = `Unsigned package ${engine} smoke`;
    const profile = await api('/profiles', 'POST', { name, engine });
    const session = await api(`/profiles/${profile.profileId}/start`, 'POST', { headless: true });
    try {
      await api(`/sessions/${session.sessionId}/open`, 'POST', { url: `${origin}/welcome.html` });
      const view = await api(`/sessions/${session.sessionId}/live-view`);
      assert.ok(view.url.includes('/welcome.html'), 'Managed browser did not navigate');
      runtime.push({ engine, profileId: profile.profileId, state: session.state, navigated: true });
    } finally {
      await api(`/profiles/${profile.profileId}/stop`, 'POST');
    }
    await page.goto(origin);
    await page.locator('#profiles-tbody').getByText(name, { exact: true }).waitFor();
  }
  await page.screenshot({ path: join(evidence, 'studio-dashboard.png'), fullPage: true, animations: 'disabled' });
  await page.locator('#btn-create-profile').click();
  await page.locator('#profile-modal.active').waitFor();
  await page.screenshot({ path: join(evidence, 'studio-ui.png'), fullPage: true, animations: 'disabled' });
  assert.deepEqual(pageErrors, [], 'Studio UI emitted runtime exceptions');
  const capabilities = await api('/product/capabilities');
  assert.equal(capabilities.workerBootstrapByEngine.firefox, false);
  if (process.platform === 'win32') {
    await access(join(root, 'data', '.studio-master-key.dpapi'));
    await assert.rejects(access(join(root, 'data', '.studio-master-key')));
  }
  const metadata = JSON.parse((await readFile(join(root, 'RELEASE-METADATA.json'), 'utf8')).replace(/^\uFEFF/, ''));
  await writeFile(join(evidence, 'runtime-smoke.json'), JSON.stringify({
    result: 'passed', sourceCommit: metadata.sourceCommit, node: process.version,
    platform: process.platform, arch: process.arch, filesVerified,
    studioUi: 'Rendered real public UI, displayed both created profiles, opened new-profile dialog',
    unauthorizedApi: 401, runtime, firefoxWorkerCanvas: 'NOT PASSED',
    masterSecretStorage: process.platform === 'win32' ? 'Windows DPAPI first-run file' : 'local protected file',
    scope: 'Basic extracted-package UI and stock-browser execution; not deep fingerprint or production acceptance',
  }, null, 2));
  console.log('Extracted package Studio UI and Firefox/Chromium runtime smoke passed.');
} finally {
  await browser?.close();
  if (child.exitCode === null) {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
  }
  await writeFile(join(evidence, 'studio.log'), output.replaceAll(token, '[REDACTED]'));
}
