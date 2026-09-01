import { describe, expect, it, vi } from 'vitest';
import { ExternalRuntimeRegistry } from '../../src/platform/provider-registry.js';

describe('ExternalRuntimeRegistry', () => {
  it('creates and stops a real provider runtime through the shared cloud/Android boundary', async () => {
    const stop = vi.fn(async () => undefined);
    const registry = new ExternalRuntimeRegistry();
    registry.register({
      id: 'android-lab',
      name: 'Android Lab',
      kind: 'android-cloud-phone',
      configured: true,
      health: async () => ({ available: true }),
      create: async (options) => ({ runtimeId: `phone-${String(options.region)}`, connectionUrl: 'wss://runtime.example.test/session/phone-cn' }),
      stop,
    });

    await expect(registry.create('android-lab', { region: 'cn' })).resolves.toEqual({
      providerId: 'android-lab',
      kind: 'android-cloud-phone',
      runtimeId: 'phone-cn',
      connectionUrl: 'wss://runtime.example.test/session/phone-cn',
    });
    await registry.stop('android-lab', 'phone-cn');
    expect(stop).toHaveBeenCalledWith('phone-cn');
  });

  it('fails closed for unconfigured providers and unsafe returned connection URLs', async () => {
    const registry = new ExternalRuntimeRegistry();
    registry.register({ id: 'cloud', name: 'Cloud', kind: 'cloud-browser', configured: false, health: async () => ({ available: false }) });
    await expect(registry.create('cloud')).rejects.toThrow('PROVIDER_NOT_CONFIGURED');

    const unsafe = new ExternalRuntimeRegistry();
    unsafe.register({
      id: 'unsafe', name: 'Unsafe', kind: 'cloud-browser', configured: true,
      health: async () => ({ available: true }),
      create: async () => ({ runtimeId: 'runtime-1', connectionUrl: 'ws://user:password@127.0.0.1/session' }),
    });
    await expect(unsafe.create('unsafe')).rejects.toThrow('PROVIDER_CONNECTION_URL_INVALID');
  });
});
