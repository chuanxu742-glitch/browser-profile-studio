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
  it('reports a consistent browser surface without exposing page content', () => {
    const result = buildEnvironmentDiagnostics({
      sessionId: 'ses_diagnostics_1234',
      engine: 'firefox',
      headless: true,
      expected,
      observed,
    });

    expect(result.consistency).toBe('consistent');
    expect(result.checks.every((check) => check.status === 'pass')).toBe(true);
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

  it('reports consistent when object integrity check passes cleanly', () => {
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

    expect(result.consistency).toBe('consistent');
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
});
