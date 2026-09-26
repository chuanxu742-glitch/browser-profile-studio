import type { BrowserContext, Page } from 'playwright';
import type { FirefoxContextLike } from '../browser/firefox-launcher.js';
import type { UnifiedFingerprintProfile } from './types.js';

export interface PersonaProbeCheck {
  readonly status: 'pass' | 'fail' | 'unverified';
  readonly detail: string;
}

export interface PersonaProbeResult {
  readonly gpuBackend: PersonaProbeCheck;
  readonly webgpuDevice: PersonaProbeCheck;
  readonly webgpuMetadata: PersonaProbeCheck;
  readonly proxyEgress: PersonaProbeCheck;
  readonly webrtcIce: PersonaProbeCheck;
  readonly observed: {
    readonly gpu?: { readonly vendorId?: number; readonly deviceString?: string; readonly driverVendor?: string; readonly featureStatus?: Record<string, string> };
    readonly adapterInfo?: { readonly vendor: string; readonly architecture: string; readonly device: string; readonly description: string };
    readonly publicIp?: string;
    readonly iceCandidates?: readonly string[];
  };
}

/** Narrow a launched context only after its real browser-level CDP seam exists. */
export function hasChromiumGpuSession(context: FirefoxContextLike): context is FirefoxContextLike & BrowserContext {
  const browser = context.browser?.();
  return !!browser && 'newBrowserCDPSession' in browser
    && typeof browser.newBrowserCDPSession === 'function' && typeof context.newPage === 'function';
}

/** Evidence beyond JS getter/metadata overrides. Missing external prerequisites are never a pass. */
export async function probeChromiumPersona(
  context: BrowserContext,
  page: Page,
  profile: UnifiedFingerprintProfile,
  options: { egressUrl?: string; stunUrl?: string; proxyConfigured: boolean },
): Promise<PersonaProbeResult> {
  let gpuBackend: PersonaProbeCheck = { status: 'unverified', detail: 'GPU backend not observed; WebGL/WebGPU strings alone do not prove a physical adapter' };
  let webgpuDevice: PersonaProbeCheck = { status: 'unverified', detail: 'WebGPU device not observed' };
  let webgpuMetadata: PersonaProbeCheck = { status: 'unverified', detail: 'WebGPU adapter metadata not observed' };
  let proxyEgress: PersonaProbeCheck = { status: 'unverified', detail: 'Proxy egress endpoint and expected public IP required' };
  let webrtcIce: PersonaProbeCheck = { status: 'unverified', detail: 'STUN endpoint and expected WebRTC IP required for observable ICE check' };
  let gpu: PersonaProbeResult['observed']['gpu'];
  let adapterInfo: PersonaProbeResult['observed']['adapterInfo'];
  let publicIp: string | undefined;
  let iceCandidates: readonly string[] | undefined;

  const backend = await probeChromiumGpuBackend(context, profile);
  gpuBackend = backend.check;
  gpu = backend.gpu;

  try {
    const capability = await page.evaluate(async () => {
      const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<{
        info?: { vendor: string; architecture: string; device: string; description: string };
        requestDevice(): Promise<{ createBuffer(options: { size: number; usage: number }): { destroy(): void } }>;
      } | null> } }).gpu;
      if (!gpu) return { adapter: false, device: false };
      const adapter = await gpu.requestAdapter();
      if (!adapter) return { adapter: false, device: false };
      const info = adapter.info ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture,
        device: adapter.info.device, description: adapter.info.description } : undefined;
      try {
        const device = await adapter.requestDevice();
        const buffer = device.createBuffer({ size: 4, usage: 8 /* COPY_DST */ });
        buffer.destroy();
        return { adapter: true, device: true, info };
      } catch { return { adapter: true, device: false, info }; }
    });
    adapterInfo = 'info' in capability ? capability.info : undefined;
    if (profile.webgpu.adapterInfo && adapterInfo) {
      const mismatches = (['vendor', 'architecture', 'device', 'description'] as const)
        .filter(field => profile.webgpu.adapterInfo![field] && profile.webgpu.adapterInfo![field] !== adapterInfo![field]);
      webgpuMetadata = mismatches.length
        ? { status: 'fail', detail: `WEBGPU_METADATA_MISMATCH: ${mismatches.join(', ')}` }
        : { status: 'pass', detail: 'Observed adapter metadata matches configured strings; physical backend checked separately' };
    }
    webgpuDevice = profile.webgpu.supported
      ? capability.device ? { status: 'pass', detail: 'Actual WebGPU adapter, device and GPUBuffer observed (metadata not proof of backend)' }
        : { status: 'unverified', detail: 'No usable WebGPU adapter/device; metadata override cannot create one' }
      : capability.adapter ? { status: 'fail', detail: 'WebGPU adapter exposed despite disabled profile' }
        : { status: 'pass', detail: 'No WebGPU adapter exposed, as requested' };
  } catch (error) {
    webgpuDevice = { status: 'unverified', detail: `WebGPU device probe unavailable: ${String(error)}` };
  }

  if (profile.network?.expectedPublicIp && options.egressUrl) {
    if (!options.proxyConfigured) {
      proxyEgress = { status: 'fail', detail: 'Expected proxy public IP but Chromium launch has no configured proxy' };
    } else if (!isPublicEgressEndpoint(options.egressUrl)) {
      proxyEgress = { status: 'unverified', detail: 'Public HTTPS egress endpoint required; loopback/LAN echo cannot prove proxy IP' };
    } else {
      const probePage = await context.newPage();
      try {
        await probePage.goto(options.egressUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
        const body = (await probePage.locator('body').innerText()).trim();
        let response: unknown;
        try { response = JSON.parse(body); } catch { response = body; }
        publicIp = typeof response === 'string' ? response : response && typeof response === 'object' && 'ip' in response
          ? String(response.ip) : undefined;
        proxyEgress = publicIp === profile.network.expectedPublicIp
          ? { status: 'pass', detail: `Public egress IP observed through browser proxy: ${publicIp}` }
          : { status: 'fail', detail: `PROXY_EGRESS_IP_MISMATCH: expected ${profile.network.expectedPublicIp}, observed ${publicIp ?? 'no IP in endpoint response'}` };
      } catch (error) {
        proxyEgress = { status: 'unverified', detail: `Proxy egress could not be measured: ${String(error)}` };
      } finally { await probePage.close(); }
    }
  }

  if (profile.network?.expectedWebRtcIp && options.stunUrl) {
    try {
      iceCandidates = await page.evaluate(async (stunUrl) => {
        const connection = new RTCPeerConnection({ iceServers: [{ urls: stunUrl }], iceTransportPolicy: 'all' });
        const candidates: string[] = [];
        try {
          connection.createDataChannel('identity-probe');
          connection.onicecandidate = (event) => { if (event.candidate) candidates.push(event.candidate.candidate); };
          await connection.setLocalDescription(await connection.createOffer());
          await Promise.race([
            new Promise<void>((resolve) => { if (connection.iceGatheringState === 'complete') resolve(); else connection.addEventListener('icegatheringstatechange', () => {
              if (connection.iceGatheringState === 'complete') resolve();
            }); }),
            new Promise<void>((resolve) => setTimeout(resolve, 8000)),
          ]);
          return candidates;
        } finally { connection.close(); }
      }, options.stunUrl);
      const exposed = iceCandidates.map(candidate => ({ candidate, address: candidate.split(' ')[4] }))
        .filter(item => / typ (?:srflx|relay|host) /.test(item.candidate)
          && item.address && (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(item.address) || item.address.includes(':')));
      const leaking = exposed.filter(item => item.address !== profile.network!.expectedWebRtcIp);
      webrtcIce = leaking.length ? { status: 'fail', detail: `WEBRTC_ICE_IP_MISMATCH: candidates expose non-profile IP (${leaking.map(item => item.address).join(', ')})` }
        : exposed.length ? { status: 'pass', detail: `ICE candidates observed with expected IP ${profile.network.expectedWebRtcIp}` }
          : { status: 'unverified', detail: 'No public IP ICE candidate; mDNS-only or blocked STUN cannot prove IP identity' };
    } catch (error) {
      webrtcIce = { status: 'unverified', detail: `WebRTC ICE could not be measured: ${String(error)}` };
    }
  }

  return { gpuBackend, webgpuDevice, webgpuMetadata, proxyEgress, webrtcIce,
    observed: { ...(gpu ? { gpu } : {}), ...(adapterInfo ? { adapterInfo } : {}),
      ...(publicIp ? { publicIp } : {}), ...(iceCandidates ? { iceCandidates } : {}) } };
}

/** Release gate: metadata-only GPU overrides must not be mistaken for the physical device. */
export async function probeChromiumGpuBackend(
  context: BrowserContext | undefined,
  profile: UnifiedFingerprintProfile,
  physicalGpu?: PhysicalGpuObservation,
): Promise<{ check: PersonaProbeCheck; gpu?: PersonaProbeResult['observed']['gpu'] }> {
  try {
    const gpu = physicalGpu ?? (context ? await readChromiumPhysicalGpu(context) : undefined);
    if (!gpu) throw new Error('GPU_CDP_SESSION_UNAVAILABLE');
    const vendor = profile.webgl.unmaskedVendor;
    const expectedVendor = /NVIDIA/i.test(vendor) ? 0x10de : /Intel/i.test(vendor) ? 0x8086 : /AMD/i.test(vendor) ? 0x1002 : undefined;
    // Match the marketed model rather than ANGLE's driver/version suffixes, which vary
    // across D3D/Vulkan revisions. An absent/ambiguous SKU is not proof of parity.
    const actualModel = gpuModelSku(gpu.deviceString);
    const expectedModel = gpuModelSku(profile.webgl.unmaskedRenderer);
    const check: PersonaProbeCheck = expectedVendor && gpu.vendorId !== expectedVendor
      ? { status: 'fail', detail: `GPU backend vendor mismatch: expected ${vendor} (${expectedVendor}), device ${gpu.deviceString} (${gpu.vendorId})` }
      : actualModel && expectedModel && actualModel === expectedModel && expectedVendor === gpu.vendorId
        && /\bLaptop\b/i.test(profile.webgl.unmaskedRenderer) === /\bLaptop\b/i.test(gpu.deviceString)
        && gpuBackendKind(profile.webgl.unmaskedRenderer) === gpuBackendKind(gpu.glRenderer)
        ? { status: 'pass', detail: `Physical GPU backend observed: ${gpu.deviceString} (${gpu.vendorId})` }
        : { status: 'unverified', detail: `GPU backend model not corroborated: expected ${profile.webgl.unmaskedRenderer}, observed ${gpu.deviceString}` };
    return { check, gpu };
  } catch (error) {
    const detail = String(error);
    const software = detail.includes('GPU_SOFTWARE_BACKEND');
    return { check: { status: software ? 'fail' : 'unverified',
      detail: software ? `GPU_BACKEND_MISMATCH: ${detail}` : `CDP GPU backend unavailable: ${detail}` } };
  }
}

export interface PhysicalGpuObservation {
  readonly vendorId: number;
  readonly deviceString: string;
  readonly glRenderer: string;
  readonly vendorString?: string;
  readonly driverVendor?: string;
  readonly featureStatus: Readonly<Record<string, string>>;
}

/** Read the active, hardware-backed Chromium adapter; never trust spoofed WebGL strings. */
export async function readChromiumPhysicalGpu(context: BrowserContext): Promise<PhysicalGpuObservation> {
  const session = await context.browser()?.newBrowserCDPSession();
  if (!session) throw new Error('GPU_CDP_SESSION_UNAVAILABLE');
  try {
    const info = await session.send('SystemInfo.getInfo');
    return parseChromiumPhysicalGpu(info);
  } finally { await session.detach(); }
}

/** Apply the same physical GPU gate to a browser-target CDP connection from a persistent context. */
export function parseChromiumPhysicalGpu(info: {
  gpu?: { devices?: Array<{ vendorId?: number; deviceString?: string; driverVendor?: string; vendorString?: string; active?: boolean }>;
    auxAttributes?: { glRenderer?: string }; featureStatus?: Record<string, string> };
}): PhysicalGpuObservation {
    const devices = info.gpu?.devices ?? [];
    const rendererSku = gpuModelSku(info.gpu?.auxAttributes?.glRenderer ?? '');
    let active: (typeof devices)[number] | undefined;
    let activeCount = 0;
    let matching: (typeof devices)[number] | undefined;
    let matchingCount = 0;
    for (const candidate of devices) {
      if (candidate.active === true) { active = candidate; activeCount++; }
      if (rendererSku && gpuModelSku(candidate.deviceString ?? '') === rendererSku) {
        matching = candidate;
        matchingCount++;
      }
    }
    const device = activeCount === 1 ? active : devices.length === 1 ? devices[0] : matchingCount === 1 ? matching : undefined;
    if (!device || !device.vendorId || !device.deviceString) throw new Error('GPU_ACTIVE_DEVICE_AMBIGUOUS');
    if (/swiftshader|software|basic render|llvmpipe|virtual|vmware/i.test(device.deviceString)) {
      throw new Error(`GPU_SOFTWARE_BACKEND: ${device.deviceString}`);
    }
    if (info.gpu?.featureStatus?.gpu_compositing !== 'enabled') {
      throw new Error(`GPU_HARDWARE_COMPOSITING_UNVERIFIED: ${info.gpu?.featureStatus?.gpu_compositing ?? 'unknown'}`);
    }
    const glRenderer = info.gpu.auxAttributes?.glRenderer;
    if (!glRenderer || /swiftshader|software|llvmpipe|virtual|vmware/i.test(glRenderer)
      || !rendererSku || rendererSku !== gpuModelSku(device.deviceString)) {
      throw new Error(`GPU_GL_RENDERER_UNVERIFIED: ${glRenderer ?? 'absent'}`);
    }
    return { vendorId: device.vendorId, deviceString: device.deviceString, glRenderer,
      ...(device.vendorString ? { vendorString: device.vendorString } : {}),
      ...(device.driverVendor ? { driverVendor: device.driverVendor } : {}),
      featureStatus: info.gpu.featureStatus };
}

export function gpuModelSku(text: string): string | undefined {
  const normalized = text.replace(/\((?:R|TM)\)/gi, '');
  return normalized.match(
    /\b(?:RTX|GTX|RX|Arc|UHD|Iris)(?:\s+Graphics)?\s*[A-Z]?\d{3,4}(?:\s*(?:Ti|SUPER|XT))?\b/i,
  )?.[0].replace(/[^a-z0-9]/gi, '').toUpperCase()
    ?? (/\bIris\s*Xe\b/i.test(normalized) ? 'IRISXE' : undefined);
}
export function gpuBackendKind(renderer: string): string | undefined {
  if (/\b(?:Direct3D12|D3D12)\b/i.test(renderer)) return 'd3d12';
  if (/\b(?:Direct3D11|D3D11)\b/i.test(renderer)) return 'd3d11';
  if (/\bVulkan\b/i.test(renderer)) return 'vulkan';
  if (/\bOpenGL\b/i.test(renderer)) return 'opengl';
  if (/\bMetal\b/i.test(renderer)) return 'metal';
  return undefined;
}

function isPublicEgressEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !/^(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(url.hostname);
  } catch { return false; }
}
