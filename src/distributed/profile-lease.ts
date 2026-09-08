import { randomUUID } from 'node:crypto';
import { Cluster, Redis } from 'ioredis';

export interface ProfileLease {
  readonly profileId: string;
  readonly leaseToken: string;
  readonly expiresAt: number;
}

export interface LeaseManager {
  acquire(tenantId: string, profileId: string): Promise<ProfileLease>;
  renew(tenantId: string, profileId: string, leaseToken: string): Promise<ProfileLease>;
  release(tenantId: string, profileId: string, leaseToken: string): Promise<void>;
  shutdown(): Promise<void>;
}

interface MemoryLeaseRecord {
  token: string;
  expiresAt: number;
  timeout: NodeJS.Timeout;
}

const memoryLeases = new Map<string, MemoryLeaseRecord>();

export class MemoryLeaseManager implements LeaseManager {
  private readonly ownedLeases = new Map<string, string>();

  public constructor(private readonly ttlMs: number = 30_000) {}

  public async acquire(tenantId: string, profileId: string): Promise<ProfileLease> {
    const key = `${tenantId}:${profileId}`;
    const existing = memoryLeases.get(key);
    const now = Date.now();
    if (existing && existing.expiresAt > now) {
      throw new Error('LEASE_ALREADY_ACQUIRED');
    }
    if (existing) clearTimeout(existing.timeout);

    const leaseToken = randomUUID();
    const expiresAt = now + this.ttlMs;
    const timeout = setTimeout(() => {
      if (memoryLeases.get(key)?.token === leaseToken) memoryLeases.delete(key);
      if (this.ownedLeases.get(key) === leaseToken) this.ownedLeases.delete(key);
    }, this.ttlMs);
    timeout.unref();
    memoryLeases.set(key, { token: leaseToken, expiresAt, timeout });
    this.ownedLeases.set(key, leaseToken);
    return { profileId, leaseToken, expiresAt };
  }

  public async renew(tenantId: string, profileId: string, leaseToken: string): Promise<ProfileLease> {
    const key = `${tenantId}:${profileId}`;
    const existing = memoryLeases.get(key);
    const now = Date.now();
    if (!existing || existing.token !== leaseToken || existing.expiresAt <= now) {
      if (existing && existing.expiresAt <= now) {
        clearTimeout(existing.timeout);
        memoryLeases.delete(key);
      }
      if (!existing || existing.expiresAt <= now) this.ownedLeases.delete(key);
      throw new Error('LEASE_LOST');
    }

    clearTimeout(existing.timeout);
    const expiresAt = now + this.ttlMs;
    const timeout = setTimeout(() => {
      if (memoryLeases.get(key)?.token === leaseToken) memoryLeases.delete(key);
      if (this.ownedLeases.get(key) === leaseToken) this.ownedLeases.delete(key);
    }, this.ttlMs);
    timeout.unref();
    memoryLeases.set(key, { token: leaseToken, expiresAt, timeout });
    return { profileId, leaseToken, expiresAt };
  }

  public async release(tenantId: string, profileId: string, leaseToken: string): Promise<void> {
    const key = `${tenantId}:${profileId}`;
    const existing = memoryLeases.get(key);
    this.ownedLeases.delete(key);
    if (existing?.token !== leaseToken) return;
    clearTimeout(existing.timeout);
    memoryLeases.delete(key);
  }

  public async shutdown(): Promise<void> {
    for (const [key, token] of this.ownedLeases) {
      const existing = memoryLeases.get(key);
      if (existing?.token === token) {
        clearTimeout(existing.timeout);
        memoryLeases.delete(key);
      }
    }
    this.ownedLeases.clear();
  }
}

// Redis compare-and-delete prevents a stale owner from releasing a successor's lease.
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
else
    return 0
end
`;

const RENEW_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("pexpire", KEYS[1], ARGV[2])
else
    return 0
end
`;

export class RedisLeaseManager implements LeaseManager {
  private readonly redis: Redis | Cluster;
  private readonly ttlMs: number;

  public constructor(redis: Redis | Cluster, ttlMs: number = 30_000) {
    this.redis = redis;
    this.ttlMs = ttlMs;
  }

  private getKey(tenantId: string, profileId: string): string {
    return `browser:profile:lease:${tenantId}:${profileId}`;
  }

  public async acquire(tenantId: string, profileId: string): Promise<ProfileLease> {
    const key = this.getKey(tenantId, profileId);
    const leaseToken = randomUUID();
    const acquired = await this.redis.set(key, leaseToken, 'PX', this.ttlMs, 'NX');
    if (!acquired) {
      throw new Error('LEASE_ALREADY_ACQUIRED');
    }

    return { profileId, leaseToken, expiresAt: Date.now() + this.ttlMs };
  }

  public async renew(tenantId: string, profileId: string, leaseToken: string): Promise<ProfileLease> {
    const key = this.getKey(tenantId, profileId);
    const result = await this.redis.eval(RENEW_SCRIPT, 1, key, leaseToken, this.ttlMs);
    if (result === 0) {
      throw new Error('LEASE_LOST');
    }

    return { profileId, leaseToken, expiresAt: Date.now() + this.ttlMs };
  }

  public async release(tenantId: string, profileId: string, leaseToken: string): Promise<void> {
    const key = this.getKey(tenantId, profileId);
    await this.redis.eval(RELEASE_SCRIPT, 1, key, leaseToken);
  }

  public async shutdown(): Promise<void> {
    // The queue adapter owns this shared Redis connection.
  }
}
