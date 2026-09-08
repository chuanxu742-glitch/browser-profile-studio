import { beforeEach, describe, expect, it, vi } from 'vitest';
import { managedBrowserIdentity } from '../../src/fingerprint/runtime-identity.js';
import { generateFingerprint } from '../../src/fingerprint/generator.js';

const mocks = vi.hoisted(() => ({ launch: vi.fn(), connect: vi.fn(), nativeCore: vi.fn() }));
vi.mock('playwright', () => ({ chromium: { launchPersistentContext: mocks.launch } }));
vi.mock('../../src/browser/raw-cdp-connection.js', () => ({ RawCdpConnection: { connect: mocks.connect } }));
vi.mock('../../src/browser/custom-chromium-runtime.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/browser/custom-chromium-runtime.js')>(),
  resolveVerifiedChromiumCore: mocks.nativeCore,
}));
import { launchPersistentChromium, usesNativeChromiumProfile } from '../../src/browser/chromium-launcher.js';
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
});
