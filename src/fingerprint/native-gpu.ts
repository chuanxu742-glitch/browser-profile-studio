import { chromium } from 'playwright';
import { resolveVerifiedChromiumCore } from '../browser/custom-chromium-runtime.js';
import { resolveVerifiedChromix } from '../browser/chromix-runtime.js';
import { distributionBrowserIdentity } from './runtime-identity.js';
import { COMMON_GPUS } from './generator.js';
import { gpuBackendKind, gpuModelSku, readChromiumPhysicalGpu, type PhysicalGpuObservation } from './runtime-probe.js';
import type { WebGLFingerprint } from './types.js';
import type { BrowserDistribution } from '../profile/types.js';

export interface NativeGpuIdentity {
  readonly unmaskedVendor: string;
  readonly unmaskedRenderer: string;
  readonly vendorId: number;
  readonly deviceString: string;
}

/** A physical adapter is eligible only when its vendor and marketed model map uniquely. */
export function selectNativeGpuIdentity(observed: PhysicalGpuObservation): NativeGpuIdentity {
  const vendor = observed.vendorId === 0x10de ? 'NVIDIA'
    : observed.vendorId === 0x1002 ? 'AMD'
      : observed.vendorId === 0x8086 ? 'Intel' : undefined;
  const sku = gpuModelSku(observed.deviceString);
  if (!vendor || !sku || observed.featureStatus.gpu_compositing !== 'enabled'
      || gpuModelSku(observed.glRenderer) !== sku
      || /\bLaptop\b/i.test(observed.glRenderer) !== /\bLaptop\b/i.test(observed.deviceString)
      || /swiftshader|software|basic render|llvmpipe|virtual|vmware/i.test(observed.deviceString)
      || /swiftshader|software|llvmpipe|virtual|vmware/i.test(observed.glRenderer)) {
    throw new Error(`GPU_BACKEND_UNVERIFIED: ${observed.deviceString} (${observed.vendorId})`);
  }
  let selected: (typeof COMMON_GPUS)[number] | undefined;
  let count = 0;
  for (const candidate of COMMON_GPUS) {
    if (candidate.unmaskedVendor.includes(vendor) && gpuModelSku(candidate.unmaskedRenderer) === sku
      && /\bLaptop\b/i.test(candidate.unmaskedRenderer) === /\bLaptop\b/i.test(observed.deviceString)) {
      selected = candidate;
      count++;
    }
  }
  if (count !== 1 || !selected) {
    throw new Error(`GPU_MODEL_UNMAPPED: ${observed.deviceString} (${observed.vendorId}); no unique managed adapter model`);
  }
  return { unmaskedVendor: selected.unmaskedVendor, unmaskedRenderer: observed.glRenderer,
    vendorId: observed.vendorId, deviceString: observed.deviceString };
}

/** Probe the same verified core as the release launcher before generating a persistent persona. */
export async function discoverNativeChromiumGpu(
  headless = false,
  requested?: Pick<WebGLFingerprint, 'unmaskedVendor' | 'unmaskedRenderer'>,
  distribution?: BrowserDistribution,
): Promise<NativeGpuIdentity> {
  const core = distribution === 'chromix-152' ? await resolveVerifiedChromix() : await resolveVerifiedChromiumCore();
  if (!core) throw new Error('NATIVE_CHROMIUM_REQUIRED: cannot discover a physical GPU without verified native core');
  const browser = await chromium.launch({ executablePath: core.executablePath, headless,
    args: ['--disable-component-update', '--disable-background-networking', '--no-first-run'] });
  try {
    const actualVersion = browser.version();
    const expectedVersion = distributionBrowserIdentity('chromium', distribution).fullVersion;
    if (actualVersion !== expectedVersion) throw new Error(`BROWSER_RUNTIME_VERSION_MISMATCH: expected ${expectedVersion}, received ${actualVersion}`);
    const context = await browser.newContext();
    try {
      const physical = await readChromiumPhysicalGpu(context);
      if (!requested) return selectNativeGpuIdentity(physical);
      const identity = { unmaskedVendor: requested.unmaskedVendor, unmaskedRenderer: physical.glRenderer,
        vendorId: physical.vendorId, deviceString: physical.deviceString };
      assertNativeGpuIdentity(identity, requested);
      return identity;
    } finally { await context.close(); }
  } finally { await browser.close(); }
}

/** Explicit overrides must describe the already observed physical vendor/model. */
export function assertNativeGpuIdentity(
  observed: NativeGpuIdentity,
  requested: Pick<WebGLFingerprint, 'unmaskedVendor' | 'unmaskedRenderer'>,
): void {
  const vendor = /NVIDIA/i.test(requested.unmaskedVendor) ? 0x10de
    : /AMD/i.test(requested.unmaskedVendor) ? 0x1002 : /Intel/i.test(requested.unmaskedVendor) ? 0x8086 : undefined;
  if (vendor !== observed.vendorId || !gpuModelSku(requested.unmaskedRenderer)
      || gpuModelSku(requested.unmaskedRenderer) !== gpuModelSku(observed.deviceString)
      || /\bLaptop\b/i.test(requested.unmaskedRenderer) !== /\bLaptop\b/i.test(observed.deviceString)
      || gpuBackendKind(requested.unmaskedRenderer) !== gpuBackendKind(observed.unmaskedRenderer)) {
    throw new Error(`GPU_PROFILE_OVERRIDE_MISMATCH: requested ${requested.unmaskedVendor} / ${requested.unmaskedRenderer}, observed ${observed.deviceString} (${observed.vendorId})`);
  }
}
