import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertNativeGpuIdentity, selectNativeGpuIdentity } from '../../src/fingerprint/native-gpu.js';
import { BrowserSession } from '../../src/browser/browser-session.js';

const physical = { vendorId: 0x10de, deviceString: 'NVIDIA Corporation GeForce RTX 4070',
  glRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  featureStatus: { gpu_compositing: 'enabled' } };

describe('native GPU identity selection', () => {
  it('selects a uniquely corroborated hardware model despite harmless driver naming', () => {
    const identity = selectNativeGpuIdentity(physical);
    expect(identity).toMatchObject({ vendorId: 0x10de, unmaskedVendor: 'Google Inc. (NVIDIA)',
      unmaskedRenderer: expect.stringContaining('NVIDIA GeForce RTX 4070 Direct3D11') });
    const vulkan = selectNativeGpuIdentity({ ...physical,
      glRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070, Vulkan 1.3)' });
    expect(vulkan.unmaskedRenderer).toContain('Vulkan 1.3');
  });

  it('refuses software, unavailable compositor, unknown or materially different laptop GPUs', () => {
    expect(() => selectNativeGpuIdentity({ ...physical, deviceString: 'SwiftShader Device', vendorId: 65535 }))
      .toThrow('GPU_BACKEND_UNVERIFIED');
    expect(() => selectNativeGpuIdentity({ ...physical, featureStatus: { gpu_compositing: 'disabled_software' } }))
      .toThrow('GPU_BACKEND_UNVERIFIED');
    expect(() => selectNativeGpuIdentity({ ...physical, deviceString: 'NVIDIA GeForce RTX 5090',
      glRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11, D3D11)' }))
      .toThrow('GPU_MODEL_UNMAPPED');
    expect(() => selectNativeGpuIdentity({ ...physical, deviceString: 'NVIDIA GeForce RTX 4070 Laptop GPU',
      glRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Laptop GPU Direct3D11, D3D11)' }))
      .toThrow('GPU_MODEL_UNMAPPED');
  });

  it('rejects explicit renderer/vendor overrides that differ from the physical adapter', () => {
    const identity = selectNativeGpuIdentity(physical);
    expect(() => assertNativeGpuIdentity(identity, { unmaskedVendor: 'Google Inc. (AMD)',
      unmaskedRenderer: 'ANGLE (AMD, AMD Radeon RX 7800 XT Direct3D11, D3D11)' }))
      .toThrow('GPU_PROFILE_OVERRIDE_MISMATCH');
    expect(() => assertNativeGpuIdentity(identity, { unmaskedVendor: identity.unmaskedVendor,
      unmaskedRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070, Vulkan 1.3)' }))
      .toThrow('GPU_PROFILE_OVERRIDE_MISMATCH');
  });
  it('refuses a persistent release session without a stored GPU persona', async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-gpu-persistence-'));
    const previous = process.env.ABS_REQUIRE_NATIVE_CHROMIUM;
    process.env.ABS_REQUIRE_NATIVE_CHROMIUM = '1';
    try {
      const session = new BrowserSession({ engine: 'chromium', fingerprint: true,
        persistentProfile: true, profileName: 'gpu-profile', profileRoot: root });
      await expect(session.start()).rejects.toThrow('NATIVE_GPU_PROFILE_PERSISTENCE_REQUIRED');
    } finally {
      if (previous === undefined) delete process.env.ABS_REQUIRE_NATIVE_CHROMIUM;
      else process.env.ABS_REQUIRE_NATIVE_CHROMIUM = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

});
