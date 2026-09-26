import { beforeEach, describe, expect, it, vi } from 'vitest';
import { managedBrowserIdentity } from '../../src/fingerprint/runtime-identity.js';
import { generateFingerprint } from '../../src/fingerprint/generator.js';

const mocks = vi.hoisted(() => ({ launch: vi.fn(), connect: vi.fn(), nativeCore: vi.fn(), chromixCore: vi.fn() }));
vi.mock('playwright', () => ({ chromium: { launchPersistentContext: mocks.launch } }));
vi.mock('../../src/browser/raw-cdp-connection.js', () => ({ RawCdpConnection: { connect: mocks.connect } }));
vi.mock('../../src/browser/custom-chromium-runtime.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/browser/custom-chromium-runtime.js')>(),
  resolveVerifiedChromiumCore: mocks.nativeCore,
}));
vi.mock('../../src/browser/chromix-runtime.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/browser/chromix-runtime.js')>(),
  resolveVerifiedChromix: mocks.chromixCore,
}));
import { launchPersistentChromium, observedChromiumVersion, usesNativeChromiumProfile } from '../../src/browser/chromium-launcher.js';
import { buildStealthInjectionScript } from '../../src/fingerprint/stealth-scripts.js';

describe('managed Chromium startup', () => {
  beforeEach(() => vi.resetAllMocks());
  function fixture() {
    const context = { browser: () => ({ version: () => managedBrowserIdentity('chromium').fullVersion }),
      _connection: { toImpl: () => ({ _browser: { _connection: {
        _transport: { send: vi.fn(), onmessage: vi.fn() }, _sessions: new Map(),
      } } }) },
      close: vi.fn().mockResolvedValue(undefined), on: vi.fn(), pages: () => [],
      addInitScript: vi.fn().mockResolvedValue(undefined) };
    mocks.launch.mockResolvedValue(context);
    return context;
  }
  it('preserves TLS validation and avoids unsupported automation switches', async () => {
    fixture();
    await launchPersistentChromium('fixture-profile', { headless: true });
    const config = mocks.launch.mock.calls[0]![1];
    expect(config.ignoreHTTPSErrors).toBe(false);
    expect(config.args).not.toContain('--ignore-certificate-errors');
    expect(config.args).not.toContain('--excludeSwitches=enable-automation');
    expect(config.args).not.toContain('--disable-ipc-flooding-protection');
  });
  it('closes the browser if the initialization script cannot be installed', async () => {
    const context = fixture();
    context.addInitScript.mockRejectedValue(new Error('fixture injection failed'));
    await expect(launchPersistentChromium('fixture-profile', { headless: true, initScript: 'void 0' }))
      .rejects.toThrow('fixture injection failed');
    expect(context.close).toHaveBeenCalled();
  });
  it('lets an embedding service own signal shutdown without a second browser close', async () => {
    fixture();
    await launchPersistentChromium('fixture-profile', { headless: true, handleProcessSignals: false });
    expect(mocks.launch.mock.calls[0]![1]).toMatchObject({ handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
    await launchPersistentChromium('fixture-profile', { headless: true });
    expect(mocks.launch.mock.calls[1]![1]).not.toHaveProperty('handleSIGTERM');
  });
  it('uses the verified native executable and process-level locale/timezone flags', async () => {
    fixture();
    mocks.nativeCore.mockResolvedValue({ executablePath: '/opt/abs-chromium/chrome' });
    await launchPersistentChromium('native-profile', { headless: true, locale: 'fr-FR', timezoneId: 'Europe/Paris' });
    const config = mocks.launch.mock.calls[0]![1];
    expect(config.executablePath).toBe('/opt/abs-chromium/chrome');
    expect(config.args).toContain('--abs-locale=fr-FR');
    expect(config.args).toContain('--abs-timezone=Europe/Paris');
    expect(config.args).toContain('--accept-lang=fr-FR');
  });
  it('closes the browser if the worker identity override fails', async () => {
    const context = fixture();
    const close = vi.fn();
    mocks.connect.mockResolvedValue({ close, onEvent: vi.fn(), send: vi.fn(async (method: string) => {
      if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'worker', type: 'service_worker' }] };
      if (method === 'Target.attachToTarget') return { sessionId: 'session' };
      if (method.endsWith('setUserAgentOverride')) throw new Error('fixture unsupported override');
      return {};
    }) });
    await expect(launchPersistentChromium('fixture-profile', { headless: true,
      fingerprintProfile: generateFingerprint({ engine: 'chromium' }) })).rejects.toThrow('WORKER_FINGERPRINT_SETUP_FAILED');
    expect(close).toHaveBeenCalled();
    expect(context.close).toHaveBeenCalled();
  });
  it('regenerates only the managed fingerprint script and preserves caller scripts', async () => {
    const context = fixture();
    mocks.nativeCore.mockResolvedValue({ executablePath: '/opt/abs-chromium/chrome' });
    mocks.connect.mockResolvedValue({ close: vi.fn(), onEvent: vi.fn(), send: vi.fn(async () => ({ targetInfos: [] })) });
    const profile = generateFingerprint({ engine: 'chromium', os: 'linux' });
    await launchPersistentChromium('native-profile', { headless: true, fingerprintProfile: profile,
      managedFingerprintInitScript: true, initScript: buildStealthInjectionScript(profile) });
    expect(context.addInitScript).toHaveBeenCalledWith(buildStealthInjectionScript(profile, { nativeChromium: true }));
    expect(usesNativeChromiumProfile(context)).toBe(true);
    context.addInitScript.mockClear();
    await launchPersistentChromium('native-profile', { headless: true, fingerprintProfile: profile,
      initScript: 'globalThis.applicationSetting = 42' });
    expect(context.addInitScript).toHaveBeenCalledWith('globalThis.applicationSetting = 42');
  });
  it('does not launch a stock browser when explicit Chromix installation is missing', async () => {
    mocks.chromixCore.mockRejectedValue(new Error('CHROMIX_PATH_REQUIRED'));
    await expect(launchPersistentChromium('chromix-data', {
      headless: true, browserDistribution: 'chromix-152',
    })).rejects.toThrow('CHROMIX_PATH_REQUIRED');
    expect(mocks.nativeCore).not.toHaveBeenCalled();
    expect(mocks.launch).not.toHaveBeenCalled();
  });
  it('refuses explicit project-native-151 when its verified core is absent', async () => {
    mocks.nativeCore.mockResolvedValue(undefined);
    await expect(launchPersistentChromium('native-data', {
      headless: true, browserDistribution: 'project-native-151',
    })).rejects.toThrow('NATIVE_CHROMIUM_REQUIRED');
    expect(mocks.launch).not.toHaveBeenCalled();
  });
  it('closes a running Chromix context when actual browser-target CDP version differs', async () => {
    const context = fixture();
    mocks.chromixCore.mockResolvedValue({ executablePath: 'C:\\test\\chromix\\chrome.exe' });
    mocks.connect.mockResolvedValue({
      send: vi.fn().mockResolvedValue({ product: 'Chrome/153.0.0.0' }), close: vi.fn(),
    });
    const profile = generateFingerprint({ engine: 'chromium', browserDistribution: 'chromix-152', os: 'windows' });
    await expect(launchPersistentChromium('chromix-data', {
      headless: true, browserDistribution: 'chromix-152', fingerprintProfile: profile,
      locale: profile.geo.locale, timezoneId: profile.geo.timezoneId,
    })).rejects.toThrow('BROWSER_RUNTIME_VERSION_MISMATCH');
    expect(context.close).toHaveBeenCalled();
    expect(mocks.nativeCore).not.toHaveBeenCalled();
  });
  it('uses browser-target CDP identity and physical GPU before admitting the 152 persona', async () => {
    const context = fixture();
    mocks.chromixCore.mockResolvedValue({ executablePath: 'C:\\test\\chromix\\chrome.exe' });
    const profile = generateFingerprint({ engine: 'chromium', browserDistribution: 'chromix-152',
      os: 'windows', countryCode: 'JP', gpu: { unmaskedVendor: 'Google Inc. (NVIDIA)',
        unmaskedRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)' } });
    const send = vi.fn(async (method: string) => method === 'Browser.getVersion'
      ? { product: 'Chrome/152.0.7977.82' }
      : { gpu: { devices: [{ vendorId: 0x10de, deviceString: 'NVIDIA GeForce RTX 4070', active: true }],
        auxAttributes: { glRenderer: profile.webgl.unmaskedRenderer },
        featureStatus: { gpu_compositing: 'enabled' } } });
    mocks.connect.mockResolvedValue({ send, close: vi.fn() });
    await launchPersistentChromium('chromix-data', {
      headless: true, browserDistribution: 'chromix-152', fingerprintProfile: profile,
      locale: profile.geo.locale, timezoneId: profile.geo.timezoneId,
    });
    expect(observedChromiumVersion(context)).toBe('152.0.7977.82');
    expect(context.addInitScript).not.toHaveBeenCalled();
    expect(mocks.connect).toHaveBeenCalledWith('chromix-data');
    expect(mocks.launch.mock.calls[0]![1].executablePath).toBe('C:\\test\\chromix\\chrome.exe');
    const config = mocks.launch.mock.calls[0]![1];
    expect(config).not.toHaveProperty('locale');
    expect(config.extraHTTPHeaders['Accept-Language']).toBe('ja-JP,ja,en-US,en');
    expect(config.args).toContain('--uxr-languages=ja-JP,ja,en-US,en');
  });
});
