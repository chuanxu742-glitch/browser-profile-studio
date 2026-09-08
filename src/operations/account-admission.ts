import { randomUUID } from 'node:crypto';

export interface Clock {
  now(): number;
}

export interface AdmissionLimits {
  concurrency: {
    tenant: number;
    account: number;
    domain: number;
    proxy: number;
  };
  rateLimit: {
    burst: number;
    ratePerSecond: number;
  };
}

export interface AdmissionRequest {
  tenantId: string;
  accountId: string;
  domainKey: string;
  proxyId: string;
}

export interface Permit {
  token: string;
}

export type AdmissionReason =
  | 'RATE_LIMIT_EXCEEDED'
  | 'CONCURRENCY_LIMIT_TENANT'
  | 'CONCURRENCY_LIMIT_ACCOUNT'
  | 'CONCURRENCY_LIMIT_DOMAIN'
  | 'CONCURRENCY_LIMIT_PROXY'
  | 'BUCKET_CAPACITY_EXHAUSTED';

export type AdmissionResult =
  | { allowed: true; permit: Permit }
  | { allowed: false; reason: AdmissionReason; retryAfterMs: number };

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

export class AccountAdmissionController {
  private readonly activeTenants = new Map<string, number>();
  private readonly activeAccounts = new Map<string, number>();
  private readonly activeDomains = new Map<string, number>();
  private readonly activeProxies = new Map<string, number>();
  private readonly tenantBuckets = new Map<string, TokenBucket>();
  private readonly activePermits = new Map<string, AdmissionRequest>();

  constructor(
    private readonly clock: Clock,
    private readonly limits: AdmissionLimits,
    private readonly maxBuckets = 10_000,
  ) {
    for (const value of Object.values(limits.concurrency)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('Concurrency limits must be positive integers');
    }
    if (!Number.isFinite(limits.rateLimit.burst) || limits.rateLimit.burst < 1
      || !Number.isFinite(limits.rateLimit.ratePerSecond) || limits.rateLimit.ratePerSecond <= 0) {
      throw new Error('Rate limits must be positive and finite');
    }
    if (!Number.isSafeInteger(maxBuckets) || maxBuckets < 1 || maxBuckets > 1_000_000) {
      throw new Error('maxBuckets must be an integer between 1 and 1000000');
    }
  }

  acquire(request: AdmissionRequest): AdmissionResult {
    const req = this.validateRequest(request);
    const now = this.clock.now();
    if (!Number.isFinite(now) || now < 0) throw new Error('Admission clock returned an invalid timestamp');

    let bucket = this.tenantBuckets.get(req.tenantId);
    if (!bucket && this.tenantBuckets.size >= this.maxBuckets) {
      for (const tenantId of this.tenantBuckets.keys()) {
        if (!this.activeTenants.has(tenantId)) {
          this.tenantBuckets.delete(tenantId);
          break;
        }
      }
      if (this.tenantBuckets.size >= this.maxBuckets) {
        return { allowed: false, reason: 'BUCKET_CAPACITY_EXHAUSTED', retryAfterMs: 1_000 };
      }
    }

    bucket ??= { tokens: this.limits.rateLimit.burst, lastRefill: now };
    const elapsedMs = Math.max(0, now - bucket.lastRefill);
    const refillRatePerMs = this.limits.rateLimit.ratePerSecond / 1_000;
    const currentTokens = Math.min(this.limits.rateLimit.burst, bucket.tokens + elapsedMs * refillRatePerMs);
    this.tenantBuckets.set(req.tenantId, { tokens: currentTokens, lastRefill: now });
    if (currentTokens < 1) {
      return {
        allowed: false,
        reason: 'RATE_LIMIT_EXCEEDED',
        retryAfterMs: Math.ceil((1 - currentTokens) / refillRatePerMs),
      };
    }

    const accountKey = JSON.stringify([req.tenantId, req.accountId]);
    const domainKey = req.domainKey;
    const proxyKey = req.proxyId;
    if ((this.activeTenants.get(req.tenantId) ?? 0) >= this.limits.concurrency.tenant) {
      return { allowed: false, reason: 'CONCURRENCY_LIMIT_TENANT', retryAfterMs: 1_000 };
    }
    if ((this.activeAccounts.get(accountKey) ?? 0) >= this.limits.concurrency.account) {
      return { allowed: false, reason: 'CONCURRENCY_LIMIT_ACCOUNT', retryAfterMs: 1_000 };
    }
    if ((this.activeDomains.get(domainKey) ?? 0) >= this.limits.concurrency.domain) {
      return { allowed: false, reason: 'CONCURRENCY_LIMIT_DOMAIN', retryAfterMs: 1_000 };
    }
    if ((this.activeProxies.get(proxyKey) ?? 0) >= this.limits.concurrency.proxy) {
      return { allowed: false, reason: 'CONCURRENCY_LIMIT_PROXY', retryAfterMs: 1_000 };
    }

    this.tenantBuckets.set(req.tenantId, { tokens: currentTokens - 1, lastRefill: now });
    this.activeTenants.set(req.tenantId, (this.activeTenants.get(req.tenantId) ?? 0) + 1);
    this.activeAccounts.set(accountKey, (this.activeAccounts.get(accountKey) ?? 0) + 1);
    this.activeDomains.set(domainKey, (this.activeDomains.get(domainKey) ?? 0) + 1);
    this.activeProxies.set(proxyKey, (this.activeProxies.get(proxyKey) ?? 0) + 1);

    const token = randomUUID();
    this.activePermits.set(token, req);
    return { allowed: true, permit: { token } };
  }

  release(permit: Permit): void {
    const req = this.activePermits.get(permit.token);
    if (!req) return;
    this.activePermits.delete(permit.token);
    this.decrement(this.activeTenants, req.tenantId);
    this.decrement(this.activeAccounts, JSON.stringify([req.tenantId, req.accountId]));
    this.decrement(this.activeDomains, req.domainKey);
    this.decrement(this.activeProxies, req.proxyId);
  }

  getMetrics(): Readonly<Record<'activeTenants' | 'activeAccounts' | 'activeDomains' | 'activeProxies' | 'activePermits' | 'tenantBuckets', number>> {
    return {
      activeTenants: this.activeTenants.size,
      activeAccounts: this.activeAccounts.size,
      activeDomains: this.activeDomains.size,
      activeProxies: this.activeProxies.size,
      activePermits: this.activePermits.size,
      tenantBuckets: this.tenantBuckets.size,
    };
  }

  private validateRequest(request: AdmissionRequest): AdmissionRequest {
    const values = [request.tenantId, request.accountId, request.domainKey, request.proxyId];
    if (values.some((value) => typeof value !== 'string' || value.trim().length === 0 || value.length > 256)) {
      throw new Error('Admission dimensions must be nonempty strings of at most 256 characters');
    }
    return { ...request };
  }

  private decrement(map: Map<string, number>, key: string): void {
    const current = map.get(key) ?? 0;
    if (current <= 1) map.delete(key);
    else map.set(key, current - 1);
  }
}
