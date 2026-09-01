import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import type {
  ClientRequest,
  IncomingHttpHeaders,
  IncomingMessage,
  RequestOptions,
} from 'node:http';

import type { FetchOptions, FetchResult } from './types.js';
import type { ResolvedDestination } from '../policy/url-policy.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

// Keep the fetch result useful for callers without forwarding credentials or
// other server-specific response metadata. In particular, do not expose
// Set-Cookie (or authentication headers) to MCP callers or distributed jobs.
const EXPOSED_RESPONSE_HEADERS = [
  'cache-control',
  'content-length',
  'content-type',
  'etag',
  'last-modified',
  'location',
] as const;

/** Fetch one approved page without a browser. */
export async function fetchPage(options: FetchOptions): Promise<FetchResult> {
  const start = Date.now();
  const method = options.method ?? 'GET';
  const timeoutMs = Math.max(500, Math.min(60_000, options.timeoutMs ?? 15_000));
  const maxRedirects = Math.max(0, Math.min(10, Math.floor(options.maxRedirects ?? DEFAULT_MAX_REDIRECTS)));
  const maxResponseBytes = Math.max(1_024, Math.min(16 * 1024 * 1024, Math.floor(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES)));

  if (!['GET', 'HEAD'].includes(method)) {
    throw new Error('HTTP fetch only supports GET and HEAD.');
  }
  const requestMethod = method as 'GET' | 'HEAD';

  const defaultHeaders: Record<string, string> = {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.8',
  };

  const controller = new AbortController();
  const abortFromCaller = (): void => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let currentUrl = options.url;
  let redirectCount = 0;
  let destination: ResolvedDestination | undefined;
  let response: IncomingMessage | undefined;

  try {
    while (true) {
      // UrlPolicy.resolveAllowed performs the DNS safety check and returns the
      // exact addresses permitted for this request. The native client below
      // feeds one of those addresses to Node's socket lookup hook, so the
      // connection never performs an independent hostname resolution.
      destination = await resolvePinnedDestination(options.urlPolicy, currentUrl);
      response = await requestPinned(destination, requestMethod, defaultHeaders, controller.signal);

      const status = response.statusCode ?? 0;
      const location = headerValue(response.headers, 'location');
      if (!(options.followRedirects ?? true) || !location || !REDIRECT_STATUSES.has(status)) break;
      if (redirectCount >= maxRedirects) {
        destroyResponse(response);
        throw new Error('HTTP redirect limit exceeded.');
      }

      let nextUrl: URL;
      try {
        nextUrl = new URL(location, destination.url);
      } catch {
        destroyResponse(response);
        throw new Error('HTTP redirect location is invalid.');
      }
      destroyResponse(response);
      currentUrl = nextUrl.toString();
      redirectCount += 1;
    }

    if (!destination || !response) throw new Error('HTTP request did not produce a response.');
    const status = response.statusCode ?? 0;
    if (!Number.isInteger(status) || status < 100 || status > 999) {
      destroyResponse(response);
      throw new Error('HTTP response status is invalid.');
    }
    const responseText = await readBoundedBody(response, maxResponseBytes, controller.signal);
    const responseHeaders: Record<string, string> = {};
    for (const key of EXPOSED_RESPONSE_HEADERS) {
      const value = headerValue(response.headers, key);
      if (value !== undefined) responseHeaders[key] = value;
    }

    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: response.statusMessage ?? '',
      url: destination.url.toString(),
      headers: responseHeaders,
      body: responseText,
      durationMs: Date.now() - start,
      redirectCount,
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
}

/**
 * Resolve and validate a destination without accepting an unsafe fallback to
 * global fetch. A policy that only exposes assertAllowed cannot provide the
 * address pinning required by this HTTP client, so it fails closed.
 */
async function resolvePinnedDestination(
  policy: FetchOptions['urlPolicy'],
  rawUrl: string,
): Promise<ResolvedDestination> {
  if (typeof policy.resolveAllowed !== 'function') {
    throw new Error('HTTP fetch requires a URL policy with DNS address pinning support.');
  }

  const destination = await policy.resolveAllowed(rawUrl, 'navigation');
  if (!destination || !(destination.url instanceof URL) || !Array.isArray(destination.addresses)) {
    throw new Error('HTTP URL policy returned an invalid pinned destination.');
  }
  if (destination.url.username || destination.url.password) {
    throw new Error('HTTP URL policy returned a destination with credentials.');
  }
  if (destination.url.protocol !== 'http:' && destination.url.protocol !== 'https:') {
    throw new Error('HTTP URL policy returned an unsupported destination scheme.');
  }

  const addresses = destination.addresses.map((address) => {
    if (typeof address !== 'string') throw new Error('HTTP URL policy returned an invalid pinned address.');
    const normalized = unbracket(address);
    if (isIP(normalized) === 0) throw new Error('HTTP URL policy returned an invalid pinned address.');
    return normalized;
  });
  if (addresses.length === 0) throw new Error('HTTP URL policy returned no pinned address.');
  return { url: destination.url, addresses: Object.freeze(addresses) };
}

/**
 * Issue one GET/HEAD request with the original hostname retained for Host and
 * TLS SNI while the socket lookup is pinned to a policy-approved address.
 */
function requestPinned(
  destination: ResolvedDestination,
  method: 'GET' | 'HEAD',
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  const url = destination.url;
  const targetHostname = unbracket(url.hostname);
  const approvedAddress = destination.addresses[0];
  if (!approvedAddress) return Promise.reject(new Error('HTTP URL policy returned no pinned address.'));
  const family = isIP(approvedAddress);
  if (family !== 4 && family !== 6) return Promise.reject(new Error('HTTP URL policy returned an invalid pinned address.'));

  const requestOptions: RequestOptions & { servername?: string } = {
    protocol: url.protocol,
    hostname: targetHostname,
    method,
    path: `${url.pathname || '/'}${url.search}`,
    headers: {
      ...headers,
      // Explicitly retain the approved URL host rather than allowing a
      // transport implementation to derive Host from the pinned IP.
      host: url.host,
    },
    // Do not reuse a connection that was established for a prior resolution.
    agent: false,
    signal,
    lookup: (_hostname, _lookupOptions, callback) => {
      callback(null, approvedAddress, family);
    },
  };
  if (url.port) requestOptions.port = Number(url.port);
  if (url.protocol === 'https:' && isIP(targetHostname) === 0) {
    // TLS certificate validation and SNI must use the approved hostname, not
    // the address selected for the TCP socket.
    requestOptions.servername = targetHostname;
  }

  // Both request functions accept the common RequestOptions shape. The cast
  // only bridges their overloaded TypeScript declarations; runtime selection
  // remains based solely on the already validated URL protocol.
  const requestFn = (url.protocol === 'https:' ? https.request : http.request) as typeof http.request;
  return new Promise<IncomingMessage>((resolve, reject) => {
    let request: ClientRequest;
    try {
      request = requestFn(requestOptions, (incoming) => { resolve(incoming); });
    } catch (error) {
      reject(error);
      return;
    }
    request.once('error', reject);
    request.end();
  });
}

async function readBoundedBody(response: IncomingMessage, maxBytes: number, signal?: AbortSignal): Promise<string> {
  const declaredLength = Number(headerValue(response.headers, 'content-length') ?? '');
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    destroyResponse(response);
    throw new Error('HTTP response exceeds the server response limit.');
  }

  const onAbort = (): void => { response.destroy(createAbortError()); };
  if (signal?.aborted) {
    destroyResponse(response);
    throw createAbortError();
  }
  signal?.addEventListener('abort', onAbort, { once: true });

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of response) {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Uint8Array;
      total += bytes.byteLength;
      if (total > maxBytes) {
        destroyResponse(response);
        throw new Error('HTTP response exceeds the server response limit.');
      }
      chunks.push(bytes);
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function headerValue(headers: IncomingHttpHeaders, key: string): string | undefined {
  const value = headers[key.toLowerCase()];
  if (Array.isArray(value)) return value.join(', ');
  return typeof value === 'string' ? value : undefined;
}

function destroyResponse(response: IncomingMessage): void {
  response.destroy();
}

function createAbortError(): Error {
  const error = new Error('HTTP request was aborted.');
  error.name = 'AbortError';
  return error;
}

function unbracket(address: string): string {
  return address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
}
