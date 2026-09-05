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
    readonly hasNavigatorInstancePollution?: boolean;
    readonly pollutedNavigatorProps?: readonly string[];
    readonly isNavigatorToStringNative?: boolean;
    readonly isFunctionToStringNative?: boolean;
    readonly isWebglNative?: boolean;
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
    ...(profile.webgl.mode === 'native' ? {} : { webgl: { vendor: profile.webgl.unmaskedVendor || profile.webgl.vendor, renderer: profile.webgl.unmaskedRenderer || profile.webgl.renderer } }),
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
    if (input.expected.browserMajor) {
      check('browser-version', input.expected.browserMajor === actualMajor ? 'pass' : 'warning', input.expected.browserMajor === actualMajor ? '浏览器主版本一致' : '浏览器主版本与配置画像不一致');
    }
    if (input.expected.os) {
      const matches = observed.platform !== undefined && platformMatches(input.expected.os, observed.platform);
      check('platform', matches ? 'pass' : 'warning', matches ? '平台表面一致' : '平台表面与配置画像不一致');
    }
    if (input.expected.userAgent) {
      check('user-agent', input.expected.userAgent === observed.userAgent ? 'pass' : 'warning', input.expected.userAgent === observed.userAgent ? 'User-Agent 一致' : 'User-Agent 与配置画像不一致');
    }
    if (input.expected.locale) {
      const locale = input.expected.locale.toLowerCase();
      const language = observed.language?.toLowerCase() ?? '';
      check('locale', language === locale || language.startsWith(`${locale}-`) ? 'pass' : 'warning', language === locale || language.startsWith(`${locale}-`) ? '语言区域一致' : '语言区域与配置画像不一致');
    }
    if (input.expected.timezone) {
      check('timezone', input.expected.timezone === observed.timezone ? 'pass' : 'warning', input.expected.timezone === observed.timezone ? '时区一致' : '时区与配置画像不一致');
    }
    if (input.expected.viewport) {
      const matches = input.expected.viewport.width === observed.viewport?.width && input.expected.viewport.height === observed.viewport?.height;
      check('viewport', matches ? 'pass' : 'warning', matches ? 'Viewport 一致' : 'Viewport 与配置不同或未采集；有头窗口可被用户调整');
    }
    if (input.expected.hardwareConcurrency !== undefined) {
      const matches = input.expected.hardwareConcurrency === observed.hardwareConcurrency;
      check('hardware-concurrency', matches ? 'pass' : 'warning', matches ? '硬件并发数一致' : '硬件并发数与配置画像不一致');
    }
    if (input.expected.webgl) {
      const comparable = Boolean(input.expected.webgl.vendor || input.expected.webgl.renderer);
      const vendorMatches = !input.expected.webgl.vendor || input.expected.webgl.vendor === observed.webgl?.vendor;
      const rendererMatches = !input.expected.webgl.renderer || input.expected.webgl.renderer === observed.webgl?.renderer;
      const matches = comparable && vendorMatches && rendererMatches;
      check('webgl', matches ? 'pass' : 'warning', matches ? 'WebGL 表面一致' : 'WebGL 表面不一致或缺少可比较的配置/观测');
    }
    if (input.expected.platform) check('platform-value', observed.platform === input.expected.platform ? 'pass' : 'warning', '比较已采集的平台值与配置');
    if (input.expected.languages) check('languages', JSON.stringify(observed.languages) === JSON.stringify(input.expected.languages) ? 'pass' : 'warning', '比较语言列表及顺序；缺失不视为通过');
    check('webdriver-signal', observed.webdriver === false ? 'pass' : 'warning', observed.webdriver === false ? '本次未观察到 webdriver=true' : '发现 webdriver 信号或未采集');

    if (observed.integrity) {
      const integrity = observed.integrity;
      const pollutedProps = integrity.pollutedNavigatorProps;
      if (integrity.hasNavigatorInstancePollution === true || (pollutedProps && pollutedProps.length > 0)) {
        check('navigator-prototype-integrity', 'fail', `Navigator 实例被自有属性污染: [${pollutedProps?.join(', ') ?? '属性列表未采集'}]，破坏了 WebIDL 原型链`);
      } else if (integrity.hasNavigatorInstancePollution === false && pollutedProps?.length === 0) {
        check('navigator-prototype-integrity', 'pass', '本次检查的 Navigator 实例属性无污染；未证明整个原型链完整');
      } else {
        check('navigator-prototype-integrity', 'warning', 'Navigator 实例属性检查未完整采集');
      }

      if (integrity.isFunctionToStringNative === false) {
        check('function-tostring-integrity', 'fail', 'Function.prototype.toString 原生行为完整性受损');
      } else if (integrity.isFunctionToStringNative === true) {
        check('function-tostring-integrity', 'pass', '本次函数源码呈原生样式；不代表跨上下文完整性已验证');
      } else {
        check('function-tostring-integrity', 'warning', '未采集 Function.prototype.toString 行为');
      }

      check('navigator-tostring-integrity', integrity.isNavigatorToStringNative === true ? 'pass' : 'warning', integrity.isNavigatorToStringNative === true ? '本次 Navigator 对象标签符合预期；不证明整个原型链完整' : 'Navigator 对象标签异常或未采集');
      check('webgl-function-shape', observed.integrity.isWebglNative === false ? 'fail' : observed.integrity.isWebglNative === true ? 'pass' : 'warning', '仅检查已取得的 WebGL 方法源码样式；无上下文则未验证');
    }
    if (!observed.integrity) check('native-integrity', 'warning', '未采集原生对象完整性');
  }

  if (input.expected.webrtc) check('webrtc-policy', 'warning', `已配置 ${input.expected.webrtc}；配置值不能证明 ICE、DNS 或实际出口无泄漏`);
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
