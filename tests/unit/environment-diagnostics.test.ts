import { describe, expect, it } from 'vitest';
import { buildEnvironmentDiagnostics } from '../../src/browser/environment-diagnostics.js';

const expected = {
  browserMajor: '120',
  os: 'windows' as const,
  userAgent: 'Mozilla/5.0 Firefox/120.0',
  platform: 'Win32',
  locale: 'zh-CN',
  languages: ['zh-CN'],
  timezone: 'Asia/Shanghai',
  viewport: { width: 1280, height: 720 },
  hardwareConcurrency: 8,
  webgl: { vendor: 'Test Vendor', renderer: 'Test Renderer' },
  webrtc: 'block_leak',
};

const observed = {
  userAgent: 'Mozilla/5.0 Firefox/120.0',
  platform: 'Win32',
  language: 'zh-CN',
  languages: ['zh-CN'],
  timezone: 'Asia/Shanghai',
  viewport: { width: 1280, height: 720 },
  hardwareConcurrency: 8,
  webdriver: false,
  webgl: { vendor: 'Test Vendor', renderer: 'Test Renderer' },
};

describe('environment diagnostics', () => {
  it('does not certify network or native integrity from identity fields alone', () => {
    const result = buildEnvironmentDiagnostics({
      sessionId: 'ses_diagnostics_1234',
      engine: 'firefox',
      headless: true,
      expected,
      observed,
    });

    expect(result.consistency).toBe('warning');
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'webrtc-policy', status: 'warning' }),
      expect.objectContaining({ id: 'native-integrity', status: 'warning' }),
      expect.objectContaining({ id: 'user-agent', status: 'pass' }),
    ]));
    expect(result).not.toHaveProperty('url');
    expect(result).not.toHaveProperty('cookies');
    expect(result).not.toHaveProperty('content');
  });

  it('warns on detectable or inconsistent surfaces without changing them', () => {
    const result = buildEnvironmentDiagnostics({
      sessionId: 'ses_diagnostics_1234',
      engine: 'firefox',
      headless: true,
      expected,
      observed: { ...observed, webdriver: true, timezone: 'UTC' },
    });

    expect(result.consistency).toBe('warning');
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'webdriver-signal', status: 'warning' }),
      expect.objectContaining({ id: 'timezone', status: 'warning' }),
    ]));
  });

  it('fails consistency when navigator prototype is polluted or native integrity is compromised', () => {
    const result = buildEnvironmentDiagnostics({
      sessionId: 'ses_diagnostics_1234',
      engine: 'firefox',
      headless: true,
      expected,
      observed: {
        ...observed,
        integrity: {
          hasNavigatorInstancePollution: true,
          pollutedNavigatorProps: ['hardwareConcurrency', 'userAgent'],
          isNavigatorToStringNative: true,
          isFunctionToStringNative: false,
          isWebglNative: true,
        },
      },
    });

    expect(result.consistency).toBe('inconsistent');
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'navigator-prototype-integrity', status: 'fail' }),
      expect.objectContaining({ id: 'function-tostring-integrity', status: 'fail' }),
    ]));
  });

  it('keeps network verification unknown even when measured object checks pass', () => {
    const result = buildEnvironmentDiagnostics({
      sessionId: 'ses_diagnostics_1234',
      engine: 'firefox',
      headless: true,
      expected,
      observed: {
        ...observed,
        integrity: {
          hasNavigatorInstancePollution: false,
          pollutedNavigatorProps: [],
          isNavigatorToStringNative: true,
          isFunctionToStringNative: true,
          isWebglNative: true,
        },
      },
    });

    expect(result.consistency).toBe('warning');
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'navigator-prototype-integrity', status: 'pass' }),
      expect.objectContaining({ id: 'function-tostring-integrity', status: 'pass' }),
    ]));
  });

  it('returns a bounded warning when the runtime probe is unavailable', () => {
    const result = buildEnvironmentDiagnostics({
      sessionId: 'ses_diagnostics_1234',
      engine: 'firefox',
      headless: false,
      expected: {},
    });

    expect(result.consistency).toBe('warning');
    expect(result.checks).toEqual([expect.objectContaining({ id: 'runtime-surface', status: 'warning' })]);
  });

  it('does not pass expected identity fields when observations are missing', () => {
    const result = buildEnvironmentDiagnostics({ sessionId: 'missing', engine: 'chromium', headless: true, expected, observed: {} });
    expect(result.checks.some(check => check.status === 'pass')).toBe(false);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'webgl', status: 'warning' }),
      expect.objectContaining({ id: 'languages', status: 'warning' }),
      expect.objectContaining({ id: 'hardware-concurrency', status: 'warning' }),
    ]));
  });

  it('does not certify WebGL when no comparable vendor or renderer is configured', () => {
    const result = buildEnvironmentDiagnostics({
      sessionId: 'empty-webgl', engine: 'chromium', headless: true,
      expected: { webgl: {} }, observed: {},
    });
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'webgl', status: 'warning' }));
  });

  it('keeps partial integrity probes unknown instead of certifying missing observations', () => {
    const result = buildEnvironmentDiagnostics({
      sessionId: 'partial-integrity', engine: 'chromium', headless: true,
      expected: {}, observed: { integrity: { hasNavigatorInstancePollution: false } },
    });
    expect(result.consistency).toBe('warning');
    expect(result.checks.filter(check => check.id.includes('integrity') || check.id === 'webgl-function-shape'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'navigator-prototype-integrity', status: 'warning' }),
        expect.objectContaining({ id: 'function-tostring-integrity', status: 'warning' }),
        expect.objectContaining({ id: 'navigator-tostring-integrity', status: 'warning' }),
        expect.objectContaining({ id: 'webgl-function-shape', status: 'warning' }),
      ]));
    expect(result.checks.some(check => check.status === 'pass' || check.status === 'fail')).toBe(false);
  });

  it('does not let a negative summary hide observed navigator pollution', () => {
    const result = buildEnvironmentDiagnostics({
      sessionId: 'contradictory-integrity', engine: 'chromium', headless: true,
      expected: {}, observed: { integrity: { hasNavigatorInstancePollution: false, pollutedNavigatorProps: ['userAgent'] } },
    });
    expect(result.consistency).toBe('inconsistent');
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'navigator-prototype-integrity', status: 'fail' }));
  });
});
