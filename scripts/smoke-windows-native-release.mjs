import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const root = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
assert.match(output, /\.json$/i, 'Smoke report path must end in .json');
const expectedProfileId = process.argv[4];
assert.equal(process.platform, 'win32', 'Native release smoke requires Windows');
assert.equal(process.arch, 'x64', 'Native release smoke requires x64');
const executable = join(root, 'chromium', 'chrome.exe');
const provenance = JSON.parse(await readFile(join(root, 'chromium', 'build-provenance.json'), 'utf8'));
assert.equal(provenance.target, 'win-x64');
const digest = async (path) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};
assert.equal(await digest(executable), provenance.executableSha256, 'Core executable/provenance mismatch');
const token = randomBytes(32).toString('hex');
const port = 43000 + Math.floor(Math.random() * 10000);
const profileName = `Offline native Chromium smoke ${randomBytes(5).toString('hex')}`;
const origin = `http://127.0.0.1:${port}`;
const env = { ...process.env, STUDIO_PORT: String(port), STUDIO_ACCESS_TOKEN: token, npm_config_offline: 'true' };
// The production launcher—not the smoke harness—must establish the native-only contract.
for (const name of ['STUDIO_MASTER_KEY', 'ABS_CHROMIUM_EXECUTABLE_PATH',
  'ABS_REQUIRE_NATIVE_CHROMIUM', 'PLAYWRIGHT_BROWSERS_PATH']) delete env[name];
let profileId;
async function withStudio(callback) {
  const child = spawn('cmd.exe', ['/d', '/c', 'Start-Studio.bat'], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stdout.on('data', (chunk) => { errors = (errors + chunk).slice(-8000); });
  child.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-8000); });
  try {
    let ready = false;
    for (let i = 0; i < 90; i++) {
      if (child.exitCode !== null) throw new Error(`Studio exited before readiness (${child.exitCode}): ${errors.replaceAll(token, '[REDACTED]')}`);
      try {
        const response = await fetch(`${origin}/api/v1/health`, { signal: AbortSignal.timeout(1000) });
        if (response.ok && (await response.json()).data?.name === 'Browser Profile Isolation Studio API') { ready = true; break; }
      } catch { /* Bounded startup wait. */ }
      await delay(500);
    }
    assert.ok(ready, `Studio failed to become ready: ${errors.replaceAll(token, '[REDACTED]')}`);
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
    await callback(api);
  } finally {
    if (child.exitCode === null) {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      await delay(750);
    }
  }
}
await withStudio(async (api) => {
  if (expectedProfileId) {
    const prior = await api('/profiles');
    assert.ok(prior.items.some((profile) => profile.profileId === expectedProfileId),
      'Existing profile missing after package replacement');
  }
  const profile = await api('/profiles', 'POST', { name: profileName, engine: 'chromium' });
  profileId = profile.profileId;
  const session = await api(`/profiles/${profileId}/start`, 'POST', { headless: false });
  try {
    await api(`/sessions/${session.sessionId}/open`, 'POST', { url: `${origin}/welcome.html` });
    const view = await api(`/sessions/${session.sessionId}/live-view`);
    assert.ok(view.url.includes('/welcome.html'), 'Native profile did not navigate using the bundled core');
    const uiBrowser = await chromium.launch({ executablePath: executable, headless: false });
    try {
      const context = await uiBrowser.newContext({ viewport: { width: 1440, height: 1000 } });
      await context.addCookies([{ name: 'studio_token', value: token, url: origin, httpOnly: true, sameSite: 'Strict' }]);
      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.goto(origin);
      await page.locator('#profiles-tbody').getByText(profileName, { exact: true }).waitFor();
      await page.locator('#btn-create-profile').click();
      await page.locator('#profile-modal.active').waitFor();
      await page.screenshot({ path: output.replace(/\.json$/i, '-ui.png'), fullPage: true, animations: 'disabled' });
      assert.deepEqual(pageErrors, [], 'Installed Studio UI emitted browser errors');
    } finally {
      await uiBrowser.close();
    }
  } finally {
    await api(`/profiles/${profileId}/stop`, 'POST');
  }
});
const key = join(root, 'data', '.studio-master-key.dpapi');
const before = await digest(key);
await withStudio(async (api) => {
  const profiles = await api('/profiles');
  assert.ok(profiles.items.some((profile) => profile.profileId === profileId), 'Persisted profile missing after restart');
});
assert.equal(await digest(key), before, 'Encrypted master key changed on restart');
await writeFile(output, JSON.stringify({ result: 'passed', target: 'win-x64', engine: 'native Chromium',
  profileId,
  previousProfilePreserved: expectedProfileId ? true : undefined,
  nativeExecutableSha256: provenance.executableSha256, offlineDependencyInstall: 'none',
  unauthorizedApi: 401, profilePersistedAfterRestart: true, dpapiMasterKeyPreserved: true,
  studioUi: 'Rendered public UI and profile, opened create-profile modal in the packaged native browser',
  scope: 'Installed native Chromium launch, local navigation and restart; not code signing or deep fingerprint acceptance',
}, null, 2));
console.log('Installed native Chromium profile and data persistence smoke passed.');
