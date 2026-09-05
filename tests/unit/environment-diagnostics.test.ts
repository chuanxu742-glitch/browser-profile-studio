import { describe, expect, it } from 'vitest';
import {
  buildEnvironmentDiagnostics,
  type EnvironmentDiagnostics,
  type EnvironmentSurfaceSnapshot,
} from '../../src/browser/environment-diagnostics.js';

const expected = {
  browserMajor: '120',
  os: 'windows',
  userAgent: 'Mozilla/5.0 Chrome/120.0',
  platform: 'Win32',
  locale: 'zh-CN',
  languages: ['zh-CN', 'en'],
  timezone: 'Asia/Shanghai',
  viewport: { width: 1280, height: 720 },
  screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelDepth: 24, devicePixelRatio: 1 },
  hardwareConcurrency: 8,
  deviceMemory: 8,
  webgl: { vendor: 'Test Vendor', renderer: 'Test Renderer' },
  webrtc: 'block_leak',
} satisfies EnvironmentDiagnostics['expected'];

const identity = {
  userAgent: expected.userAgent,
  platform: expected.platform,
  language: expected.locale,
  languages: expected.languages,
  timezone: expected.timezone,
  hardwareConcurrency: expected.hardwareConcurrency,
  deviceMemory: expected.deviceMemory,
  canvas: [51, 69, 59, 255],
  webgl: expected.webgl,
};

const crossRealm = {
  functionToStringNative: true,
  getters: ['userAgent', 'platform', 'language', 'languages', 'hardwareConcurrency', 'deviceMemory', 'webdriver'].map((property) => ({ property, nativeSource: true, rejectsIllegalReceiver: true })),
  webglNative: true,
};
const css = { screenWidthMatches: true, screenHeightMatches: true, resolutionMatches: true, viewportWidthMatches: true, viewportHeightMatches: true };
const audio = {
  realtimeSampleRate: 48000,
  nativeRealtimeSampleRate: 48000,
  realtimeBufferSampleRate: 48000,
  renders: [44100, 48000].map((requestedSampleRate) => ({
    requestedSampleRate, contextSampleRate: requestedSampleRate,
    bufferSampleRate: requestedSampleRate, renderedSampleRate: requestedSampleRate,
    durationMatches: true, silentBuffer: true, silentCopy: true, silentRender: true,
  })),
};
const worker = { identity, serializedIdentity: JSON.stringify(identity), navigatorJSON: '{}', canvasMatches: true };
const serviceWorker = {
  secureContext: true, exposed: true, getRegistrationsCallable: true,
  registerCallable: true, querySucceeded: true, registrationCount: 0,
  methodsNative: true, controlled: false, registrationAttempted: false as const,
};
const observed: EnvironmentSurfaceSnapshot = {
  ...identity,
  viewport: expected.viewport,
  screen: expected.screen,
  webdriver: false,
  webgl: expected.webgl,
  integrity: {
    hasNavigatorInstancePollution: false, pollutedNavigatorProps: [],
    isNavigatorToStringNative: true, isFunctionToStringNative: true, isWebglNative: true,
  },
  deep: {
    crossRealm: { status: 'observed', value: crossRealm },
    css: { status: 'observed', value: css },
    canvas: { status: 'observed', value: { cropMatches: true, repeatMatches: true } },
    audio: { status: 'observed', value: audio },
    worker: { status: 'observed', value: worker },
    serviceWorker: { status: 'observed', value: serviceWorker },
  },
};

function diagnose(surface?: EnvironmentSurfaceSnapshot): EnvironmentDiagnostics {
  return buildEnvironmentDiagnostics({ sessionId: 'ses_diagnostics_1234', engine: 'chromium', headless: true, expected, ...(surface ? { observed: surface } : {}) });
}

function status(result: EnvironmentDiagnostics, id: string): string | undefined {
  return result.checks.find((check) => check.id === id)?.status;
}

describe('environment diagnostics', () => {
  it('does not certify network leak prevention or service-worker execution from configuration and API presence', () => {
    const result = diagnose(observed);
    expect(result.consistency).toBe('warning');
    expect(status(result, 'webrtc-policy')).toBe('warning');
    expect(status(result, 'service-worker-execution')).toBe('warning');
    expect(status(result, 'service-worker-availability')).toBe('pass');
    expect(result.checks.some((check) => check.status === 'fail')).toBe(false);
  });

  it('never treats missing runtime fields or unmasked WebGL identity as matching', () => {
    const missing = diagnose({});
    expect(missing.consistency).toBe('warning');
    expect(missing.checks.some((check) => check.status === 'pass')).toBe(false);
    const masked = diagnose({ ...observed, webgl: {} });
    expect(status(masked, 'webgl-vendor')).toBe('warning');
    expect(status(masked, 'webgl-renderer')).toBe('warning');
    expect(diagnose().consistency).toBe('warning');
  });

  it('distinguishes automation evidence from an actual profile mismatch', () => {
    const automation = diagnose({ ...observed, webdriver: true });
    expect(status(automation, 'webdriver-signal')).toBe('warning');
    const mismatch = diagnose({ ...observed, timezone: 'UTC', languages: ['en', 'zh-CN'], deviceMemory: 4 });
    expect(mismatch.consistency).toBe('inconsistent');
    for (const id of ['timezone', 'languages', 'device-memory']) expect(status(mismatch, id)).toBe('fail');
  });

  it('detects screen and CSS disagreement even when JavaScript surfaces match the profile', () => {
    const screenMismatch = diagnose({ ...observed, screen: { ...expected.screen, devicePixelRatio: 2 } });
    expect(status(screenMismatch, 'screen-devicePixelRatio')).toBe('fail');
    const cssMismatch = diagnose({ ...observed, deep: { ...observed.deep, css: { status: 'observed', value: { ...css, resolutionMatches: false } } } });
    expect(cssMismatch.consistency).toBe('inconsistent');
    expect(status(cssMismatch, 'css-screen-dpr')).toBe('fail');
  });

  it('accepts native float32 DPR rounding but rejects scaling mismatches and invalid ratios', () => {
    const rounded = diagnose({ ...observed, screen: { ...expected.screen, devicePixelRatio: 1 + 2 ** -23 } });
    expect(status(rounded, 'screen-devicePixelRatio')).toBe('pass');
    for (const devicePixelRatio of [1 + 2 ** -22, 0, -1]) {
      const mismatch = diagnose({ ...observed, screen: { ...expected.screen, devicePixelRatio } });
      expect(status(mismatch, 'screen-devicePixelRatio'), String(devicePixelRatio)).toBe('fail');
    }
    for (const devicePixelRatio of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const missing = diagnose({ ...observed, screen: { ...expected.screen, devicePixelRatio } });
      expect(status(missing, 'screen-devicePixelRatio')).toBe('warning');
    }
  });

  it('does not trust same-realm native-code claims without cross-realm evidence', () => {
    const result = diagnose({ ...observed, deep: {} });
    expect(status(result, 'cross-realm-integrity')).toBe('warning');
    expect(result.checks.some((check) => check.id === 'function-tostring-integrity' && check.status === 'pass')).toBe(false);
  });

  it('rejects leaked getter source and getters accepting an illegal receiver', () => {
    for (const defect of ['nativeSource', 'rejectsIllegalReceiver'] as const) {
      const result = diagnose({ ...observed, deep: { ...observed.deep, crossRealm: { status: 'observed', value: {
        ...crossRealm,
        getters: crossRealm.getters.map((getter) => getter.property === 'userAgent' ? { ...getter, [defect]: false } : getter),
      } } } });
      expect(result.consistency).toBe('inconsistent');
      expect(status(result, 'navigator-getter-integrity')).toBe('fail');
    }
    const missingGetter = diagnose({ ...observed, deep: { ...observed.deep, crossRealm: { status: 'observed', value: { ...crossRealm, getters: [] } } } });
    expect(status(missingGetter, 'navigator-getter-integrity')).toBe('warning');
  });

  it('rejects origin-dependent canvas pixels and silent audio contamination', () => {
    const canvasMismatch = diagnose({ ...observed, deep: { ...observed.deep, canvas: { status: 'observed', value: { cropMatches: false, repeatMatches: true } } } });
    expect(status(canvasMismatch, 'canvas-pixel-consistency')).toBe('fail');
    const audioMismatch = diagnose({ ...observed, deep: { ...observed.deep, audio: { status: 'observed', value: {
      ...audio, renders: audio.renders.map((render) => ({ ...render, silentBuffer: false })),
    } } } });
    expect(status(audioMismatch, 'audio-integrity')).toBe('fail');
    expect(audioMismatch.consistency).toBe('inconsistent');
  });

  it('rejects self-consistent reported rates that disagree with the cross-realm native getter', () => {
    const result = diagnose({ ...observed, deep: { ...observed.deep, audio: { status: 'observed', value: { ...audio, realtimeSampleRate: 44100, realtimeBufferSampleRate: 44100 } } } });
    expect(status(result, 'audio-integrity')).toBe('fail');
  });

  it('compares actual serialized worker identity and the window, rather than trusting worker presence', () => {
    const divergent = { ...identity, platform: 'Linux x86_64' };
    const result = diagnose({ ...observed, deep: { ...observed.deep, worker: { status: 'observed', value: { ...worker, identity: divergent, serializedIdentity: JSON.stringify(divergent) } } } });
    expect(status(result, 'worker-json-identity')).toBe('pass');
    expect(status(result, 'worker-platform')).toBe('fail');
    const spoofedJSON = diagnose({ ...observed, deep: { ...observed.deep, worker: { status: 'observed', value: { ...worker, serializedIdentity: JSON.stringify(divergent) } } } });
    expect(status(spoofedJSON, 'worker-json-identity')).toBe('fail');
  });

  it('keeps absent worker graphics evidence unverified and rejects observed graphics mismatches', () => {
    const { canvas: _canvas, webgl: _webgl, ...withoutGraphics } = identity;
    const missing = diagnose({ ...observed, deep: { ...observed.deep, worker: { status: 'observed', value: {
      identity: withoutGraphics, serializedIdentity: JSON.stringify(withoutGraphics), navigatorJSON: '{}',
    } } } });
    for (const id of ['worker-canvas-consistency', 'worker-webgl-vendor', 'worker-webgl-renderer']) {
      expect(status(missing, id)).toBe('warning');
    }
    const divergent = { ...identity, canvas: [59, 69, 59, 255], webgl: { vendor: 'Other Vendor', renderer: 'Other Renderer' } };
    const mismatch = diagnose({ ...observed, deep: { ...observed.deep, worker: { status: 'observed', value: {
      identity: divergent, serializedIdentity: JSON.stringify(divergent), navigatorJSON: '{}', canvasMatches: false,
    } } } });
    expect(mismatch.consistency).toBe('inconsistent');
    for (const id of ['worker-canvas-consistency', 'worker-webgl-vendor', 'worker-webgl-renderer']) {
      expect(status(mismatch, id)).toBe('fail');
    }
  });

  it('preserves timeouts and unavailable services as unverified instead of passing', () => {
    const result = diagnose({ ...observed, deep: {
      ...observed.deep,
      worker: { status: 'timeout', error: 'Worker did not answer' },
      audio: { status: 'error', error: 'Audio operation failed' },
      serviceWorker: { status: 'observed', value: { ...serviceWorker, exposed: false, querySucceeded: false } },
    } });
    for (const id of ['worker-identity', 'audio-integrity', 'service-worker-availability']) expect(status(result, id)).toBe('warning');
    const fakeService = diagnose({ ...observed, deep: { ...observed.deep, serviceWorker: { status: 'observed', value: { ...serviceWorker, methodsNative: false } } } });
    expect(status(fakeService, 'service-worker-native-integrity')).toBe('fail');
    expect(status(fakeService, 'service-worker-availability')).not.toBe('pass');
  });
});
