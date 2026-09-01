import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BrowserToolError } from '../../src/domain.js';
import { CONFIG_LIMITS, loadConfig, normalizeHostPattern } from '../../src/config.js';
import { getAutomationPolicy } from '../../src/browser/automation-policy.js';

const baseEnv = (overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  BROWSER_ALLOWED_HOSTS: 'Example.com, *.Example.test.',
  ...overrides,
});

describe('loadConfig', () => {
  it('requires an explicit navigation host allowlist and normalizes rules', () => {
    const config = loadConfig(baseEnv());
    expect(config.allowedHosts).toEqual(['example.com', '*.example.test']);
    expect(config.resourceHosts).toEqual(config.allowedHosts);
    expect(config.allowHttp).toBe(false);
    expect(config.allowPrivateNetwork).toBe(false);
    expect(config.maxSessions).toBe(CONFIG_LIMITS.maxSessions.default);
    expect(config.timeoutMs).toBe(CONFIG_LIMITS.timeoutMs.default);
    expect(config.automationPolicy).toBe('standard');
    expect(config.sessionTtlMs).toBe(getAutomationPolicy('standard').limits.sessionTtlMs);
    expect(config.workspaceTtlMs).toBe(getAutomationPolicy('standard').limits.workspaceTtlMs);
    expect(config.mcpRatePerSecond).toBe(CONFIG_LIMITS.mcpRatePerSecond.default);
    expect(config.mcpBurst).toBe(CONFIG_LIMITS.mcpBurst.default);
    expect(config.dataDir).toBe(resolve(process.cwd(), '.browser-data'));
    expect(config.persistentProfiles).toBe(false);
    expect(config.auditPath).toBe(resolve(process.cwd(), '.browser-data', 'audit.jsonl'));
  });

  it('rejects a missing, empty, or bare wildcard allowlist', () => {
    expect(() => loadConfig({})).toThrow(BrowserToolError);
    expect(() => loadConfig(baseEnv({ BROWSER_ALLOWED_HOSTS: '  ' }))).toThrow(BrowserToolError);
    expect(() => loadConfig(baseEnv({ BROWSER_ALLOWED_HOSTS: '*' }))).toThrow(BrowserToolError);
    expect(() => loadConfig(baseEnv({ BROWSER_ALLOWED_HOSTS: 'foo*example.com' }))).toThrow(BrowserToolError);
  });

  it('does not use suffix matching for malformed wildcard rules', () => {
    expect(normalizeHostPattern('*.example.com')).toBe('*.example.com');
    expect(() => normalizeHostPattern('example.*.com')).toThrow(BrowserToolError);
    expect(() => normalizeHostPattern('*.127.0.0.1')).toThrow(BrowserToolError);
  });

  it('parses opt-in flags strictly and keeps secure defaults', () => {
    const config = loadConfig(
      baseEnv({
        BROWSER_ALLOW_HTTP: 'TRUE',
        BROWSER_ALLOW_PRIVATE_NETWORK: 'true',
        BROWSER_MAX_SESSIONS: '8',
        BROWSER_TIMEOUT_MS: '60000',
        BROWSER_SESSION_TTL_MS: '60000',
        BROWSER_PERSIST_PROFILES: 'true',
        MCP_RATE_PER_SECOND: '50',
        MCP_BURST: '100',
        BROWSER_RESOURCE_HOSTS: 'static.example.com',
      }),
    );
    expect(config.allowHttp).toBe(true);
    expect(config.allowPrivateNetwork).toBe(true);
    expect(config.maxSessions).toBe(8);
    expect(config.timeoutMs).toBe(60_000);
    expect(config.sessionTtlMs).toBe(60_000);
    expect(config.mcpRatePerSecond).toBe(50);
    expect(config.mcpBurst).toBe(100);
    expect(config.resourceHosts).toEqual(['static.example.com']);
    expect(config.persistentProfiles).toBe(true);

    expect(() => loadConfig(baseEnv({ BROWSER_ALLOW_HTTP: 'yes' }))).toThrow(BrowserToolError);
    expect(() => loadConfig(baseEnv({ BROWSER_ALLOW_PRIVATE_NETWORK: '1' }))).toThrow(BrowserToolError);
    expect(() => loadConfig(baseEnv({ BROWSER_PERSIST_PROFILES: '1' }))).toThrow(BrowserToolError);
  });

  it('selects an administrator policy and bounds TTL overrides to that profile', () => {
    const strict = loadConfig(baseEnv({ BROWSER_AUTOMATION_POLICY: 'strict' }));
    expect(strict.automationPolicy).toBe('strict');
    expect(strict.sessionTtlMs).toBe(30 * 60_000);
    expect(strict.workspaceTtlMs).toBe(24 * 60 * 60_000);
    expect(() => loadConfig(baseEnv({
      BROWSER_AUTOMATION_POLICY: 'unknown',
    }))).toThrow(BrowserToolError);
    expect(() => loadConfig(baseEnv({
      BROWSER_AUTOMATION_POLICY: 'strict',
      BROWSER_SESSION_TTL_MS: String(30 * 60_000 + 1),
    }))).toThrow(BrowserToolError);
  });


  it('enforces numeric and server-path bounds', () => {
    expect(() => loadConfig(baseEnv({ BROWSER_MAX_SESSIONS: '0' }))).toThrow(BrowserToolError);
    expect(() => loadConfig(baseEnv({ BROWSER_MAX_SESSIONS: '33' }))).toThrow(BrowserToolError);
    expect(() => loadConfig(baseEnv({ BROWSER_TIMEOUT_MS: '999' }))).toThrow(BrowserToolError);
    expect(() => loadConfig(baseEnv({ BROWSER_TIMEOUT_MS: '60001' }))).toThrow(BrowserToolError);
    expect(() => loadConfig(baseEnv({ BROWSER_SESSION_TTL_MS: '999' }))).toThrow(BrowserToolError);
    expect(() => loadConfig(baseEnv({ BROWSER_SESSION_TTL_MS: '86400001' }))).toThrow(BrowserToolError);
    expect(() => loadConfig(baseEnv({ MCP_RATE_PER_SECOND: '0' }))).toThrow(BrowserToolError);
    expect(() => loadConfig(baseEnv({ MCP_BURST: '10001' }))).toThrow(BrowserToolError);
    expect(() => loadConfig(baseEnv({ BROWSER_DATA_DIR: 'relative-data' }))).toThrow(BrowserToolError);
    expect(() => loadConfig(baseEnv({ BROWSER_AUDIT_PATH: 'relative-audit.jsonl' }))).toThrow(BrowserToolError);

    const config = loadConfig(
      baseEnv({
        BROWSER_DATA_DIR: resolve('tmp', 'browser-data'),
        BROWSER_AUDIT_PATH: resolve('tmp', 'audit.jsonl'),
      }),
    );
    expect(config.dataDir).toBe(resolve('tmp', 'browser-data'));
    expect(config.auditPath).toBe(resolve('tmp', 'audit.jsonl'));
  });
});
