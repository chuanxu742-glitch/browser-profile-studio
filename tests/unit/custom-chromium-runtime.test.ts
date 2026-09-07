import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXPECTED_CHROMIUM_CORE, nativeChromiumProfileArgs, resolveVerifiedChromiumCore } from '../../src/browser/custom-chromium-runtime.js';
import { generateFingerprint } from '../../src/fingerprint/generator.js';
import { managedBrowserIdentity } from '../../src/fingerprint/runtime-identity.js';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'abs-core-test-'));
  directories.push(directory);
  const executablePath = join(directory, 'chrome');
  await writeFile(executablePath, 'test executable');
  const provenance = { schemaVersion: 1, engine: 'chromium', target: 'linux-x64',
    browserVersion: managedBrowserIdentity('chromium').fullVersion,
    chromiumRevision: EXPECTED_CHROMIUM_CORE.chromiumRevision,
    playwrightVersion: EXPECTED_CHROMIUM_CORE.playwrightVersion,
    patches: [
      { path: EXPECTED_CHROMIUM_CORE.patchPath, sha256: String(EXPECTED_CHROMIUM_CORE.patchSha256) },
      { path: EXPECTED_CHROMIUM_CORE.renderingPatchPath, sha256: String(EXPECTED_CHROMIUM_CORE.renderingPatchSha256) },
    ],
    executableSha256: createHash('sha256').update('test executable').digest('hex') };
  const provenancePath = join(directory, 'build-provenance.json');
  await writeFile(provenancePath, JSON.stringify(provenance));
  return { executablePath, provenance, provenancePath };
}

describe('custom Chromium runtime', () => {
  it('keeps the managed build by default and rejects relative paths', async () => {
    expect(await resolveVerifiedChromiumCore({})).toBeUndefined();
    await expect(resolveVerifiedChromiumCore({ ABS_CHROMIUM_EXECUTABLE_PATH: './chrome' })).rejects.toThrow('PATH_INVALID');
  });
  it('checks provenance and executable hash', async () => {
    const core = await fixture();
    expect(await resolveVerifiedChromiumCore({ ABS_CHROMIUM_EXECUTABLE_PATH: core.executablePath }))
      .toEqual({ executablePath: core.executablePath });
    await writeFile(core.executablePath, 'changed executable');
    await expect(resolveVerifiedChromiumCore({ ABS_CHROMIUM_EXECUTABLE_PATH: core.executablePath }))
      .rejects.toThrow('HASH_MISMATCH');
  });
  it('rejects a different native patch despite a matching executable', async () => {
    const core = await fixture();
    core.provenance.patches[0]!.sha256 = '0'.repeat(64);
    await writeFile(core.provenancePath, JSON.stringify(core.provenance));
    await expect(resolveVerifiedChromiumCore({ ABS_CHROMIUM_EXECUTABLE_PATH: core.executablePath }))
      .rejects.toThrow('PROVENANCE_MISMATCH');
  });
  it('matches the checked-in native source and patch lock', async () => {
    const lock = JSON.parse(await readFile(new URL('../../browser-core/chromium/core.lock.json', import.meta.url), 'utf8'));
    expect(lock.chromiumRevision).toBe(EXPECTED_CHROMIUM_CORE.chromiumRevision);
    expect(lock.patches[0].sha256).toBe(EXPECTED_CHROMIUM_CORE.patchSha256);
    expect(lock.patches[1].sha256).toBe(EXPECTED_CHROMIUM_CORE.renderingPatchSha256);
    expect(lock.browserVersion).toBe(managedBrowserIdentity('chromium').fullVersion);
  });
  it('derives all native flags from one profile and validates conflicting values', () => {
    const profile = generateFingerprint({ engine: 'chromium', os: 'linux', countryCode: 'FR', seed: 7 });
    const options = { headless: true, fingerprintProfile: profile };
    const args = nativeChromiumProfileArgs(options);
    expect(args).toContain(`--abs-timezone=${profile.geo.timezoneId}`);
    expect(args).toContain(`--abs-languages=${profile.geo.languages.join(',')}`);
    expect(args).toContain(`--abs-hardware-concurrency=${profile.hardware.hardwareConcurrency}`);
    expect(args).toContain(`--abs-device-memory=${profile.hardware.deviceMemory}`);
    expect(args).toContain(`--abs-canvas-seed=${profile.canvas.seed}`);
    expect(args).toContain(`--abs-audio-seed=${profile.audio.seed}`);
    expect(args).toContain(`--abs-webgl-renderer=${profile.webgl.unmaskedRenderer}`);
    expect(args.some(value => value.startsWith('--abs-font-allowlist='))).toBe(true);
    expect(() => nativeChromiumProfileArgs({ ...options, locale: 'ja-JP' })).toThrow('LANGUAGE_MISMATCH');
    expect(() => nativeChromiumProfileArgs({ ...options, timezoneId: 'Invalid/Zone' })).toThrow();
    expect(nativeChromiumProfileArgs({ headless: true, timezoneId: 'europe/paris' }))
      .toContain('--abs-timezone=Europe/Paris');
    expect(() => nativeChromiumProfileArgs({ headless: true, timezoneId: '+08:00' })).toThrow();
    expect(() => nativeChromiumProfileArgs({ ...options, fingerprintProfile: {
      ...profile, hardware: { ...profile.hardware, hardwareConcurrency: 0 },
    } })).toThrow('CORES_INVALID');
  });
  it('rejects old single-patch builds', async () => {
    const core = await fixture();
    core.provenance.patches.pop();
    await writeFile(core.provenancePath, JSON.stringify(core.provenance));
    await expect(resolveVerifiedChromiumCore({ ABS_CHROMIUM_EXECUTABLE_PATH: core.executablePath }))
      .rejects.toThrow('PROVENANCE_MISMATCH');
  });
  it('supports seed zero, leaves disabled surfaces alone and validates font settings', () => {
    const profile = generateFingerprint({ engine: 'chromium', os: 'linux', seed: 7 });
    const args = nativeChromiumProfileArgs({ headless: true, fingerprintProfile: {
      ...profile, canvas: { enabled: true, seed: 0 }, audio: { enabled: false, seed: 5 },
      webgpu: { supported: false },
    } }, { ABS_CHROMIUM_FONT_ALLOWLIST: 'Liberation Sans, Liberation Mono' });
    expect(args).toContain('--abs-canvas-seed=0');
    expect(args.some(value => value.startsWith('--abs-audio-seed='))).toBe(false);
    expect(args).toContain('--abs-webgpu-disabled=1');
    expect(args).toContain('--abs-font-allowlist=Liberation Sans,Liberation Mono');
    expect(() => nativeChromiumProfileArgs({ headless: true, fingerprintProfile: profile },
      { ABS_CHROMIUM_FONT_ALLOWLIST: 'Arial,,Consolas' })).toThrow('FONTS_INVALID');
    expect(() => nativeChromiumProfileArgs({ headless: true, fingerprintProfile: {
      ...profile, canvas: { enabled: true, seed: -1 },
    } }, {})).toThrow('CANVAS_SEED_INVALID');
  });
});
