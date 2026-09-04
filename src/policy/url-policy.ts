import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

import type { AppConfig } from '../config.js';
import { normalizeHostPattern } from '../config.js';
import { BrowserToolError } from '../domain.js';

export type UrlPurpose = 'navigation' | 'resource';
export type UrlPurposeInput = UrlPurpose | { readonly resource?: boolean };

export interface ResolvedAddress {
  address: string;
}

/**
 * A policy-approved URL together with the exact addresses that may be used
 * for its next connection.  HTTP clients must use these addresses directly
 * instead of resolving the hostname again at connect time.
 */
export interface ResolvedDestination {
  url: URL;
  addresses: readonly string[];
}

/** Resolver injection keeps policy tests deterministic and avoids real DNS. */
export type DnsResolver =
  | ((hostname: string) => Promise<readonly (string | ResolvedAddress)[]> | readonly (string | ResolvedAddress)[])
  | {
      resolve?: (hostname: string) => Promise<readonly (string | ResolvedAddress)[]> | readonly (string | ResolvedAddress)[];
      lookup?: (hostname: string) => Promise<readonly (string | ResolvedAddress)[]> | readonly (string | ResolvedAddress)[];
      resolve4?: (hostname: string) => Promise<readonly string[]> | readonly string[];
      resolve6?: (hostname: string) => Promise<readonly string[]> | readonly string[];
    };

export interface UrlPolicyOptions {
  readonly allowedHosts: readonly string[];
  readonly resourceHosts?: readonly string[];
  readonly allowHttp?: boolean;
  readonly allowPrivateNetwork?: boolean;
  /** Permit only the 198.18.0.0/15 synthetic tunnel range. */
  readonly allowSyntheticTunnel?: boolean;
  readonly resolver?: DnsResolver;
  /** Alias accepted for integrations that name the dependency explicitly. */
  readonly dnsResolver?: DnsResolver;
  /** Additional descriptive alias for dependency injection. */
  readonly resolveHostname?: DnsResolver;
}

export interface AddressClassification {
  blocked: boolean;
  reason:
    | 'loopback'
    | 'private'
    | 'link-local'
    | 'multicast'
    | 'reserved'
    | 'metadata'
    | undefined;
  version: 4 | 6;
  address: string;
}

const MAX_URL_LENGTH = 2_048;
const HOSTNAME_BLOCKLIST = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
]);
const METADATA_HOSTNAMES = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.google',
  'instance-data.ec2.internal',
  'metadata.azure.internal',
]);
const METADATA_IPV6 = new Set(['fd00:ec2::254', 'fe80::a9fe:a9fe']);
const METADATA_IPV4 = new Set([
  '169.254.169.254', // AWS, Azure, Google Cloud, Oracle and others
  '169.254.170.2',   // AWS ECS task credentials
  '169.254.170.23',  // AWS EKS pod identity
  '100.100.100.200', // Alibaba Cloud
  '168.63.129.16',   // Azure platform virtual IP
]);

/**
 * URL and destination policy for both top-level navigation and resources.
 * Browser navigation/resource callers use `assertAllowed`; the HTTP fetcher
 * uses `resolveAllowed` so the approved DNS answers can be pinned to the
 * connection instead of being resolved again by the socket layer.
 */
export class UrlPolicy {
  readonly allowedHosts: readonly string[];
  readonly resourceHosts: readonly string[];
  readonly allowHttp: boolean;
  readonly allowPrivateNetwork: boolean;
  readonly allowSyntheticTunnel: boolean;

  private readonly resolver?: DnsResolver;
  private readonly safeDnsCache = new Map<string, { addresses: readonly string[]; expiresAt: number }>();

  public clearDnsCache(): void {
    this.safeDnsCache.clear();
  }

  constructor(
    options: UrlPolicyOptions | Pick<AppConfig, 'allowedHosts' | 'resourceHosts' | 'allowHttp' | 'allowPrivateNetwork' | 'allowSyntheticTunnel'>,
    resolver?: DnsResolver,
  ) {
    this.allowedHosts = Object.freeze(options.allowedHosts.map((host) => normalizeHostPattern(host)));
    this.resourceHosts = Object.freeze(
      (options.resourceHosts && options.resourceHosts.length > 0
        ? options.resourceHosts
        : this.allowedHosts
      ).map((host) => normalizeHostPattern(host)),
    );
    this.allowHttp = options.allowHttp ?? false;
    this.allowPrivateNetwork = options.allowPrivateNetwork ?? false;
    if (resolver !== undefined) this.resolver = resolver;
    if ('resolver' in options && options.resolver !== undefined) this.resolver = options.resolver;
    if ('dnsResolver' in options && options.dnsResolver !== undefined) this.resolver = options.dnsResolver;
    this.allowSyntheticTunnel = options.allowSyntheticTunnel ?? false;
    if ('resolveHostname' in options && options.resolveHostname !== undefined) this.resolver = options.resolveHostname;
  }

  /**
   * Assert that `rawUrl` is a permitted destination and return its parsed URL.
   * Query strings and fragments are intentionally never copied into any error.
   */
  async assertAllowed(rawUrl: string, purpose: UrlPurposeInput = 'navigation'): Promise<URL> {
    return (await this.resolveAllowed(rawUrl, purpose)).url;
  }

  /**
   * Validate a URL and return the DNS answers that are safe to use for the
   * immediately following connection.  All answers are checked before any
   * one is returned so a mixed public/private response fails closed.
   */
  async resolveAllowed(rawUrl: string, purpose: UrlPurposeInput = 'navigation'): Promise<ResolvedDestination> {
    let effectivePurpose: UrlPurpose;
    if (typeof purpose === 'string') {
      if (purpose !== 'navigation' && purpose !== 'resource') {
        throw policyError('INVALID_INPUT', 'invalid-purpose', 'navigation');
      }
      effectivePurpose = purpose;
    } else if (
      purpose !== null &&
      typeof purpose === 'object' &&
      (!('resource' in purpose) || typeof purpose.resource === 'boolean')
    ) {
      effectivePurpose = purpose.resource === true ? 'resource' : 'navigation';
    } else {
      throw policyError('INVALID_INPUT', 'invalid-purpose', 'navigation');
    }
    if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > MAX_URL_LENGTH) {
      throw policyError('NAVIGATION_BLOCKED', 'invalid-url', effectivePurpose);
    }
    if (rawUrl.trim() !== rawUrl || /[\u0000-\u001f\u007f]/.test(rawUrl)) {
      throw policyError('NAVIGATION_BLOCKED', 'invalid-url', effectivePurpose);
    }

    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw policyError('NAVIGATION_BLOCKED', 'invalid-url', effectivePurpose);
    }

    const protocol = url.protocol.toLowerCase();
    if (protocol !== 'https:' && !(protocol === 'http:' && this.allowHttp)) {
      throw policyError('NAVIGATION_BLOCKED', 'scheme-not-allowed', effectivePurpose);
    }
    if (url.username || url.password) {
      throw policyError('NAVIGATION_BLOCKED', 'userinfo-not-allowed', effectivePurpose);
    }

    const host = canonicalUrlHost(url.hostname);
    if (!host) throw policyError('NAVIGATION_BLOCKED', 'missing-host', effectivePurpose);

    const patterns = effectivePurpose === 'navigation' ? this.allowedHosts : this.resourceHosts;
    if (!matchesHost(host, patterns)) {
      throw new BrowserToolError(
        'DOMAIN_NOT_ALLOWED',
        effectivePurpose === 'navigation'
          ? 'Navigation host is not approved.'
          : 'Resource host is not approved.',
        { details: { purpose: effectivePurpose, host }, retryable: false },
      );
    }

    const literalAddress = unbracket(host);
    if (isIP(literalAddress) !== 0) {
      const classification = classifyAddress(literalAddress);
      if (classification.blocked && !this.isPrivateException(classification)) {
        throw privateNetworkError(classification.reason ?? 'reserved', effectivePurpose, host);
      }
      return { url, addresses: Object.freeze([literalAddress]) };
    }

    const hostReason = classifyHostname(host);
    if (hostReason !== undefined && (hostReason === 'metadata' || !this.allowPrivateNetwork)) {
      throw privateNetworkError(hostReason, effectivePurpose, host);
    }

    const now = Date.now();
    if (this.resolver === undefined) {
      const cached = this.safeDnsCache.get(host);
      if (cached && cached.expiresAt > now) {
        return { url, addresses: cached.addresses };
      }
    }

    let addresses: readonly (string | ResolvedAddress)[];
    try {
      addresses = await this.resolve(host);
    } catch {
      throw new BrowserToolError('NETWORK_BLOCKED', 'DNS resolution was blocked or failed.', {
        details: { purpose: effectivePurpose, host, reason: 'dns-resolution-failed' },
        retryable: false,
      });
    }
    if (!Array.isArray(addresses)) {
      throw new BrowserToolError('NETWORK_BLOCKED', 'DNS returned an invalid address list.', {
        details: { purpose: effectivePurpose, host, reason: 'dns-invalid-address-list' },
        retryable: false,
      });
    }
    if (addresses.length === 0) {
      throw new BrowserToolError('NETWORK_BLOCKED', 'DNS resolution returned no address.', {
        details: { purpose: effectivePurpose, host, reason: 'dns-resolution-empty' },
        retryable: false,
      });
    }

    // Fail closed if any answer is malformed or protected. A resolver can
    // return multiple addresses; allowing the public one would leave a
    // protected answer available for a rebinding race.
    const approvedAddresses: string[] = [];
    for (const entry of addresses) {
      const address = typeof entry === 'string' ? entry : entry.address;
      if (typeof address !== 'string' || isIP(unbracket(address)) === 0) {
        throw new BrowserToolError('NETWORK_BLOCKED', 'DNS returned an invalid address.', {
          details: { purpose: effectivePurpose, host, reason: 'dns-invalid-address' },
          retryable: false,
        });
      }
      const classification = classifyAddress(unbracket(address));
      if (classification.blocked && !this.isPrivateException(classification)) {
        throw privateNetworkError(classification.reason ?? 'reserved', effectivePurpose, host);
      }
      approvedAddresses.push(canonicalAddress(unbracket(address)));
    }

    const frozenAddresses = Object.freeze(approvedAddresses);
    if (this.resolver === undefined) {
      if (this.safeDnsCache.size >= 500) {
        const oldestKey = this.safeDnsCache.keys().next().value;
        if (oldestKey !== undefined) this.safeDnsCache.delete(oldestKey);
      }
      this.safeDnsCache.set(host, { addresses: frozenAddresses, expiresAt: now + 30_000 });
    }

    return { url, addresses: frozenAddresses };
  }

  private isPrivateException(classification: AddressClassification): boolean {
    // Synthetic tunnel DNS is opt-in and only covers RFC 2544's 198.18/15.
    if (this.allowSyntheticTunnel && isSyntheticTunnelAddress(classification.address)) {
      return classification.reason === 'reserved';
    }
    // Cloud metadata is always denied. The broader test switch can permit
    // loopback/RFC1918/link-local/etc. for a local fixture, but never metadata.
    return this.allowPrivateNetwork && classification.reason !== 'metadata';
  }

  private async resolve(hostname: string): Promise<readonly (string | ResolvedAddress)[]> {
    if (this.resolver !== undefined) {
      if (typeof this.resolver === 'function') return await this.resolver(hostname);
      if (this.resolver.lookup !== undefined) return await this.resolver.lookup(hostname);
      if (this.resolver.resolve !== undefined) return await this.resolver.resolve(hostname);

      const answers: string[] = [];
      if (this.resolver.resolve4 !== undefined) {
        answers.push(...(await this.resolver.resolve4(hostname)));
      }
      if (this.resolver.resolve6 !== undefined) {
        answers.push(...(await this.resolver.resolve6(hostname)));
      }
      return answers;
    }

    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    return records.map((record) => record.address);
  }
}

interface CompiledHostPattern {
  exact: Set<string>;
  wildcards: Array<{ suffix: string; suffixLabelCount: number }>;
}

const compiledPatternsCache = new WeakMap<readonly string[], CompiledHostPattern>();

function getCompiledHostPatterns(patterns: readonly string[]): CompiledHostPattern {
  let compiled = compiledPatternsCache.get(patterns);
  if (!compiled) {
    const exact = new Set<string>();
    const wildcards: Array<{ suffix: string; suffixLabelCount: number }> = [];
    for (const pattern of patterns) {
      const normalized = normalizeHostPattern(pattern);
      if (normalized.startsWith('*.')) {
        const suffix = normalized.slice(2);
        wildcards.push({ suffix, suffixLabelCount: suffix.split('.').length });
      } else {
        exact.add(normalized);
      }
    }
    compiled = { exact, wildcards };
    compiledPatternsCache.set(patterns, compiled);
  }
  return compiled;
}

export function matchesHost(host: string, patterns: readonly string[]): boolean {
  const candidate = canonicalUrlHost(host);
  if (!candidate) return false;
  const { exact, wildcards } = getCompiledHostPatterns(patterns);
  if (exact.has(candidate)) return true;
  const candidateLabels = candidate.split('.').length;
  for (const { suffix, suffixLabelCount } of wildcards) {
    if (
      candidate !== suffix &&
      candidate.endsWith(`.${suffix}`) &&
      candidateLabels === suffixLabelCount + 1
    ) {
      return true;
    }
  }
  return false;
}

/** Classify an IP literal without making a network call. */
export function classifyAddress(address: string): AddressClassification {
  const value = unbracket(address).toLowerCase();
  const version = isIP(value);
  if (version === 4) return classifyIpv4(value);
  if (version === 6) {
    const groups = parseIpv6(value);
    const mapped = isIpv4Mapped(groups);
    if (mapped !== undefined) {
      const mappedResult = classifyIpv4(mapped);
      return {
        ...mappedResult,
        version: 6,
        address: value,
      };
    }

    let reason: AddressClassification['reason'];
    if (METADATA_IPV6.has(canonicalIpv6(value))) reason = 'metadata';
    else if (groups.every((group) => group === 0)) reason = 'reserved';
    else if (groups.every((group, index) => index === 7 ? group === 1 : group === 0)) reason = 'loopback';
    else if (hasIpv6Prefix(groups, [0xfc00], 7)) reason = 'private';
    else if (hasIpv6Prefix(groups, [0xfe80], 10)) reason = 'link-local';
    else if (hasIpv6Prefix(groups, [0xff00], 8)) reason = 'multicast';
    else if (hasIpv6Prefix(groups, [0x2001, 0x0db8], 32)) reason = 'reserved';
    else if (hasIpv6Prefix(groups, [0x2001, 0x0000], 32)) reason = 'reserved';
    else if (hasIpv6Prefix(groups, [0x2001, 0x0002, 0x0000], 48)) reason = 'reserved';
    else if (hasIpv6Prefix(groups, [0x0100, 0x0000], 32)) reason = 'reserved';
    else if (hasIpv6Prefix(groups, [0, 0, 0, 0, 0, 0], 96)) reason = 'reserved';

    return { blocked: reason !== undefined, reason, version: 6, address: value };
  }
  return { blocked: true, reason: 'reserved', version: 4, address: value };
}

function classifyIpv4(address: string): AddressClassification {
  const octets = address.split('.').map(Number) as [number, number, number, number];
  const [first, second, third, fourth] = octets;
  const value = (((first * 256 + second) * 256 + third) * 256 + fourth) >>> 0;
  let reason: AddressClassification['reason'];

  if (METADATA_IPV4.has(address)) reason = 'metadata';
  else if (first === 127) reason = 'loopback';
  else if (first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)) reason = 'private';
  else if (first === 169 && second === 254) reason = 'link-local';
  else if (first >= 224) reason = first >= 240 ? 'reserved' : 'multicast';
  else if (first === 0) reason = 'reserved';
  else if (first === 100 && second >= 64 && second <= 127) reason = 'reserved';
  else if (first === 192 && second === 0 && third === 0) reason = 'reserved';
  else if (first === 192 && second === 0 && third === 2) reason = 'reserved';
  else if (first === 192 && second === 88 && third === 99) reason = 'reserved';
  else if (first === 198 && second >= 18 && second <= 19) reason = 'reserved';
  else if (first === 198 && second === 51 && third === 100) reason = 'reserved';
  else if (first === 203 && second === 0 && third === 113) reason = 'reserved';
  else if (value === 0xffffffff) reason = 'reserved';

  return { blocked: reason !== undefined, reason, version: 4, address };
}
function isSyntheticTunnelAddress(address: string): boolean {
  const value = unbracket(address);
  if (isIP(value) !== 4) return false;
  const parts = value.split('.');
  const first = Number(parts[0]);
  const second = Number(parts[1]);
  return first === 198 && second >= 18 && second <= 19;
}

function canonicalUrlHost(rawHost: string): string {
  const host = unbracket(rawHost).toLowerCase().replace(/\.$/, '');
  if (!host) return '';
  if (isIP(host) === 6) return `[${canonicalIpv6(host)}]`;
  if (isIP(host) === 4) return host;
  const ascii = domainToASCII(host).toLowerCase().replace(/\.$/, '');
  return ascii;
}

function canonicalIpv6(address: string): string {
  // URL's parser performs RFC 5952-style compression and lower-casing.
  return new URL(`http://[${address}]`).hostname.slice(1, -1).toLowerCase();
}

function canonicalAddress(address: string): string {
  return isIP(address) === 6 ? canonicalIpv6(address) : address;
}

function unbracket(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

function classifyHostname(host: string): AddressClassification['reason'] | undefined {
  const normalized = unbracket(host).toLowerCase().replace(/\.$/, '');
  if (
    METADATA_HOSTNAMES.has(normalized) ||
    normalized.endsWith('.metadata.google.internal') ||
    normalized.endsWith('.instance-data.ec2.internal') ||
    normalized.endsWith('.metadata.azure.internal')
  ) {
    return 'metadata';
  }
  if (HOSTNAME_BLOCKLIST.has(normalized) || normalized.endsWith('.localhost')) return 'loopback';
  return undefined;
}

function parseIpv6(address: string): readonly number[] {
  let value = unbracket(address).toLowerCase();
  if (value.includes('.')) {
    const separator = value.lastIndexOf(':');
    if (separator < 0) throw new Error('invalid IPv6');
    const ipv4 = value.slice(separator + 1);
    if (isIP(ipv4) !== 4) throw new Error('invalid embedded IPv4');
    const octets = ipv4.split('.').map(Number) as [number, number, number, number];
    const [first, second, third, fourth] = octets;
    const high = (first << 8) | second;
    const low = (third << 8) | fourth;
    value = `${value.slice(0, separator)}:${high.toString(16)}:${low.toString(16)}`;
  }

  const halves = value.split('::');
  if (halves.length > 2) throw new Error('invalid IPv6 compression');
  const firstHalf = halves[0] ?? '';
  const secondHalf = halves[1] ?? '';
  const left = firstHalf === '' ? [] : firstHalf.split(':').map(parseHextet);
  const right = halves.length === 2 && secondHalf !== '' ? secondHalf.split(':').map(parseHextet) : [];
  const missing = 8 - left.length - right.length;
  if (missing < (halves.length === 2 ? 1 : 0)) throw new Error('invalid IPv6 length');
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function parseHextet(value: string): number {
  if (!/^[0-9a-f]{1,4}$/i.test(value)) throw new Error('invalid IPv6 hextet');
  return Number.parseInt(value, 16);
}

function isIpv4Mapped(groups: readonly number[]): string | undefined {
  if (groups.length !== 8 || !groups.slice(0, 5).every((group) => group === 0) || groups[5] !== 0xffff) return undefined;
  const high = groups[6] ?? 0;
  const low = groups[7] ?? 0;
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function hasIpv6Prefix(groups: readonly number[], prefix: readonly number[], bits: number): boolean {
  let remaining = bits;
  for (let index = 0; remaining > 0; index += 1) {
    const take = Math.min(remaining, 16);
    const mask = take === 16 ? 0xffff : (0xffff << (16 - take)) & 0xffff;
    const expected = prefix[index] ?? 0;
    const group = groups[index] ?? -1;
    if ((group & mask) !== (expected & mask)) return false;
    remaining -= take;
  }
  return true;
}

function privateNetworkError(
  reason: NonNullable<AddressClassification['reason']>,
  purpose: UrlPurpose,
  host: string,
): BrowserToolError {
  return new BrowserToolError('PRIVATE_NETWORK_DENIED', 'The destination resolves to a protected network.', {
    details: { purpose, host, reason },
    retryable: false,
  });
}

function policyError(
  code: 'INVALID_INPUT' | 'NAVIGATION_BLOCKED',
  reason: string,
  purpose: UrlPurpose,
): BrowserToolError {
  return new BrowserToolError(code, code === 'INVALID_INPUT' ? 'Invalid URL policy input.' : 'The URL was blocked by policy.', {
    details: { purpose, reason },
    retryable: false,
  });
}
