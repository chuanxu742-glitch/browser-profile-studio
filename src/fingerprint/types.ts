export type WebRTCMode = 'disable' | 'block_leak' | 'replace' | 'direct';
export type BrowserEngineType = 'firefox' | 'chromium';
export type OSPlatform = 'windows' | 'macos' | 'linux';

export interface ScreenDimension {
  readonly width: number;
  readonly height: number;
  readonly availWidth: number;
  readonly availHeight: number;
  readonly colorDepth: number;
  readonly pixelDepth: number;
  readonly devicePixelRatio: number;
}

export interface ViewportDimension {
  readonly width: number;
  readonly height: number;
}

export interface HardwareFingerprint {
  readonly hardwareConcurrency: number;
  readonly deviceMemory: number;
  readonly maxTouchPoints: number;
  readonly platform: string;
  readonly screenWidth: number;
  readonly screenHeight: number;
  readonly availWidth: number;
  readonly availHeight: number;
  readonly colorDepth: number;
  readonly devicePixelRatio: number;
}

export interface WebGLFingerprint {
  readonly vendor: string;
  readonly renderer: string;
  readonly unmaskedVendor: string;
  readonly unmaskedRenderer: string;
  readonly maxTextureSize: number;
  readonly shaderPrecision: {
    rangeMin: number;
    rangeMax: number;
    precision: number;
  };
  readonly noiseEnabled: boolean;
}

export interface WebGPUFingerprint {
  readonly supported: boolean;
  readonly adapterInfo?: {
    vendor: string;
    architecture: string;
    device: string;
    description: string;
  };
}

export interface CanvasNoiseConfig {
  readonly enabled: boolean;
  readonly seed: number;
}

export interface AudioNoiseConfig {
  readonly enabled: boolean;
  readonly seed: number;
}

export interface PluginItemConfig {
  readonly name: string;
  readonly filename: string;
  readonly description: string;
  readonly mimeTypes: readonly {
    readonly type: string;
    readonly suffixes: string;
    readonly description: string;
  }[];
}

export interface GeoFingerprintConfig {
  readonly timezoneId: string;
  readonly locale: string;
  readonly languages: readonly string[];
  readonly geolocation: {
    readonly latitude: number;
    readonly longitude: number;
    readonly accuracy: number;
  };
}

export interface UnifiedFingerprintProfile {
  readonly engine: BrowserEngineType;
  /** Version of the managed browser core this profile was generated for. */
  readonly browserVersion: string;
  readonly os: OSPlatform;
  readonly userAgent: string;
  readonly appVersion: string;
  readonly platform: string;
  readonly oscpu?: string;
  readonly vendor: string;
  readonly buildID?: string;
  readonly screen: ScreenDimension;
  readonly viewport: ViewportDimension;
  readonly geo: GeoFingerprintConfig;
  readonly hardware: HardwareFingerprint;
  readonly webgl: WebGLFingerprint;
  readonly webgpu: WebGPUFingerprint;
  readonly canvas: CanvasNoiseConfig;
  readonly audio: AudioNoiseConfig;
  readonly webrtc: WebRTCMode;
  readonly plugins: readonly PluginItemConfig[];
  readonly stealth: {
    readonly removeWebdriver: boolean;
    readonly mockChromeRuntime: boolean;
    readonly mockNotificationPermission: boolean;
    readonly mockPlugins: boolean;
    readonly protectToString: boolean;
    /** Prevent an unprofiled service-worker global from being exposed. */
    readonly blockServiceWorkers: boolean;
  };
}

export type FingerprintConfig = UnifiedFingerprintProfile;
