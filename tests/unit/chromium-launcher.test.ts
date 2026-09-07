import { beforeEach, describe, expect, it, vi } from 'vitest';
import { managedBrowserIdentity } from '../../src/fingerprint/runtime-identity.js';
import { generateFingerprint } from '../../src/fingerprint/generator.js';

const mocks = vi.hoisted(() => ({ launch: vi.fn(), connect: vi.fn() }));
vi.mock('playwright', () => ({ chromium: { launchPersistentContext: mocks.launch } }));
vi.mock('../../src/browser/raw-cdp-connection.js', () => ({ RawCdpConnection: { connect: mocks.connect } }));
import { launchPersistentChromium } from '../../src/browser/chromium-launcher.js';

describe('managed Chromium startup', () => {
  beforeEach(() => vi.resetAllMocks());
  function fixture() {
    const context = { browser: () => ({ version: () => managedBrowserIdentity('chromium').fullVersion }),
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
  it('fails startup if both worker identity override methods fail', async () => {
    const context = fixture();
    const close = vi.fn();
    mocks.connect.mockResolvedValue({ close, onEvent: vi.fn(), send: vi.fn(async (method: string) => {
      if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'worker', type: 'service_worker' }] };
      if (method === 'Target.attachToTarget') return { sessionId: 'session' };
      if (method.endsWith('setUserAgentOverride')) throw new Error('fixture unsupported override');
      return {};
    }) });
    await expect(launchPersistentChromium('fixture-profile', { headless: true,
      fingerprintProfile: generateFingerprint({ engine: 'chromium' }) })).rejects.toThrow('SERVICE_WORKER_FINGERPRINT_SETUP_FAILED');
    expect(close).toHaveBeenCalled();
    expect(context.close).toHaveBeenCalled();
  });
});
