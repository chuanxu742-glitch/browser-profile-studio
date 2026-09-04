import type { UnifiedFingerprintProfile } from '../fingerprint/types.js';

export type EnvironmentDiagnosticStatus = 'pass' | 'warning' | 'fail';
export type EnvironmentConsistency = 'consistent' | 'warning' | 'inconsistent';

export interface EnvironmentSurfaceSnapshot {
  readonly userAgent?: string;
  readonly platform?: string;
  readonly language?: string;
  readonly languages?: readonly string[];
  readonly timezone?: string;
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly screen?: {
    readonly width: number;
    readonly height: number;
    readonly availWidth: number;
    readonly availHeight: number;
    readonly colorDepth: number;
    readonly pixelDepth: number;
    readonly devicePixelRatio: number;
  };
  readonly hardwareConcurrency?: number;
  readonly deviceMemory?: number;
  readonly webdriver?: boolean;
  readonly webgl?: { readonly vendor?: string; readonly renderer?: string };
  readonly integrity?: {
    readonly hasNavigatorInstancePollution: boolean;
    readonly pollutedNavigatorProps: readonly string[];
    readonly isNavigatorToStringNative: boolean;
    readonly isFunctionToStringNative: boolean;
    readonly isWebglNative: boolean;
  };
}

export interface EnvironmentDiagnosticCheck {
  readonly id: string;
  readonly status: EnvironmentDiagnosticStatus;
  readonly message: string;
}

export interface EnvironmentDiagnostics {
  readonly generatedAt: string;
  readonly sessionId: string;
  readonly engine: 'firefox' | 'chromium';
  readonly headless: boolean;
  readonly consistency: EnvironmentConsistency;
  readonly expected: {
    readonly browserMajor?: string;
    readonly os?: string;
    readonly userAgent?: string;
    readonly platform?: string;
    readonly locale?: string;
    readonly languages?: readonly string[];
    readonly timezone?: string;
    readonly viewport?: { readonly width: number; readonly height: number };
    readonly hardwareConcurrency?: number;
    readonly webgl?: { readonly vendor?: string; readonly renderer?: string };
    readonly webrtc?: string;
  };
  readonly observed?: EnvironmentSurfaceSnapshot;
  readonly checks: readonly EnvironmentDiagnosticCheck[];
}

export function expectedEnvironment(profile: UnifiedFingerprintProfile | undefined): EnvironmentDiagnostics['expected'] {
  if (!profile) return {};
  const browserMajor = profile.browserVersion.split('.')[0];
  return {
    ...(browserMajor ? { browserMajor } : {}),
    os: profile.os,
    userAgent: profile.userAgent,
    platform: profile.platform,
    locale: profile.geo.locale,
    languages: profile.geo.languages,
    timezone: profile.geo.timezoneId,
    viewport: profile.viewport,
    hardwareConcurrency: profile.hardware.hardwareConcurrency,
    webgl: { vendor: profile.webgl.unmaskedVendor || profile.webgl.vendor, renderer: profile.webgl.unmaskedRenderer || profile.webgl.renderer },
    webrtc: profile.webrtc,
  };
}

export function buildEnvironmentDiagnostics(input: {
  sessionId: string;
  engine: 'firefox' | 'chromium';
  headless: boolean;
  expected: EnvironmentDiagnostics['expected'];
  observed?: EnvironmentSurfaceSnapshot;
}): EnvironmentDiagnostics {
  const checks: EnvironmentDiagnosticCheck[] = [];
  const check = (id: string, status: EnvironmentDiagnosticStatus, message: string): void => {
    checks.push({ id, status, message });
  };
  const observed = input.observed;

  if (!observed) {
    check('runtime-surface', 'warning', '无法读取浏览器运行时表面');
  } else {
    const actualMajor = browserMajor(observed.userAgent);
    if (input.expected.browserMajor && actualMajor) {
      check('browser-version', input.expected.browserMajor === actualMajor ? 'pass' : 'warning', input.expected.browserMajor === actualMajor ? '浏览器主版本一致' : '浏览器主版本与配置画像不一致');
    }
    if (input.expected.os && observed.platform) {
      const matches = platformMatches(input.expected.os, observed.platform);
      check('platform', matches ? 'pass' : 'warning', matches ? '平台表面一致' : '平台表面与配置画像不一致');
    }
    if (input.expected.userAgent && observed.userAgent) {
      check('user-agent', input.expected.userAgent === observed.userAgent ? 'pass' : 'warning', input.expected.userAgent === observed.userAgent ? 'User-Agent 一致' : 'User-Agent 与配置画像不一致');
    }
    if (input.expected.locale && observed.language) {
      const locale = input.expected.locale.toLowerCase();
      const language = observed.language.toLowerCase();
      check('locale', language === locale || language.startsWith(`${locale}-`) ? 'pass' : 'warning', language === locale || language.startsWith(`${locale}-`) ? '语言区域一致' : '语言区域与配置画像不一致');
    }
    if (input.expected.timezone && observed.timezone) {
      check('timezone', input.expected.timezone === observed.timezone ? 'pass' : 'warning', input.expected.timezone === observed.timezone ? '时区一致' : '时区与配置画像不一致');
    }
    if (input.expected.viewport && observed.viewport) {
      const matches = input.expected.viewport.width === observed.viewport.width && input.expected.viewport.height === observed.viewport.height;
      check('viewport', matches || !input.headless ? 'pass' : 'warning', matches ? 'Viewport 一致' : input.headless ? '无头模式 Viewport 与配置画像不一致' : '有头模式 Viewport 由真实窗口决定');
    }
    if (input.expected.hardwareConcurrency !== undefined && observed.hardwareConcurrency !== undefined) {
      const matches = input.expected.hardwareConcurrency === observed.hardwareConcurrency;
      check('hardware-concurrency', matches ? 'pass' : 'warning', matches ? '硬件并发数一致' : '硬件并发数与配置画像不一致');
    }
    if (input.expected.webgl && observed.webgl) {
      const vendorMatches = !input.expected.webgl.vendor || !observed.webgl.vendor || input.expected.webgl.vendor === observed.webgl.vendor;
      const rendererMatches = !input.expected.webgl.renderer || !observed.webgl.renderer || input.expected.webgl.renderer === observed.webgl.renderer;
      check('webgl', vendorMatches && rendererMatches ? 'pass' : 'warning', vendorMatches && rendererMatches ? 'WebGL 表面一致' : 'WebGL 表面与配置画像不一致');
    }
    check('webdriver-signal', observed.webdriver === true ? 'warning' : 'pass', observed.webdriver === true ? '检测到 navigator.webdriver 信号；不自动修改并记录警告' : '未检测到 navigator.webdriver=true');

    if (observed.integrity) {
      if (observed.integrity.hasNavigatorInstancePollution) {
        check(
          'navigator-prototype-integrity',
          'fail',
          `Navigator 实例被自有属性污染: [${observed.integrity.pollutedNavigatorProps.join(', ')}]，破坏了 WebIDL 原型链`
        );
      } else {
        check('navigator-prototype-integrity', 'pass', 'Navigator 原型链与对象完整性良好');
      }

      if (!observed.integrity.isFunctionToStringNative) {
        check('function-tostring-integrity', 'fail', 'Function.prototype.toString 原生行为完整性受损');
      } else {
        check('function-tostring-integrity', 'pass', 'Function.prototype.toString 原生行为完整');
      }

      if (!observed.integrity.isNavigatorToStringNative) {
        check('navigator-tostring-integrity', 'warning', 'Object.prototype.toString(navigator) 异常');
      }
    }
  }

  if (input.expected.webrtc) check('webrtc-policy', input.expected.webrtc === 'block_leak' || input.expected.webrtc === 'disable' ? 'pass' : 'warning', `WebRTC 策略为 ${input.expected.webrtc}；实际出口地址需通过网络验收确认`);
  if (checks.length === 0) check('runtime-surface', 'warning', '没有可比较的运行时表面');
  const consistency: EnvironmentConsistency = checks.some((item) => item.status === 'fail')
    ? 'inconsistent'
    : checks.some((item) => item.status === 'warning') ? 'warning' : 'consistent';
  return {
    generatedAt: new Date().toISOString(),
    sessionId: input.sessionId,
    engine: input.engine,
    headless: input.headless,
    consistency,
    expected: input.expected,
    ...(observed ? { observed } : {}),
    checks,
  };
}

function browserMajor(userAgent: string | undefined): string | undefined {
  if (!userAgent) return undefined;
  return userAgent.match(/(?:Firefox|Chrome|Chromium)\/(\d+)/)?.[1];
}

function platformMatches(os: string, platform: string): boolean {
  const value = platform.toLowerCase();
  if (os === 'windows') return value.includes('win');
  if (os === 'macos') return value.includes('mac')
  if (os === 'linux') return value.includes('linux') || value.includes('x11');
  return false;
}
