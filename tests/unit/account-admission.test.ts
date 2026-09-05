import { test, expect, describe, beforeEach } from 'vitest';
import { AccountAdmissionController } from '../../src/operations/account-admission.js';
import type { AdmissionRequest, Clock } from '../../src/operations/account-admission.js';

class MockClock implements Clock {
  public currentTime = 1000;
  now() { return this.currentTime; }
  advance(ms: number) { this.currentTime += ms; }
}

describe('AccountAdmissionController', () => {
  let clock: MockClock;
  let controller: AccountAdmissionController;

  const defaultLimits = {
    concurrency: {
      tenant: 2,
      account: 2,
      domain: 2,
      proxy: 2,
    },
    rateLimit: {
      burst: 2,
      ratePerSecond: 1,
    }
  };

  const createRequest = (overrides?: Partial<AdmissionRequest>): AdmissionRequest => ({
    tenantId: 't1',
    accountId: 'a1',
    domainKey: 'd1',
    proxyId: 'p1',
    ...overrides
  });

  beforeEach(() => {
    clock = new MockClock();
    controller = new AccountAdmissionController(clock, defaultLimits);
  });

  test('acquires permit when under limits', () => {
    const res = controller.acquire(createRequest());
    expect(res.allowed).toBe(true);
    if (res.allowed) {
      expect(res.permit.token).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/);
    }
  });

  test('enforces token-bucket rate limit', () => {
    // Burst is 2, so first two succeed, third fails
    expect(controller.acquire(createRequest()).allowed).toBe(true);
    expect(controller.acquire(createRequest({ accountId: 'a2', domainKey: 'd2', proxyId: 'p2' })).allowed).toBe(true);
    
    const res = controller.acquire(createRequest({ accountId: 'a3', domainKey: 'd3', proxyId: 'p3' }));
    expect(res.allowed).toBe(false);
    if (!res.allowed) {
      expect(res.reason).toBe('RATE_LIMIT_EXCEEDED');
      expect(res.retryAfterMs).toBeGreaterThan(0);
      expect(res.retryAfterMs).toBe(1000); // Need 1 token, rate is 1/sec
    }
  });

  test('token bucket refills correctly', () => {
    const refillController = new AccountAdmissionController(clock, {
      ...defaultLimits,
      concurrency: { tenant: 10, account: 10, domain: 10, proxy: 10 }
    });

    expect(refillController.acquire(createRequest()).allowed).toBe(true);
    expect(refillController.acquire(createRequest({ accountId: 'a2', domainKey: 'd2', proxyId: 'p2' })).allowed).toBe(true);
    expect(refillController.acquire(createRequest({ accountId: 'a3', domainKey: 'd3', proxyId: 'p3' })).allowed).toBe(false);

    // Advance 500ms -> 0.5 tokens. Still not enough.
    clock.advance(500);
    expect(refillController.acquire(createRequest({ accountId: 'a3', domainKey: 'd3', proxyId: 'p3' })).allowed).toBe(false);

    // Advance another 500ms -> 1.0 tokens total. Now we can acquire 1 more.
    clock.advance(500);
    expect(refillController.acquire(createRequest({ accountId: 'a3', domainKey: 'd3', proxyId: 'p3' })).allowed).toBe(true);
  });

  test('tenant isolation: rate limits are isolated per tenant', () => {
    // Exhaust tenant 1
    controller.acquire(createRequest({ tenantId: 't1', accountId: 'a1' }));
    controller.acquire(createRequest({ tenantId: 't1', accountId: 'a2' }));
    const res = controller.acquire(createRequest({ tenantId: 't1', accountId: 'a3' }));
    expect(res.allowed).toBe(false);
    if (!res.allowed) expect(res.reason).toBe('RATE_LIMIT_EXCEEDED');

    // Tenant 2 should still be allowed (using distinct properties to avoid other limits)
    expect(controller.acquire(createRequest({ tenantId: 't2', accountId: 'a3', domainKey: 'd3', proxyId: 'p3' })).allowed).toBe(true);
  });

  test('enforces concurrency limits per tenant, account, domain, and proxy', () => {
    // Set higher burst to avoid rate limits
    const highBurstController = new AccountAdmissionController(clock, {
      ...defaultLimits,
      rateLimit: { burst: 10, ratePerSecond: 10 }
    });

    // 1. Tenant limit
    highBurstController.acquire(createRequest({ tenantId: 't1', accountId: 'a1', domainKey: 'd1', proxyId: 'p1' }));
    highBurstController.acquire(createRequest({ tenantId: 't1', accountId: 'a2', domainKey: 'd2', proxyId: 'p2' }));
    let res = highBurstController.acquire(createRequest({ tenantId: 't1', accountId: 'a3', domainKey: 'd3', proxyId: 'p3' }));
    expect(res.allowed).toBe(false);
    if (!res.allowed) expect(res.reason).toBe('CONCURRENCY_LIMIT_TENANT');

    // 2. Account limit is tenant-scoped, so equal external IDs cannot create
    // cross-tenant contention.
    const accountController = new AccountAdmissionController(clock, {
      concurrency: { tenant: 10, account: 2, domain: 10, proxy: 10 },
      rateLimit: { burst: 10, ratePerSecond: 10 },
    });
    accountController.acquire(createRequest({ tenantId: 't2', accountId: 'a_shared', domainKey: 'd4', proxyId: 'p4' }));
    accountController.acquire(createRequest({ tenantId: 't2', accountId: 'a_shared', domainKey: 'd5', proxyId: 'p5' }));
    res = accountController.acquire(createRequest({ tenantId: 't2', accountId: 'a_shared', domainKey: 'd6', proxyId: 'p6' }));
    expect(res.allowed).toBe(false);
    if (!res.allowed) expect(res.reason).toBe('CONCURRENCY_LIMIT_ACCOUNT');

    // 3. Domain limit
    highBurstController.acquire(createRequest({ tenantId: 't4', accountId: 'a4', domainKey: 'd_shared', proxyId: 'p7' }));
    highBurstController.acquire(createRequest({ tenantId: 't5', accountId: 'a5', domainKey: 'd_shared', proxyId: 'p8' }));
    res = highBurstController.acquire(createRequest({ tenantId: 't6', accountId: 'a6', domainKey: 'd_shared', proxyId: 'p9' }));
    expect(res.allowed).toBe(false);
    if (!res.allowed) expect(res.reason).toBe('CONCURRENCY_LIMIT_DOMAIN');

    // 4. Proxy limit
    highBurstController.acquire(createRequest({ tenantId: 't6', accountId: 'a6', domainKey: 'd6', proxyId: 'p_shared' }));
    highBurstController.acquire(createRequest({ tenantId: 't7', accountId: 'a7', domainKey: 'd7', proxyId: 'p_shared' }));
    res = highBurstController.acquire(createRequest({ tenantId: 't8', accountId: 'a8', domainKey: 'd8', proxyId: 'p_shared' }));
    expect(res.allowed).toBe(false);
    if (!res.allowed) expect(res.reason).toBe('CONCURRENCY_LIMIT_PROXY');
  });

  test('precedence: rate limit fails before concurrency check', () => {
    // Fill up tenant concurrency
    const res1 = controller.acquire(createRequest({ accountId: 'a1', domainKey: 'd1', proxyId: 'p1' }));
    const res2 = controller.acquire(createRequest({ accountId: 'a2', domainKey: 'd2', proxyId: 'p2' }));
    expect(res1.allowed).toBe(true);
    expect(res2.allowed).toBe(true);

    // Now both Rate Limit AND Concurrency are exhausted. Rate Limit should take precedence.
    const res3 = controller.acquire(createRequest({ accountId: 'a3', domainKey: 'd3', proxyId: 'p3' }));
    expect(res3.allowed).toBe(false);
    if (!res3.allowed) expect(res3.reason).toBe('RATE_LIMIT_EXCEEDED');
  });

  test('idempotent release: stale/double release does not double-decrement', () => {
    const res = controller.acquire(createRequest());
    expect(res.allowed).toBe(true);
    if (!res.allowed) return;

    controller.release(res.permit);
    // Releasing again shouldn't crash or make metrics negative
    controller.release(res.permit);
    controller.release({ token: 'invalid_token' });

    const metrics = controller.getMetrics();
    expect(metrics.activeTenants).toBe(0);
    expect(metrics.activeAccounts).toBe(0);
    expect(metrics.activeDomains).toBe(0);
    expect(metrics.activeProxies).toBe(0);
    expect(metrics.activePermits).toBe(0);
  });

  test('bounded cleanup: no counter leaks after all permits released', () => {
    const r1 = controller.acquire(createRequest({ accountId: 'a1', domainKey: 'd1', proxyId: 'p1' }));
    const r2 = controller.acquire(createRequest({ accountId: 'a2', domainKey: 'd2', proxyId: 'p2' }));
    
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);

    if (r1.allowed && r2.allowed) {
      controller.release(r1.permit);
      controller.release(r2.permit);
    }

    const metrics = controller.getMetrics();
    expect(metrics.activeTenants).toBe(0);
    expect(metrics.activeAccounts).toBe(0);
    expect(metrics.activeDomains).toBe(0);
    expect(metrics.activeProxies).toBe(0);
    expect(metrics.activePermits).toBe(0);
    
    // Note: tenantBuckets remain for rate limit tracking until evicted
    expect(metrics.tenantBuckets).toBeGreaterThan(0);
  });

  test('bounded cleanup: tenant buckets are evicted when exceeding max', () => {
    // Controller with a tiny maxBuckets limit (2)
    const smallController = new AccountAdmissionController(clock, defaultLimits, 2);

    smallController.acquire(createRequest({ tenantId: 't1' }));
    smallController.acquire(createRequest({ tenantId: 't2' }));
    expect(smallController.getMetrics().tenantBuckets).toBe(2);

    // Acquiring for a 3rd tenant should evict the oldest bucket ('t1')
    smallController.acquire(createRequest({ tenantId: 't3' }));
    expect(smallController.getMetrics().tenantBuckets).toBe(2);
  });
});
