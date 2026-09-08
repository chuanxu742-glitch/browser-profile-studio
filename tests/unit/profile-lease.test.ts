import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryLeaseManager, RedisLeaseManager } from '../../src/distributed/profile-lease.js';
import type { Redis } from 'ioredis';

describe('MemoryLeaseManager', () => {
  let manager: MemoryLeaseManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new MemoryLeaseManager(30_000);
  });

  afterEach(async () => {
    await manager.shutdown();
    vi.useRealTimers();
  });

  it('acquires and releases a lease', async () => {
    const lease = await manager.acquire('tenant-1', 'profile-a');
    expect(lease.profileId).toBe('profile-a');
    expect(lease.leaseToken).toBeTypeOf('string');

    await expect(manager.acquire('tenant-1', 'profile-a')).rejects.toThrow('LEASE_ALREADY_ACQUIRED');

    await manager.release('tenant-1', 'profile-a', lease.leaseToken);
    
    // Should be able to acquire again
    const lease2 = await manager.acquire('tenant-1', 'profile-a');
    expect(lease2.leaseToken).not.toBe(lease.leaseToken);
  });

  it('coordinates ownership across manager instances in one process', async () => {
    const second = new MemoryLeaseManager(30_000);
    const lease = await manager.acquire('tenant-1', 'shared-profile');

    await expect(second.acquire('tenant-1', 'shared-profile')).rejects.toThrow('LEASE_ALREADY_ACQUIRED');
    await manager.release('tenant-1', 'shared-profile', lease.leaseToken);
    await expect(second.acquire('tenant-1', 'shared-profile')).resolves.toMatchObject({
      profileId: 'shared-profile',
    });

    await second.shutdown();
  });

  it('renews a lease', async () => {
    const lease = await manager.acquire('tenant-1', 'profile-a');
    
    vi.advanceTimersByTime(15_000);
    
    const renewed = await manager.renew('tenant-1', 'profile-a', lease.leaseToken);
    expect(renewed.leaseToken).toBe(lease.leaseToken);
    expect(renewed.expiresAt).toBeGreaterThan(lease.expiresAt);
  });

  it('fails to renew if lease is lost', async () => {
    const lease = await manager.acquire('tenant-1', 'profile-a');
    
    // Advance past TTL
    vi.advanceTimersByTime(31_000);
    
    await expect(manager.renew('tenant-1', 'profile-a', lease.leaseToken)).rejects.toThrow('LEASE_LOST');
  });

  it('fails to renew with wrong token', async () => {
    await manager.acquire('tenant-1', 'profile-a');
    await expect(manager.renew('tenant-1', 'profile-a', 'wrong-token')).rejects.toThrow('LEASE_LOST');
  });
});

describe('RedisLeaseManager', () => {
  // Use a typed mock object instead of any
  type MockRedis = {
    set: ReturnType<typeof vi.fn>;
    eval: ReturnType<typeof vi.fn>;
    quit: ReturnType<typeof vi.fn>;
  };
  
  let mockRedis: MockRedis;
  let manager: RedisLeaseManager;

  beforeEach(() => {
    mockRedis = {
      set: vi.fn(),
      eval: vi.fn(),
      quit: vi.fn(),
    };
    manager = new RedisLeaseManager(mockRedis as unknown as Redis, 30_000);
  });

  it('acquires lease successfully', async () => {
    mockRedis.set.mockResolvedValue('OK');
    const lease = await manager.acquire('tenant-1', 'profile-a');
    
    expect(mockRedis.set).toHaveBeenCalledWith(
      'browser:profile:lease:tenant-1:profile-a',
      expect.any(String),
      'PX',
      30_000,
      'NX'
    );
    expect(lease.profileId).toBe('profile-a');
  });

  it('throws when lease is already acquired', async () => {
    mockRedis.set.mockResolvedValue(null);
    await expect(manager.acquire('tenant-1', 'profile-a')).rejects.toThrow('LEASE_ALREADY_ACQUIRED');
  });

  it('renews lease successfully', async () => {
    mockRedis.eval.mockResolvedValue(1);
    const lease = await manager.renew('tenant-1', 'profile-a', 'token-123');
    
    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.stringContaining('pexpire'),
      1,
      'browser:profile:lease:tenant-1:profile-a',
      'token-123',
      30_000
    );
    expect(lease.leaseToken).toBe('token-123');
  });

  it('throws when renewing lost lease', async () => {
    mockRedis.eval.mockResolvedValue(0);
    await expect(manager.renew('tenant-1', 'profile-a', 'token-123')).rejects.toThrow('LEASE_LOST');
  });

  it('releases lease', async () => {
    mockRedis.eval.mockResolvedValue(1);
    await manager.release('tenant-1', 'profile-a', 'token-123');
    
    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.stringContaining('del'),
      1,
      'browser:profile:lease:tenant-1:profile-a',
      'token-123'
    );
  });
});
