import type { UnifiedFingerprintProfile } from '../fingerprint/types.js';

export type EnvironmentDiagnosticStatus = 'pass' | 'warning' | 'fail';
export type EnvironmentConsistency = 'consistent' | 'warning' | 'inconsistent';

export type EnvironmentProbeObservation<T> =
  | { readonly status: 'observed'; readonly value: T }
  | { readonly status: 'unavailable' | 'error' | 'timeout'; readonly error: string };

export interface EnvironmentWorkerIdentity {
  readonly userAgent?: string;
  readonly platform?: string;
  readonly language?: string;
  readonly languages?: readonly string[];
  readonly timezone?: string;
  readonly hardwareConcurrency?: number;
  readonly deviceMemory?: number;
  readonly canvas?: readonly number[];
  readonly webgl?: { readonly vendor?: string; readonly renderer?: string };
}

export interface EnvironmentDeepSnapshot {
  readonly css?: EnvironmentProbeObservation<{
    readonly screenWidthMatches: boolean;
    readonly screenHeightMatches: boolean;
    readonly resolutionMatches: boolean;
    readonly viewportWidthMatches: boolean;
    readonly viewportHeightMatches: boolean;
  }>;
  readonly crossRealm?: EnvironmentProbeObservation<{
    readonly functionToStringNative: boolean;
    readonly getters: readonly {
      readonly property: string;
      readonly nativeSource: boolean;
      readonly rejectsIllegalReceiver: boolean;
    }[];
    readonly webglNative?: boolean;
  }>;
  readonly canvas?: EnvironmentProbeObservation<{ readonly cropMatches: boolean; readonly repeatMatches: boolean }>;
  readonly audio?: EnvironmentProbeObservation<{
    readonly realtimeSampleRate: number;
    readonly nativeRealtimeSampleRate?: number;
    readonly realtimeBufferSampleRate: number;
    readonly renders: readonly {
      readonly requestedSampleRate: number;
      readonly contextSampleRate: number;
      readonly bufferSampleRate: number;
      readonly renderedSampleRate: number;
      readonly durationMatches: boolean;
      readonly silentBuffer: boolean;
      readonly silentCopy: boolean;
      readonly silentRender: boolean;
    }[];
  }>;
  readonly worker?: EnvironmentProbeObservation<{
    readonly identity: EnvironmentWorkerIdentity;
    readonly serializedIdentity: string;
    readonly navigatorJSON: string;
    readonly canvasMatches?: boolean;
  }>;
  readonly serviceWorker?: EnvironmentProbeObservation<{
    readonly secureContext: boolean;
    readonly exposed: boolean;
    readonly getRegistrationsCallable: boolean;
    readonly registerCallable: boolean;
    readonly querySucceeded: boolean;
    readonly registrationCount?: number;
    readonly methodsNative?: boolean;
    readonly controlled: boolean;
    readonly registrationAttempted: false;
  }>;
}

export interface EnvironmentSurfaceSnapshot extends EnvironmentWorkerIdentity {
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
  readonly webdriver?: boolean;
  readonly webgl?: { readonly vendor?: string; readonly renderer?: string };
  readonly integrity?: {
    readonly hasNavigatorInstancePollution: boolean;
    readonly pollutedNavigatorProps: readonly string[];
    readonly isNavigatorToStringNative: boolean;
    readonly isFunctionToStringNative: boolean;
    readonly isWebglNative: boolean;
  };
  readonly deep?: EnvironmentDeepSnapshot;
  readonly errors?: Readonly<Record<string, string>>;
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
    readonly screen?: EnvironmentSurfaceSnapshot['screen'];
    readonly hardwareConcurrency?: number;
    readonly deviceMemory?: number;
    readonly webgl?: { readonly vendor?: string; readonly renderer?: string };
    readonly webrtc?: string;
    readonly workerCanvasProtection?: boolean;
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
    screen: profile.screen,
    hardwareConcurrency: profile.hardware.hardwareConcurrency,
    deviceMemory: profile.hardware.deviceMemory,
    webgl: { vendor: profile.webgl.unmaskedVendor || profile.webgl.vendor, renderer: profile.webgl.unmaskedRenderer || profile.webgl.renderer },
    webrtc: profile.webrtc,
    workerCanvasProtection: profile.canvas.enabled,
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
  const compare = (id: string, expected: unknown, actual: unknown): void => {
    if (!present(actual)) check(id, 'warning', '缺少运行时证据，未验证');
    else if (!present(expected)) check(id, 'warning', '缺少配置基准，未验证');
    else check(id, equal(expected, actual) ? 'pass' : 'fail', equal(expected, actual) ? '观测与配置一致' : '观测与配置不一致');
  };
  const evidence = <T>(id: string, observation: EnvironmentProbeObservation<T> | undefined): T | undefined => {
    if (!observation) check(id, 'warning', '未采集深层证据');
    else if (observation.status !== 'observed') check(id, 'warning', `${observation.status}: ${observation.error}`);
    else return observation.value;
    return undefined;
  };
  const invariant = (id: string, values: readonly (boolean | undefined)[]): void => {
    check(id, values.some((value) => value === false) ? 'fail' : values.length === 0 || values.some((value) => value !== true) ? 'warning' : 'pass',
      values.some((value) => value === false) ? '检测到行为不一致' : values.length === 0 || values.some((value) => value !== true) ? '缺少完整行为证据' : '已观测行为一致');
  };
  const observed = input.observed;
  const expected = input.expected;
  if (!observed) {
    check('runtime-surface', 'warning', '无法读取浏览器运行时表面');
  } else {
    compare('browser-version', expected.browserMajor, observed.userAgent?.match(/(?:Firefox|Chrome|Chromium)\/(\d+)/)?.[1]);
    compare('user-agent', expected.userAgent, observed.userAgent);
    if (expected.platform) compare('platform', expected.platform, observed.platform);
    else if (expected.os && observed.platform) invariant('platform', [platformMatches(expected.os, observed.platform)]);
    else compare('platform', undefined, observed.platform);
    compare('locale', expected.locale?.toLowerCase(), observed.language?.toLowerCase());
    compare('languages', expected.languages, observed.languages);
    compare('timezone', expected.timezone, observed.timezone);
    compare('viewport', expected.viewport, observed.viewport);
    compare('hardware-concurrency', expected.hardwareConcurrency, observed.hardwareConcurrency);
    compare('device-memory', expected.deviceMemory, observed.deviceMemory);
    for (const field of ['width', 'height', 'availWidth', 'availHeight', 'colorDepth', 'pixelDepth', 'devicePixelRatio'] as const) {
      const baseline = expected.screen?.[field];
      const actual = observed.screen?.[field];
      if (field === 'devicePixelRatio' && typeof baseline === 'number' && typeof actual === 'number'
        && Number.isFinite(baseline) && Number.isFinite(actual) && baseline > 0 && actual > 0) {
        // Native headed compositors round display scaling through float32.
        invariant(`screen-${field}`, [Math.abs(baseline - actual) <= Math.max(baseline, actual) * 2 ** -23]);
      } else compare(`screen-${field}`, baseline, actual);
    }
    compare('webgl-vendor', expected.webgl?.vendor, observed.webgl?.vendor);
    compare('webgl-renderer', expected.webgl?.renderer, observed.webgl?.renderer);
    check('webdriver-signal', observed.webdriver === false ? 'pass' : 'warning', observed.webdriver === true ? '检测到 navigator.webdriver 信号' : observed.webdriver === false ? '已观测 webdriver=false' : '未读取 webdriver，未验证');
    if (observed.integrity) {
      invariant('navigator-prototype-integrity', [observed.integrity.hasNavigatorInstancePollution === false, observed.integrity.pollutedNavigatorProps?.length === 0]);
      invariant('navigator-tostring-integrity', [observed.integrity.isNavigatorToStringNative]);
      // Same-realm toString is not proof of native code; only negative evidence is useful here.
      if (observed.integrity.isFunctionToStringNative === false) invariant('function-tostring-integrity', [false]);
    } else check('navigator-prototype-integrity', 'warning', '未采集 Navigator 完整性证据');

    const crossRealm = evidence('cross-realm-integrity', observed.deep?.crossRealm);
    if (crossRealm) {
      invariant('function-tostring-integrity', [crossRealm.functionToStringNative]);
      const required = ['userAgent', 'platform', 'language', 'languages', 'hardwareConcurrency', 'webdriver'];
      if (observed.deviceMemory !== undefined) required.push('deviceMemory');
      invariant('navigator-getter-integrity', required.flatMap((property) => {
        const getter = crossRealm.getters?.find((item) => item.property === property);
        return [getter?.nativeSource, getter?.rejectsIllegalReceiver];
      }));
      invariant('webgl-native-integrity', [crossRealm.webglNative]);
    }
    const css = evidence('css-screen-dpr', observed.deep?.css);
    if (css) invariant('css-screen-dpr', [css.screenWidthMatches, css.screenHeightMatches, css.resolutionMatches, css.viewportWidthMatches, css.viewportHeightMatches]);
    const canvas = evidence('canvas-pixel-consistency', observed.deep?.canvas);
    if (canvas) invariant('canvas-pixel-consistency', [canvas.cropMatches, canvas.repeatMatches]);
    const audio = evidence('audio-integrity', observed.deep?.audio);
    if (audio) {
      const renders = audio.renders;
      invariant('audio-integrity', [
        Number.isFinite(audio.realtimeSampleRate) && audio.realtimeSampleRate > 0,
        audio.realtimeSampleRate === audio.realtimeBufferSampleRate,
        audio.nativeRealtimeSampleRate === undefined ? undefined : audio.nativeRealtimeSampleRate === audio.realtimeSampleRate,
        renders?.length === 2 && renders[0]?.requestedSampleRate === 44100 && renders[1]?.requestedSampleRate === 48000,
        ...(renders ?? []).flatMap((render) => [render.contextSampleRate === render.requestedSampleRate, render.bufferSampleRate === render.requestedSampleRate, render.renderedSampleRate === render.requestedSampleRate, render.durationMatches, render.silentBuffer, render.silentCopy, render.silentRender]),
      ]);
    }
    const worker = evidence('worker-identity', observed.deep?.worker);
    if (expected.workerCanvasProtection && input.engine === 'firefox') {
      check('worker-bootstrap-support', 'fail', 'Firefox 缺少可验证的首脚本 Worker Canvas 注入；页面保护仍启用，但 URL/Blob/Shared/ServiceWorker 不具备同等保护。现有定制内核补丁仅覆盖 CPU 和时区。');
    }
    if (worker) {
      let serialized: EnvironmentWorkerIdentity | undefined;
      try { serialized = JSON.parse(worker.serializedIdentity) as EnvironmentWorkerIdentity; } catch { /* Invalid JSON is explicit negative evidence below. */ }
      invariant('worker-json-identity', [!!serialized && equal(serialized, worker.identity), worker.navigatorJSON === '{}']);
      for (const field of ['userAgent', 'platform', 'language', 'languages', 'timezone', 'hardwareConcurrency', 'deviceMemory'] as const) {
        compare(`worker-${field}`, observed[field], worker.identity?.[field]);
      }
      invariant('worker-canvas-consistency', [worker.canvasMatches]);
      compare('worker-webgl-vendor', observed.webgl?.vendor, worker.identity?.webgl?.vendor);
      compare('worker-webgl-renderer', observed.webgl?.renderer, worker.identity?.webgl?.renderer);
    }
    const serviceWorker = evidence('service-worker-availability', observed.deep?.serviceWorker);
    if (serviceWorker) {
      invariant('service-worker-native-integrity', [serviceWorker.methodsNative]);
      const available = serviceWorker.secureContext && serviceWorker.exposed && serviceWorker.getRegistrationsCallable && serviceWorker.registerCallable && serviceWorker.querySucceeded && serviceWorker.methodsNative === true;
      check('service-worker-availability', available ? 'pass' : 'warning', available ? 'ServiceWorker 容器可调用且注册列表查询成功；未主动注册，不证明脚本执行能力' : 'ServiceWorker 不可用或未能查询，未验证');
      check('service-worker-execution', 'warning', '未注册或执行 ServiceWorker，不证明其身份与窗口一致');
    }
    for (const [surface, error] of Object.entries(observed.errors ?? {})) check(`probe-error-${surface}`, 'warning', error);
  }
  if (expected.webrtc) check('webrtc-policy', 'warning', `配置策略 ${expected.webrtc}；未执行网络 ICE/STUN 验证，不能证明实际防泄漏`);
  const consistency: EnvironmentConsistency = checks.some((item) => item.status === 'fail')
    ? 'inconsistent'
    : checks.some((item) => item.status === 'warning') ? 'warning' : 'consistent';
  return {
    generatedAt: new Date().toISOString(),
    sessionId: input.sessionId,
    engine: input.engine,
    headless: input.headless,
    consistency,
    expected,
    ...(observed ? { observed } : {}),
    checks,
  };
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '' && (!Array.isArray(value) || value.length > 0)
    && (typeof value !== 'number' || Number.isFinite(value));
}

function equal(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item, index) => equal(item, right[index]));
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const a = left as Record<string, unknown>;
    const b = right as Record<string, unknown>;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]));
  }
  return left === right;
}

function platformMatches(os: string, platform: string): boolean {
  const value = platform.toLowerCase();
  if (os === 'windows') return value.includes('win');
  if (os === 'macos') return value.includes('mac');
  if (os === 'linux') return value.includes('linux') || value.includes('x11');
  return false;
}
