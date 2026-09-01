import type {
  UnifiedFingerprintProfile,
  OSPlatform,
  BrowserEngineType,
  ScreenDimension,
  ViewportDimension,
  HardwareFingerprint,
  WebGLFingerprint,
  WebGPUFingerprint,
  PluginItemConfig,
  GeoFingerprintConfig,
} from './types.js';
import { findGeoByCountryCode } from '../geoip/database.js';
import { managedBrowserIdentity } from './runtime-identity.js';

export const COMMON_GPUS: readonly {
  vendor: string;
  renderer: string;
  unmaskedVendor: string;
  unmaskedRenderer: string;
}[] = [
  {
    vendor: 'WebKit',
    renderer: 'WebKit WebGL',
    unmaskedVendor: 'Google Inc. (NVIDIA)',
    unmaskedRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    vendor: 'WebKit',
    renderer: 'WebKit WebGL',
    unmaskedVendor: 'Google Inc. (NVIDIA)',
    unmaskedRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    vendor: 'WebKit',
    renderer: 'WebKit WebGL',
    unmaskedVendor: 'Google Inc. (NVIDIA)',
    unmaskedRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    vendor: 'WebKit',
    renderer: 'WebKit WebGL',
    unmaskedVendor: 'Google Inc. (AMD)',
    unmaskedRenderer: 'ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    vendor: 'WebKit',
    renderer: 'WebKit WebGL',
    unmaskedVendor: 'Google Inc. (Intel)',
    unmaskedRenderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    vendor: 'Apple Inc.',
    renderer: 'Apple GPU',
    unmaskedVendor: 'Apple Inc.',
    unmaskedRenderer: 'Apple M2 Pro',
  },
  {
    vendor: 'Apple Inc.',
    renderer: 'Apple GPU',
    unmaskedVendor: 'Apple Inc.',
    unmaskedRenderer: 'Apple M3 Max',
  },
];

export const COMMON_RESOLUTIONS: readonly ScreenDimension[] = [
  {
    width: 1920,
    height: 1080,
    availWidth: 1920,
    availHeight: 1040,
    colorDepth: 24,
    pixelDepth: 24,
    devicePixelRatio: 1,
  },
  {
    width: 2560,
    height: 1440,
    availWidth: 2560,
    availHeight: 1400,
    colorDepth: 24,
    pixelDepth: 24,
    devicePixelRatio: 1.25,
  },
  {
    width: 1536,
    height: 864,
    availWidth: 1536,
    availHeight: 824,
    colorDepth: 24,
    pixelDepth: 24,
    devicePixelRatio: 1.25,
  },
  {
    width: 1440,
    height: 900,
    availWidth: 1440,
    availHeight: 875,
    colorDepth: 24,
    pixelDepth: 24,
    devicePixelRatio: 2,
  },
];

function createSeededRandom(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GenerateFingerprintOptions {
  seed?: number | undefined;
  engine?: BrowserEngineType | undefined;
  os?: OSPlatform | undefined;
  countryCode?: string | undefined;
  browserVersion?: string | undefined;
}

export function generateFingerprint(
  seedOrOptions: number | GenerateFingerprintOptions = 123456,
  legacyOs?: OSPlatform,
): UnifiedFingerprintProfile {
  let seed: number;
  let engine: BrowserEngineType = 'firefox';
  let os: OSPlatform = legacyOs || 'windows';
  let countryCode = 'US';
  let requestedBrowserVersion: string | undefined;

  if (typeof seedOrOptions === 'number') {
    seed = seedOrOptions;
  } else {
    seed = seedOrOptions.seed ?? 123456;
    engine = seedOrOptions.engine ?? 'firefox';
    os = seedOrOptions.os ?? 'windows';
    countryCode = seedOrOptions.countryCode ?? 'US';
    requestedBrowserVersion = seedOrOptions.browserVersion;
  }

  const browserIdentity = managedBrowserIdentity(engine);
  const browserVersion = requestedBrowserVersion ?? browserIdentity.fullVersion;
  if (!/^\d+(?:\.\d+){1,3}$/.test(browserVersion)) throw new Error('BROWSER_VERSION_INVALID');
  const browserMajorVersion = browserVersion.split('.')[0]!;

  const rng = createSeededRandom(seed);

  // 1. GPU Alignment
  const gpuPool = os === 'macos'
    ? COMMON_GPUS.filter((g) => g.unmaskedVendor.includes('Apple'))
    : COMMON_GPUS.filter((g) => !g.unmaskedVendor.includes('Apple'));
  const chosenGpu = gpuPool[Math.floor(rng() * gpuPool.length)] ?? COMMON_GPUS[0]!;

  const webgl: WebGLFingerprint = {
    vendor: chosenGpu.vendor,
    renderer: chosenGpu.renderer,
    unmaskedVendor: chosenGpu.unmaskedVendor,
    unmaskedRenderer: chosenGpu.unmaskedRenderer,
    maxTextureSize: 16384,
    shaderPrecision: {
      rangeMin: 127,
      rangeMax: 127,
      precision: 23,
    },
    noiseEnabled: true,
  };

  const webgpu: WebGPUFingerprint = {
    // Firefox does not expose navigator.gpu in the managed runtime. Do not
    // advertise a capability that the selected engine cannot provide.
    supported: engine === 'chromium',
    ...(engine === 'chromium' ? {
      adapterInfo: {
        vendor: chosenGpu.unmaskedVendor,
        architecture: 'common-3d',
        device: chosenGpu.unmaskedRenderer,
        description: chosenGpu.unmaskedRenderer,
      },
    } : {}),
  };

  // 2. Screen & Viewport Coherence
  const screen = COMMON_RESOLUTIONS[Math.floor(rng() * COMMON_RESOLUTIONS.length)] ?? COMMON_RESOLUTIONS[0]!;
  const viewport: ViewportDimension = {
    width: screen.availWidth,
    height: screen.availHeight,
  };

  // 3. Hardware concurrency & memory

  const concurrencyChoices = [4, 8, 12, 16, 24];
  const memoryChoices = [8, 16, 32];
  const hardwareConcurrency = concurrencyChoices[Math.floor(rng() * concurrencyChoices.length)] ?? 8;
  const deviceMemory = memoryChoices[Math.floor(rng() * memoryChoices.length)] ?? 16;

  let platform = 'Win32';
  let oscpu: string | undefined = 'Windows NT 10.0; Win64; x64';
  let userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${browserMajorVersion}.0) Gecko/20100101 Firefox/${browserMajorVersion}.0`;
  let vendor = '';
  let buildID: string | undefined = '20181001000000';

  if (os === 'macos') {
    platform = 'MacIntel';
    oscpu = 'Intel Mac OS X 10.15';
    if (engine === 'firefox') {
      userAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:${browserMajorVersion}.0) Gecko/20100101 Firefox/${browserMajorVersion}.0`;
      vendor = '';
    } else {
      userAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browserMajorVersion}.0.0.0 Safari/537.36`;
      vendor = 'Google Inc.';
      oscpu = undefined;
      buildID = undefined;
    }
  } else if (os === 'linux') {
    platform = 'Linux x86_64';
    oscpu = 'Linux x86_64';
    if (engine === 'firefox') {
      userAgent = `Mozilla/5.0 (X11; Linux x86_64; rv:${browserMajorVersion}.0) Gecko/20100101 Firefox/${browserMajorVersion}.0`;
      vendor = '';
    } else {
      userAgent = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browserMajorVersion}.0.0.0 Safari/537.36`;
      vendor = 'Google Inc.';
      oscpu = undefined;
      buildID = undefined;
    }
  } else {
    // Windows
    if (engine === 'chromium') {
      userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browserMajorVersion}.0.0.0 Safari/537.36`;
      vendor = 'Google Inc.';
      oscpu = undefined;
      buildID = undefined;
    }
  }

  // 4. Geo Alignment
  const geoDefaults = findGeoByCountryCode(countryCode);
  const geo: GeoFingerprintConfig = {
    timezoneId: geoDefaults.timezone,
    locale: geoDefaults.locale,
    languages: geoDefaults.languages,
    geolocation: {
      latitude: geoDefaults.latitude,
      longitude: geoDefaults.longitude,
      accuracy: 50,
    },
  };

  // 5. Plugins
  const plugins: PluginItemConfig[] = engine === 'firefox'
    ? [
        {
          name: 'PDF Viewer',
          filename: 'pdfjs',
          description: 'Portable Document Format',
          mimeTypes: [{ type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' }],
        },
      ]
    : [
        {
          name: 'PDF Viewer',
          filename: 'internal-pdf-viewer',
          description: 'Portable Document Format',
          mimeTypes: [{ type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' }],
        },
        {
          name: 'Chrome PDF Viewer',
          filename: 'internal-pdf-viewer',
          description: 'Portable Document Format',
          mimeTypes: [{ type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' }],
        },
        {
          name: 'Chromium PDF Viewer',
          filename: 'internal-pdf-viewer',
          description: 'Portable Document Format',
          mimeTypes: [{ type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' }],
        },
        {
          name: 'Microsoft Edge PDF Viewer',
          filename: 'internal-pdf-viewer',
          description: 'Portable Document Format',
          mimeTypes: [{ type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' }],
        },
        {
          name: 'WebKit built-in PDF',
          filename: 'internal-pdf-viewer',
          description: 'Portable Document Format',
          mimeTypes: [{ type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' }],
        },
      ];

  const hardware: HardwareFingerprint = {
    hardwareConcurrency,
    deviceMemory,
    maxTouchPoints: 0,
    platform,
    screenWidth: screen.width,
    screenHeight: screen.height,
    availWidth: screen.availWidth,
    availHeight: screen.availHeight,
    colorDepth: screen.colorDepth,
    devicePixelRatio: screen.devicePixelRatio,
  };

  return {
    engine,
    browserVersion,
    os,
    userAgent,
    appVersion: userAgent.replace(/^Mozilla\//, ''),
    platform,
    ...(oscpu ? { oscpu } : {}),
    vendor,
    ...(buildID ? { buildID } : {}),
    screen,
    viewport,
    geo,
    hardware,
    webgl,
    webgpu,
    canvas: {
      enabled: true,
      seed: Math.floor(rng() * 65535) + 1,
    },
    audio: {
      enabled: true,
      seed: Math.floor(rng() * 65535) + 1,
    },
    webrtc: 'block_leak',
    plugins,
    stealth: {
      removeWebdriver: true,
      mockChromeRuntime: engine === 'chromium',
      mockNotificationPermission: true,
      mockPlugins: true,
      protectToString: true,
      blockServiceWorkers: false,
    },
  };
}
