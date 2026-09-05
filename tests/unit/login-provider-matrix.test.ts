import { describe, it, expect } from 'vitest';
import type { ProviderConfig } from '../../src/acceptance/login-provider-matrix.js';
import { LoginProviderMatrix, ProviderConfigSchema } from '../../src/acceptance/login-provider-matrix.js';

describe('LoginProviderMatrix', () => {
  const matrix = new LoginProviderMatrix();

  it('should block if credentials are missing', () => {
    const config: ProviderConfig = {
      providerId: 'google',
      requiredCapabilities: ['cookie', 'oauth_redirect'],
      hasCredentials: false,
      hasAuthorization: true,
      observations: {
        cookie: { status: 'pass', evidence: 'url1', observedAt: '2023-01-01' },
        oauth_redirect: { status: 'pass', evidence: 'url2', observedAt: '2023-01-01' },
      },
    };
    const result = matrix.evaluate(config);
    expect(result.outcome).toBe('blocked');
    expect(result.reason).toContain('Missing required');
  });

  it('should block if authorization is missing', () => {
    const config: ProviderConfig = {
      providerId: 'github',
      requiredCapabilities: ['cookie'],
      hasCredentials: true,
      hasAuthorization: false,
      observations: {
        cookie: { status: 'pass', evidence: 'url1', observedAt: '2023-01-01' },
      },
    };
    const result = matrix.evaluate(config);
    expect(result.outcome).toBe('blocked');
    expect(result.reason).toContain('Missing required');
  });

  it('should fail if any required capability fails, even if another is blocked', () => {
    const config: ProviderConfig = {
      providerId: 'custom',
      requiredCapabilities: ['cookie', 'indexedDB'],
      hasCredentials: true,
      hasAuthorization: true,
      observations: {
        cookie: { status: 'blocked', evidence: 'url1', observedAt: '2023-01-01' },
        indexedDB: { status: 'fail', evidence: 'url2', observedAt: '2023-01-01' },
      },
    };
    const result = matrix.evaluate(config);
    expect(result.outcome).toBe('fail'); // precedence of fail over blocked
    expect(result.failedCapabilities).toContain('indexedDB');
    expect(result.failedCapabilities).not.toContain('cookie');
  });

  it('should pass if all required capabilities have explicit pass evidence', () => {
    const config: ProviderConfig = {
      providerId: 'twitter',
      requiredCapabilities: ['cookie', 'localStorage', 'virtual_webauthn'],
      hasCredentials: true,
      hasAuthorization: true,
      observations: {
        cookie: { status: 'pass', evidence: 'url1', observedAt: '2023-01-01' },
        localStorage: { status: 'pass', evidence: 'url2', observedAt: '2023-01-01' },
        virtual_webauthn: { status: 'pass', evidence: 'url3', observedAt: '2023-01-01' },
      },
    };
    const result = matrix.evaluate(config);
    expect(result.outcome).toBe('pass');
    expect(result.failedCapabilities.length).toBe(0);
  });

  it('should block if required capability evidence is entirely missing', () => {
    const config: ProviderConfig = {
      providerId: 'missing-ev',
      requiredCapabilities: ['cookie', 'localStorage'],
      hasCredentials: true,
      hasAuthorization: true,
      observations: {
        cookie: { status: 'pass', evidence: 'url1', observedAt: '2023-01-01' },
      },
    };
    const result = matrix.evaluate(config);
    expect(result.outcome).toBe('blocked');
    expect(result.reason).toContain('evidence');
  });

  it('should reject malformed config at zod level', () => {
    const badConfig = {
      providerId: '', // invalid empty
      requiredCapabilities: ['cookie', 'invalid_cap'],
      hasCredentials: true,
      hasAuthorization: true,
      observations: {
        cookie: { status: 'pass', evidence: '', observedAt: '2023-01-01' }, // empty evidence
      },
    };
    
    const result = ProviderConfigSchema.safeParse(badConfig);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = result.error.issues;
      expect(issues.some(i => i.path.includes('providerId'))).toBe(true);
      expect(issues.some(i => i.path.includes('requiredCapabilities'))).toBe(true);
      expect(issues.some(i => i.path.includes('evidence'))).toBe(true);
    }
  });

  it('should deduplicate required capabilities before evaluating', () => {
    const config: ProviderConfig = {
      providerId: 'dedup',
      requiredCapabilities: ['cookie', 'cookie'],
      hasCredentials: true,
      hasAuthorization: true,
      observations: {
        cookie: { status: 'pass', evidence: 'url1', observedAt: '2023-01-01' },
      },
    };
    const result = matrix.evaluate(config);
    expect(result.outcome).toBe('pass');
  });
});
