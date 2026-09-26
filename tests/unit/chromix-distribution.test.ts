import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProfileStore } from '../../src/profile/profile-store.js';
import type { ProfileMetadata } from '../../src/profile/types.js';
import { BrowserSession } from '../../src/browser/browser-session.js';
import { SessionManager } from '../../src/browser/session-manager.js';
import { chromixProfileArgs, resolveVerifiedChromix } from '../../src/browser/chromix-runtime.js';
import { generateFingerprint } from '../../src/fingerprint/generator.js';
import { CHROMIX_RELEASE } from '../../src/fingerprint/runtime-identity.js';
import { gpuModelSku } from '../../src/fingerprint/runtime-probe.js';
import { selectNativeGpuIdentity } from '../../src/fingerprint/native-gpu.js';
import { ProfileBackupService } from '../../src/security/profile-backup.js';
import { SecretVault } from '../../src/security/secret-vault.js';

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'chromix-runtime-test-')));
  scratch.push(root);
  const binary = join(root, 'chrome.exe');
  const library = join(root, 'chrome.dll');
  const resource = join(root, 'locales', 'en-US.pak');
  await mkdir(dirname(resource));
  await writeFile(binary, 'fixture PE executable');
  await writeFile(library, 'fixture DLL');
  await writeFile(resource, 'fixture resource');
  const manifest = {
    schemaVersion: 1, distribution: 'chromix-152', browserVersion: CHROMIX_RELEASE.browserVersion,
    archiveSha256: CHROMIX_RELEASE.archiveSha256,
    files: { 'chrome.exe': digest('fixture PE executable'), 'chrome.dll': digest('fixture DLL'),
      'locales/en-US.pak': digest('fixture resource') },
  };
  const manifestPath = join(root, 'chromix-install.json');
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { root, binary, library, resource, manifest, manifestPath };
}

describe('explicit Chromix distribution', () => {
  it('requires an explicit executable path', async () => {
    await expect(resolveVerifiedChromix({})).rejects.toThrow('CHROMIX_PATH_REQUIRED');
  });
  it.skipIf(process.platform !== 'win32')('refuses a wrong archive digest without falling back', async () => {
    const install = await fixture();
    await writeFile(install.manifestPath, JSON.stringify({ ...install.manifest, archiveSha256: '0'.repeat(64) }));
    await expect(resolveVerifiedChromix({ CHROMIX_EXECUTABLE_PATH: install.binary }))
      .rejects.toThrow('CHROMIX_MANIFEST_MISMATCH');
  });
  it.skipIf(process.platform !== 'win32')('refuses forged self-described binary and library hashes, including resource swaps', async () => {
    const install = await fixture();
    await expect(resolveVerifiedChromix({ CHROMIX_EXECUTABLE_PATH: install.binary }))
      .rejects.toThrow('CHROMIX_MANIFEST_MISMATCH');
    install.manifest.files['chrome.exe'] = 'f37fdf5e7bfad0c1885c9200b9cda5bee51e76975277429e20b8b76625c0abfc';
    install.manifest.files['chrome.dll'] = '2475c0e9e8ce254c0d70e5556ffa1f778a54ed812489a0b107a6de838a826f3b';
    await writeFile(install.manifestPath, JSON.stringify(install.manifest));
    await expect(resolveVerifiedChromix({ CHROMIX_EXECUTABLE_PATH: install.binary }))
      .rejects.toThrow('CHROMIX_MANIFEST_MISMATCH');
    await writeFile(install.resource, 'tampered resource');
    install.manifest.files['locales/en-US.pak'] = digest('tampered resource');
    await writeFile(install.manifestPath, JSON.stringify(install.manifest));
    await expect(resolveVerifiedChromix({ CHROMIX_EXECUTABLE_PATH: install.binary }))
      .rejects.toThrow('CHROMIX_MANIFEST_MISMATCH');
  });
  it('pins a separate 152 fingerprint and released source flag names', () => {
    const profile = generateFingerprint({ engine: 'chromium', browserDistribution: 'chromix-152',
      seed: 21, os: 'windows', countryCode: 'US' });
    expect(profile.browserVersion).toBe('152.0.7977.82');
    expect(profile.userAgent).toContain('Chrome/152.0.7977.82');
    const args = chromixProfileArgs({ headless: true, fingerprintProfile: profile,
      locale: profile.geo.locale, timezoneId: profile.geo.timezoneId });
    expect(args).toContain(`--fingerprint-taskbar-height=${profile.screen.height - profile.screen.availHeight}`);
    expect(args).toContain(`--fingerprint-hardware-concurrency=${profile.hardware.hardwareConcurrency}`);
    expect(args).toContain('--fingerprint-platform=windows');
    expect(args).toContain('--fingerprint-brand=Chrome');
    expect(args).toContain(`--fingerprint-platform-version=${profile.platformVersion}`);
    expect(args).toContain('--fingerprint-noise=false');
    expect(args.some(arg => arg.startsWith('--abs-'))).toBe(false);
    expect(profile.canvas.enabled).toBe(false);
    expect(profile.audio.enabled).toBe(false);
    const zeroSeed = { ...profile, canvas: { ...profile.canvas, seed: 0 } };
    expect(() => chromixProfileArgs({ headless: true, fingerprintProfile: zeroSeed,
      locale: profile.geo.locale, timezoneId: profile.geo.timezoneId })).toThrow('CHROMIX_FINGERPRINT_SEED_INVALID');
    expect(() => generateFingerprint({ engine: 'chromium', browserDistribution: 'chromix-152',
      browserVersion: '151.0.7922.34' })).toThrow('CHROMIX_PROFILE_VERSION_MISMATCH');
  });
  it('preserves fallback languages after native locale normalization and enforces explicit font policy', () => {
    const profile = generateFingerprint({ engine: 'chromium', browserDistribution: 'chromix-152',
      os: 'windows', countryCode: 'JP', fontAllowlist: ['Yu Gothic', 'Arial'] });
    expect(profile.geo.languages).toEqual(['ja-JP', 'ja', 'en-US', 'en']);
    const options = { headless: true, fingerprintProfile: profile, locale: profile.geo.locale,
      timezoneId: profile.geo.timezoneId };
    const args = chromixProfileArgs(options);
    expect(args).toContain('--fingerprint-locale=ja-JP');
    expect(args).toContain('--uxr-languages=ja-JP,ja,en-US,en');
    expect(args).toContain('--fingerprint-font-policy=restricted');
    expect(args).toContain('--fingerprint-font-whitelist=Yu Gothic,Arial');
    const invalid = generateFingerprint({ engine: 'chromium', browserDistribution: 'chromix-152',
      os: 'windows', fontAllowlist: ['Arial, Helvetica'] });
    expect(() => chromixProfileArgs({ headless: true, fingerprintProfile: invalid,
      locale: invalid.geo.locale, timezoneId: invalid.geo.timezoneId })).toThrow('CHROMIX_FONT_POLICY_INVALID');
  });
  it('admits the catalogued physical Intel Arc A770 despite trademark markers', () => {
    const glRenderer = 'ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)';
    expect(gpuModelSku(glRenderer)).toBe('ARCA770');
    expect(selectNativeGpuIdentity({
      vendorId: 0x8086, deviceString: 'Intel(R) Arc(TM) A770 Graphics', glRenderer,
      featureStatus: { gpu_compositing: 'enabled' },
    })).toMatchObject({ vendorId: 0x8086, unmaskedRenderer: glRenderer });
  });
  it('keeps saved identity immutable and separates browser data directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chromix-profile-test-'));
    scratch.push(root);
    const store = new ProfileStore(root);
    const chromix = await store.createProfile({ name: 'Chromix', engine: 'chromium', browserDistribution: 'chromix-152' });
    expect((await store.listProfiles())[0]?.browserDistribution).toBe('chromix-152');
    const zeroSeed = await store.createProfile({ name: 'Normalized seed', engine: 'chromium',
      browserDistribution: 'chromix-152', fingerprint: { seed: 0 } });
    expect(zeroSeed.fingerprint?.seed).toBe(1);
    expect((await store.getProfile(zeroSeed.profileId))?.fingerprint?.seed).toBe(1);
    await expect(store.updateProfile(chromix.profileId, { engine: 'firefox' })).rejects.toThrow('cannot change');
    const removal: Partial<ProfileMetadata> = {};
    Reflect.set(removal, 'browserDistribution', undefined);
    await expect(store.updateProfile(chromix.profileId, removal)).rejects.toThrow('cannot change');
    await expect(store.updateProfile(chromix.profileId, { browserDistribution: 'playwright-stock' })).rejects.toThrow('cannot change');
    await expect(store.updateProfile(chromix.profileId, { profileId: 'prf_other' })).rejects.toThrow('cannot change');
    await expect(store.createProfile({ name: 'Invalid', engine: 'firefox', browserDistribution: 'chromix-152' }))
      .rejects.toThrow('Chromium distribution');
    const legacy = await store.createProfile({ name: 'Legacy', engine: 'chromium' });
    expect(legacy.browserDistribution).toBeUndefined();
    await expect(store.updateProfile(legacy.profileId, { browserDistribution: 'chromix-152' })).rejects.toThrow('cannot change');
    const legacySession = new BrowserSession({ engine: 'chromium', profileRoot: root,
      profileName: chromix.profileId, persistentProfile: true });
    const chromixSession = new BrowserSession({ engine: 'chromium', browserDistribution: 'chromix-152',
      profileRoot: root, profileName: chromix.profileId, persistentProfile: true });
    expect(chromixSession.profileDirectory).not.toBe(legacySession.profileDirectory);
    expect(chromixSession.profileDirectory).toBe(join(store.getProfileDir(chromix.profileId), 'chromix-152-browser'));
    expect(chromixSession.status().browserDistribution).toBe('chromix-152');
    expect(chromixSession.status().browserVersion).toBeUndefined();
  });
  it('deletes, restores and purges native browser data with its saved profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chromix-lifecycle-test-'));
    scratch.push(root);
    const store = new ProfileStore(root);
    const profile = await store.createProfile({ name: 'Lifecycle', engine: 'chromium', browserDistribution: 'chromix-152' });
    const browserDir = join(store.getProfileDir(profile.profileId), 'chromix-152-browser');
    await mkdir(browserDir);
    const state = join(browserDir, 'Cookies');
    await writeFile(state, 'isolated browser state');
    expect(await store.deleteProfile(profile.profileId)).toBe(true);
    const firstDeleted = (await store.listDeletedProfiles())[0]!;
    const trashState = join(root, '.trash', `${profile.profileId}--${firstDeleted.deletedAt}`, 'chromix-152-browser', 'Cookies');
    expect(await readFile(trashState, 'utf8')).toBe('isolated browser state');
    await store.restoreProfile(profile.profileId);
    expect(await readFile(state, 'utf8')).toBe('isolated browser state');
    await store.deleteProfile(profile.profileId);
    const finalDeleted = (await store.listDeletedProfiles())[0]!;
    const finalTrashState = join(root, '.trash', `${profile.profileId}--${finalDeleted.deletedAt}`, 'chromix-152-browser', 'Cookies');
    expect(await readFile(finalTrashState, 'utf8')).toBe('isolated browser state');
    expect(await store.purgeDeletedProfile(profile.profileId)).toBe(true);
    await expect(readFile(finalTrashState)).rejects.toThrow();
    expect(await store.listDeletedProfiles()).toEqual([]);
  });
  it('includes isolated browser state in a complete encrypted profile backup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chromix-backup-test-'));
    scratch.push(root);
    const store = new ProfileStore(root);
    const profile = await store.createProfile({ name: 'Backup', engine: 'chromium', browserDistribution: 'chromix-152' });
    const browserDir = join(store.getProfileDir(profile.profileId), 'chromix-152-browser');
    await mkdir(browserDir);
    await writeFile(join(browserDir, 'Cookies'), 'native session state');
    const backup = join(root, 'profile.backup');
    const vault = new SecretVault('core-backup-key-1234567890123456');
    const service = new ProfileBackupService();
    await service.backup(profile.profileId, store.getProfileDir(profile.profileId), backup, vault);
    const restored = join(root, 'restored');
    await service.restore(backup, restored, vault, profile.profileId);
    expect(await readFile(join(restored, 'chromix-152-browser', 'Cookies'), 'utf8')).toBe('native session state');
  });
  it('rejects saved-profile distribution and engine overrides before discovery or launch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chromix-manager-test-'));
    scratch.push(root);
    const store = new ProfileStore(root);
    const profile = await store.createProfile({ name: 'Managed', engine: 'chromium', browserDistribution: 'chromix-152',
      geo: { countryCode: 'US', timezone: 'America/New_York', locale: 'en-US' } });
    const discovery = vi.fn(async () => { throw new Error('CHROMIX_PATH_REQUIRED: fixture has no verified executable'); });
    const manager = new SessionManager({ cluster: false, profileStore: store, profileRoot: root,
      nativeGpuDiscovery: discovery });
    await expect(manager.start({ profileId: profile.profileId, engine: 'firefox' }))
      .rejects.toThrow('cannot be overridden');
    await expect(manager.start({ profileId: profile.profileId, browserDistribution: 'playwright-stock' }))
      .rejects.toThrow('cannot be overridden');
    await expect(manager.start({ profileId: profile.profileId, fingerprintSeed: 99 }))
      .rejects.toThrow('identity cannot be overridden');
    for (const override of [
      { countryCode: 'JP' }, { countryCode: 'US' }, { timezone: 'Asia/Tokyo' },
      { locale: 'ja-JP' }, { geolocation: { latitude: 35, longitude: 139 } },
      { viewport: { width: 1280, height: 720 } }, { seed: 42 },
      { fingerprint: false }, { userAgent: 'Changed identity' }, { cdpEndpoint: 'http://localhost:9222' },
    ]) {
      await expect(manager.start({ profileId: profile.profileId, ...override }))
        .rejects.toThrow('identity cannot be overridden');
    }
    expect(discovery).not.toHaveBeenCalled();
    await expect(manager.start({ profileId: profile.profileId, headless: true }))
      .rejects.toThrow(process.platform === 'win32' ? 'CHROMIX_PATH_REQUIRED' : 'Native release persona requires Windows GPU identity');
  });
  it.skipIf(process.platform !== 'win32')('commits a Chromix persona only after successful admission and serializes concurrent edits across stores', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chromix-admission-test-'));
    scratch.push(root);
    const store = new ProfileStore(root);
    const secondStore = new ProfileStore(root);
    const profile = await store.createProfile({ name: 'Stable', engine: 'chromium',
      browserDistribution: 'chromix-152', fingerprint: { seed: 51, os: 'windows' },
      geo: { countryCode: 'US', timezone: 'America/New_York', locale: 'en-US' } });
    const metadataPath = store.getMetadataPath(profile.profileId);
    const preMarker = JSON.parse(await readFile(metadataPath, 'utf8'));
    delete preMarker.chromixIdentityCommitted;
    await writeFile(metadataPath, JSON.stringify(preMarker));
    const gpu = { unmaskedVendor: 'Google Inc. (Intel)',
      unmaskedRenderer: 'ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
      vendorId: 0x8086, deviceString: 'Intel(R) Arc(TM) A770 Graphics' };
    let fail = true;
    let entered!: () => void;
    let release!: () => void;
    const enteredStart = new Promise<void>(resolve => { entered = resolve; });
    const finishStart = new Promise<void>(resolve => { release = resolve; });
    const status = { state: 'READY', sessionId: 'ses_chromix_identity_test', headless: true,
      pageGeneration: 0, queueDepth: 0, challenge: { detected: false } };
    let observedGeo: { countryCode: string | undefined; locale: string | undefined; timezoneId: string | undefined } | undefined;
    const manager = new SessionManager({ cluster: false, profileStore: store, profileRoot: root,
      countryCode: 'JP', locale: 'ja-JP', timezoneId: 'Asia/Tokyo',
      nativeGpuDiscovery: async () => gpu,
      sessionFactory: options => {
        observedGeo = { countryCode: options.countryCode, locale: options.locale, timezoneId: options.timezoneId };
        return {
          sessionId: status.sessionId,
          start: async () => {
            if (fail) throw new Error('simulated browser launch failure');
            entered();
            await finishStart;
            return status;
          },
          stop: async () => status,
          status: () => status,
        } as unknown as BrowserSession;
      },
    });
    try {
      await expect(manager.start({ profileId: profile.profileId, headless: true }))
        .rejects.toThrow('simulated browser launch failure');
      expect((await store.getProfile(profile.profileId))?.chromixIdentityCommitted).toBe(false);
      await secondStore.updateProfile(profile.profileId, { fingerprint: { seed: 52 } });
      fail = false;
      const starting = manager.start({ profileId: profile.profileId, headless: true });
      await enteredStart;
      const racingEdit = secondStore.updateProfile(profile.profileId, { fingerprint: { seed: 53 } });
      expect((await secondStore.getProfile(profile.profileId))?.fingerprint?.seed).toBe(52);
      release();
      await starting;
      expect(observedGeo).toEqual({ countryCode: 'US', locale: 'en-US', timezoneId: 'America/New_York' });
      await expect(racingEdit).rejects.toThrow('CHROMIX_IDENTITY_COMMITTED');
      const committed = await secondStore.getProfile(profile.profileId);
      expect(committed?.chromixIdentityCommitted).toBe(true);
      expect(committed?.fingerprint?.seed).toBe(52);
      await expect(secondStore.updateProfile(profile.profileId, { fingerprint: { seed: 52 } })).resolves.toBeDefined();
      await expect(secondStore.updateProfile(profile.profileId, { name: 'Renamed' })).resolves.toMatchObject({ name: 'Renamed' });
    } finally {
      release();
      await manager.shutdown();
    }
  });
});
