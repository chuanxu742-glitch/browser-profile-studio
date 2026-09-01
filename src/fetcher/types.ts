import type { ResolvedDestination } from '../policy/url-policy.js';

export interface FetchUrlPolicy {
  assertAllowed(url: string, purpose?: 'navigation' | 'resource' | { resource?: boolean }): Promise<unknown> | unknown;
  /**
   * Return the policy-approved DNS answers for the next connection. Fetchers
   * must use this method so the socket layer does not resolve the hostname a
   * second time and create a DNS-rebinding window.
   */
  resolveAllowed?(url: string, purpose?: 'navigation' | 'resource' | { resource?: boolean }): Promise<ResolvedDestination> | ResolvedDestination;
}

export interface FetchOptions {
  url: string;
  method?: 'GET' | 'POST' | 'HEAD' | 'PUT' | 'DELETE' | undefined;
  timeoutMs?: number | undefined;
  followRedirects?: boolean | undefined;
  maxRedirects?: number | undefined;
  maxResponseBytes?: number | undefined;
  /** Internal cancellation hook used by Worker shutdown. */
  signal?: AbortSignal | undefined;
  /** Server-owned policy; callers must not be allowed to replace it. */
  urlPolicy: FetchUrlPolicy;
}

export interface FetchResult {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  durationMs: number;
  redirectCount: number;
}
