import { isAbsolute, normalize, parse as parsePath, resolve, join } from 'node:path';
import { isIPv4, isIPv6 } from 'node:net';
import { domainToASCII } from 'node:url';

import { BrowserToolError } from './domain.js';
import {
  DEFAULT_AUTOMATION_POLICY,
  getAutomationPolicy,
  parseAutomationPolicy,
  type AutomationPolicyName,
} from './browser/automation-policy.js';

/** Hard bounds are intentionally small; callers cannot widen them. */
export const CONFIG_LIMITS = Object.freeze({
  maxSessions: Object.freeze({ min: 1, max: 32, default: 2 }),
  timeoutMs: Object.freeze({ min: 1_000, max: 60_000, default: 15_000 }),
  /** Absolute wall-clock lifetime of one browser session. */
  sessionTtlMs: Object.freeze({ min: 60_000, max: 86_400_000, default: 2 * 60 * 60_000 }),
  /** Retention lifetime for inactive workspace records. */
  workspaceTtlMs: Object.freeze({ min: 60_000, max: 7 * 24 * 60 * 60_000, default: 7 * 24 * 60 * 60_000 }),
  mcpRatePerSecond: Object.freeze({ min: 1, max: 1_000, default: 20 }),
  mcpBurst: Object.freeze({ min: 1, max: 10_000, default: 40 }),
  maxPathLength: 4_096,
});

export interface AppConfig {
  /** Exact hosts and explicit `*.example.com` rules for top-level navigation. */
  readonly allowedHosts: readonly string[];
  /** Resource hosts. When omitted, resources use the navigation allowlist. */
  readonly resourceHosts: readonly string[];
  readonly allowHttp: boolean;
  readonly allowPrivateNetwork: boolean;
  /** Permit only the reserved 198.18.0.0/15 synthetic tunnel range. */
  readonly allowSyntheticTunnel: boolean;
  readonly maxSessions: number;
  readonly timeoutMs: number;
  /** Administrator-selected resource policy profile. */
  readonly automationPolicy: AutomationPolicyName;
  /** Absolute wall-clock lifetime of one browser session. */
  readonly sessionTtlMs?: number;
  /** Retention lifetime for inactive workspace records. */
  readonly workspaceTtlMs?: number;
  /** Process-local stdio MCP safety valve. */
  readonly mcpRatePerSecond?: number;
  readonly mcpBurst?: number;
  /** Server-owned absolute profile/data directory. */
  readonly dataDir: string;
  /** Persist named browser profiles across process restarts when enabled. */
  readonly persistentProfiles: boolean;
  /** Server-owned absolute append-only audit file. */
  readonly auditPath: string;
}

export type ConfigEnvironment = Readonly<Record<string, string | undefined>>;

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV6_BRACKET = /^\[([^\[\]]+)\]$/;

/**
 * Normalize an exact host or a single-label-boundary wildcard host.
 *
 * The returned value is lower-case ASCII and has no trailing DNS dot. IPv6
 * literals retain brackets so that they remain unambiguous in host rules.
 */
export function normalizeHostPattern(raw: string): string {
  if (typeof raw !== 'string') {
    throw configError('BROWSER_ALLOWED_HOSTS', 'host rule must be text');
  }

  const value = raw.trim();
  if (!value) throw configError('BROWSER_ALLOWED_HOSTS', 'host rule is empty');
  if (value === '*') throw configError('BROWSER_ALLOWED_HOSTS', 'bare wildcard is not allowed');

  if (value.startsWith('*.')) {
    const base = normalizeHost(value.slice(2));
    if (isIpLiteralRule(base)) {
      throw configError('BROWSER_ALLOWED_HOSTS', 'wildcards cannot target an IP literal');
    }
    if (base.split('.').length < 2) {
      throw configError('BROWSER_ALLOWED_HOSTS', 'wildcards must target a registrable-style domain');
    }
    return `*.${base}`;
  }
  if (value.includes('*')) {
    throw configError('BROWSER_ALLOWED_HOSTS', 'wildcards must use the *.example.com form');
  }

  return normalizeHost(value);
}

/** Parse and de-duplicate a comma-separated host rule list. */
export function parseHostList(raw: string, field = 'BROWSER_ALLOWED_HOSTS'): readonly string[] {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw configError(field, 'at least one host rule is required');
  }

  const values = raw.split(',').map((entry) => entry.trim());
  if (values.some((entry) => !entry)) {
    throw configError(field, 'empty host rules are not allowed');
  }

  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    let normalized: string;
    try {
      normalized = normalizeHostPattern(value);
    } catch (error) {
      if (error instanceof BrowserToolError && error.details.field === 'BROWSER_ALLOWED_HOSTS') {
        throw new BrowserToolError('INVALID_INPUT', error.message, {
          details: { field, reason: error.details.reason },
        });
      }
      throw error;
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return Object.freeze(result);
}

/**
 * Load only administrator/server configuration. Browser callers do not get a
 * path or policy override; all values come from the supplied environment.
 */
export function loadConfig(env: ConfigEnvironment = process.env): AppConfig {
  const allowedRaw = env.BROWSER_ALLOWED_HOSTS;
  if (allowedRaw === undefined || !allowedRaw.trim()) {
    throw configError('BROWSER_ALLOWED_HOSTS', 'the variable is required and cannot be empty');
  }
  const allowedHosts = parseHostList(allowedRaw, 'BROWSER_ALLOWED_HOSTS');

  const resourceRaw = env.BROWSER_RESOURCE_HOSTS;
  const resourceHosts =
    resourceRaw === undefined || !resourceRaw.trim()
      ? allowedHosts
      : parseHostList(resourceRaw, 'BROWSER_RESOURCE_HOSTS');

  const allowHttp = parseBoolean(env.BROWSER_ALLOW_HTTP, 'BROWSER_ALLOW_HTTP');
  const allowPrivateNetwork = parseBoolean(
    env.BROWSER_ALLOW_PRIVATE_NETWORK,
    'BROWSER_ALLOW_PRIVATE_NETWORK',
  );
  const allowSyntheticTunnel = parseBoolean(
    env.BROWSER_ALLOW_SYNTHETIC_TUNNEL,
    'BROWSER_ALLOW_SYNTHETIC_TUNNEL',
  );
  let automationPolicy: AutomationPolicyName;
  try {
    automationPolicy = parseAutomationPolicy(env.BROWSER_AUTOMATION_POLICY);
  } catch {
    throw configError('BROWSER_AUTOMATION_POLICY', 'must be strict, standard, or trusted-local');
  }
  const policy = getAutomationPolicy(automationPolicy);


  const maxSessions = parseBoundedInteger(
    env.BROWSER_MAX_SESSIONS,
    CONFIG_LIMITS.maxSessions.default,
    CONFIG_LIMITS.maxSessions.min,
    CONFIG_LIMITS.maxSessions.max,
    'BROWSER_MAX_SESSIONS',
  );
  const timeoutMs = parseBoundedInteger(
    env.BROWSER_TIMEOUT_MS ?? env.BROWSER_DEFAULT_TIMEOUT_MS,
    CONFIG_LIMITS.timeoutMs.default,
    CONFIG_LIMITS.timeoutMs.min,
    CONFIG_LIMITS.timeoutMs.max,
    'BROWSER_TIMEOUT_MS',
  );
  const sessionTtlMs = parseBoundedInteger(
    env.BROWSER_SESSION_TTL_MS,
    policy.limits.sessionTtlMs,
    CONFIG_LIMITS.sessionTtlMs.min,
    Math.min(CONFIG_LIMITS.sessionTtlMs.max, policy.limits.sessionTtlMs),
    'BROWSER_SESSION_TTL_MS',
  );
  const workspaceTtlMs = parseBoundedInteger(
    env.BROWSER_WORKSPACE_TTL_MS,
    policy.limits.workspaceTtlMs,
    CONFIG_LIMITS.workspaceTtlMs.min,
    Math.min(CONFIG_LIMITS.workspaceTtlMs.max, policy.limits.workspaceTtlMs),
    'BROWSER_WORKSPACE_TTL_MS',
  );
  const mcpRatePerSecond = parseBoundedInteger(
    env.MCP_RATE_PER_SECOND,
    CONFIG_LIMITS.mcpRatePerSecond.default,
    CONFIG_LIMITS.mcpRatePerSecond.min,
    CONFIG_LIMITS.mcpRatePerSecond.max,
    'MCP_RATE_PER_SECOND',
  );
  const mcpBurst = parseBoundedInteger(
    env.MCP_BURST,
    CONFIG_LIMITS.mcpBurst.default,
    CONFIG_LIMITS.mcpBurst.min,
    CONFIG_LIMITS.mcpBurst.max,
    'MCP_BURST',
  );

  const dataDir = parseServerPath(
    env.BROWSER_DATA_DIR,
    resolve(process.cwd(), '.browser-data'),
    'BROWSER_DATA_DIR',
  );
  const persistentProfiles = parseBoolean(env.BROWSER_PERSIST_PROFILES, 'BROWSER_PERSIST_PROFILES');
  const auditPath = parseServerPath(
    env.BROWSER_AUDIT_PATH,
    join(dataDir, 'audit.jsonl'),
    'BROWSER_AUDIT_PATH',
  );

  return Object.freeze({
    allowedHosts,
    resourceHosts,
    allowHttp,
    allowPrivateNetwork,
    allowSyntheticTunnel,
    maxSessions,
    timeoutMs,
    automationPolicy,
    sessionTtlMs,
    workspaceTtlMs,
    mcpRatePerSecond,
    mcpBurst,
    dataDir,
    persistentProfiles,
    auditPath,
  });
}

function normalizeHost(raw: string): string {
  const value = raw.trim();
  if (!value || value.includes('/') || value.includes('?') || value.includes('#')) {
    throw configError('BROWSER_ALLOWED_HOSTS', 'host rules must contain a hostname only');
  }
  if (value.includes(':') && !IPV6_BRACKET.test(value) && !isIPv4(value)) {
    // A colon in a non-bracketed rule is either an IPv6 literal (which we
    // accept below) or an accidental port. `isIPv6` distinguishes those.
    if (!isIPv6(value)) {
      throw configError('BROWSER_ALLOWED_HOSTS', 'ports are not allowed in host rules');
    }
  }

  const bracketed = value.match(IPV6_BRACKET);
  if (bracketed) {
    const address = bracketed[1];
    if (!address || !isIPv6(address)) {
      throw configError('BROWSER_ALLOWED_HOSTS', 'invalid IPv6 host rule');
    }
    return canonicalIpv6(address);
  }
  if (isIPv6(value)) return canonicalIpv6(value);
  if (isIPv4(value)) return value;

  // domainToASCII rejects URL-like values while preserving DNS label
  // boundaries. A trailing dot is equivalent to the absolute DNS name.
  const ascii = domainToASCII(value).toLowerCase().replace(/\.$/, '');
  if (!ascii || ascii.length > 253 || ascii.includes('..')) {
    throw configError('BROWSER_ALLOWED_HOSTS', 'invalid hostname');
  }
  const labels = ascii.split('.');
  if (labels.some((label) => label.length === 0 || label.length > 63 || !HOST_LABEL.test(label))) {
    throw configError('BROWSER_ALLOWED_HOSTS', 'invalid hostname label');
  }
  return ascii;
}

function canonicalIpv6(address: string): string {
  // WHATWG URL parsing gives us stable lower-case compressed notation. The
  // input has already passed net.isIPv6, so the parser cannot throw here.
  const parsed = new URL(`http://[${address}]`);
  return parsed.hostname.toLowerCase();
}

function isIpLiteralRule(value: string): boolean {
  if (value.startsWith('[') && value.endsWith(']')) return isIPv6(value.slice(1, -1));
  return isIPv4(value) === true || isIPv6(value) === true;
}

function parseBoolean(raw: string | undefined, field: string): boolean {
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw configError(field, 'expected true or false');
}

function parseBoundedInteger(
  raw: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
  field: string,
): number {
  if (raw === undefined) return defaultValue;
  const value = raw.trim();
  if (!/^\d+$/.test(value)) throw configError(field, 'expected an integer');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw configError(field, `must be between ${min} and ${max}`);
  }
  return parsed;
}

function parseServerPath(raw: string | undefined, fallback: string, field: string): string {
  if (raw !== undefined && !raw.trim()) throw configError(field, 'path cannot be empty');
  const value = (raw ?? fallback).trim();
  if (value.includes('\0')) throw configError(field, 'path contains an invalid character');
  if (value.length > CONFIG_LIMITS.maxPathLength) {
    throw configError(field, `path exceeds ${CONFIG_LIMITS.maxPathLength} characters`);
  }
  if (!isAbsolute(value)) throw configError(field, 'path must be absolute and server-configured');

  const normalized = normalize(value);
  if (normalized === parsePath(normalized).root) {
    throw configError(field, 'root directory is not an acceptable path');
  }
  return normalized;
}

function configError(field: string, reason: string): BrowserToolError {
  return new BrowserToolError('INVALID_INPUT', 'Invalid server configuration.', {
    details: { field, reason },
    retryable: false,
  });
}
