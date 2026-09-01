import { URL } from 'node:url';
import type { ProxyConfig, ProxyType } from './types.js';
import { BrowserToolError } from '../domain.js';

const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:', 'socks4:', 'socks5:']);

export interface NormalizedProxy {
  readonly server: string;
  readonly type: ProxyType;
  readonly username?: string;
  readonly password?: string;
  readonly bypass?: string;
  readonly host: string;
  readonly port: number;
}

/**
 * Validates and normalizes a proxy configuration.
 * Accepts formats:
 * - Direct ProxyConfig object
 * - Server URL string like `socks5://user:pass@1.2.3.4:1080` or `http://1.2.3.4:8080`
 */
export function normalizeProxyConfig(raw: ProxyConfig | string): NormalizedProxy {
  let serverStr: string;
  let explicitUser: string | undefined;
  let explicitPass: string | undefined;
  let explicitBypass: string | undefined;
  let explicitType: ProxyType | undefined;

  if (typeof raw === 'string') {
    serverStr = raw.trim();
  } else if (typeof raw === 'object' && raw !== null) {
    serverStr = (raw.server || '').trim();
    explicitUser = raw.username?.trim();
    explicitPass = raw.password;
    explicitBypass = raw.bypass?.trim();
    explicitType = raw.type;
  } else {
    throw new BrowserToolError('INVALID_ARGUMENT', 'Proxy configuration must be an object or URL string.');
  }

  if (!serverStr) {
    throw new BrowserToolError('INVALID_ARGUMENT', 'Proxy server address cannot be empty.');
  }

  // If scheme is missing, prepend http:// or explicitType://
  if (!serverStr.includes('://')) {
    const scheme = explicitType ? `${explicitType}://` : 'http://';
    serverStr = `${scheme}${serverStr}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(serverStr);
  } catch (error) {
    throw new BrowserToolError('INVALID_ARGUMENT', `Invalid proxy server URL: ${serverStr}`);
  }

  if (!SUPPORTED_PROTOCOLS.has(parsed.protocol)) {
    throw new BrowserToolError(
      'INVALID_ARGUMENT',
      `Unsupported proxy protocol "${parsed.protocol}". Supported protocols: http, https, socks4, socks5.`,
    );
  }

  const protocolType = parsed.protocol.replace(':', '') as ProxyType;
  const type = explicitType || protocolType;

  const host = parsed.hostname;
  if (!host) {
    throw new BrowserToolError('INVALID_ARGUMENT', 'Proxy server host is missing.');
  }

  let port = parsed.port ? parseInt(parsed.port, 10) : 0;
  if (!port || isNaN(port) || port < 1 || port > 65535) {
    port = type.startsWith('socks') ? 1080 : 8080;
  }

  const username = explicitUser || (parsed.username ? decodeURIComponent(parsed.username) : undefined);
  const password = explicitPass !== undefined ? explicitPass : (parsed.password ? decodeURIComponent(parsed.password) : undefined);

  // Playwright expects server format: "protocol://host:port" without credentials in the URL
  const server = `${type}://${host}:${port}`;

  return Object.freeze({
    server,
    type,
    host,
    port,
    ...(username ? { username } : {}),
    ...(password !== undefined ? { password } : {}),
    ...(explicitBypass ? { bypass: explicitBypass } : {}),
  });
}
