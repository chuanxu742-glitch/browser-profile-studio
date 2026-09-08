import { describe, it, expect, beforeEach } from 'vitest';
import {
  AccountPlacementRegistry,
  InMemorySharedStateStore,
  RedisSharedAccountStateStore
} from '../../src/distributed/account-placement.js';
import type { AccountPlacementRecord } from '../../src/distributed/account-placement.js';
import type { Redis } from 'ioredis';

describe('AccountPlacementRegistry', () => {
  let store: InMemorySharedStateStore<AccountPlacementRecord>;
  let registry: AccountPlacementRegistry;
  let currentTime: number;

  const clock = () => currentTime;
  const timeoutMs = 5000;

  beforeEach(() => {
    store = new InMemorySharedStateStore<AccountPlacementRecord>();
    currentTime = 10000;
    registry = new AccountPlacementRegistry(store, clock, timeoutMs);
  });

  it('provides deterministic sticky placement', async () => {
    registry.registerWorker('worker-1', 10, 'default');
    registry.registerWorker('worker-2', 10, 'default');
    registry.registerWorker('worker-3', 10, 'default');

    const placement1 = await registry.acquirePlacement('tenant-1', 'account-a');
    expect(placement1.workerId).toBeDefined();
    expect(placement1.generation).toBe(1);

    // Sticky
    const placement2 = await registry.acquirePlacement('tenant-1', 'account-a');
    expect(placement2.workerId).toBe(placement1.workerId);
    expect(placement2.generation).toBe(1);
  });

  it('respects worker capacity', async () => {
    registry.registerWorker('worker-1', 1, 'default');
    registry.registerWorker('worker-2', 10, 'default');

    // Max out worker-1
    registry.updateLoad('worker-1', 1);

    for (let i = 0; i < 10; i++) {
      const placement = await registry.acquirePlacement('tenant-1', `account-b-${i}`);
      // Since worker-1 is full, they must all go to worker-2
      expect(placement.workerId).toBe('worker-2');
    }
  });

  it('maintains tenant isolation and storage namespace safety', async () => {
    registry.registerWorker('worker-eu', 10, 'ns-eu');
    registry.registerWorker('worker-us', 10, 'ns-us');

    const placement = await registry.acquirePlacement('tenant-1', 'account-c', 'ns-eu');
    expect(placement.workerId).toBe('worker-eu');

    // If we request it again with a conflicting namespace, it should throw
    await expect(registry.acquirePlacement('tenant-1', 'account-c', 'ns-us'))
      .rejects.toThrow(/cannot satisfy requirement ns-us/);

    // Failover safety: advance clock so worker-eu dies
    currentTime += timeoutMs + 1000;
    
    // worker-eu is dead, worker-us is alive, but it's the wrong namespace
    registry.heartbeat('worker-us');
    await expect(registry.acquirePlacement('tenant-1', 'account-c'))
      .rejects.toThrow(/No available workers can fail over the account in namespace ns-eu/);
  });

  it('triggers failover with generation fencing', async () => {
    registry.registerWorker('worker-1', 10, 'default');
    const placement1 = await registry.acquirePlacement('tenant-1', 'account-d');
    expect(placement1.workerId).toBe('worker-1');
    expect(placement1.generation).toBe(1);

    // Add new worker and kill the first one
    registry.registerWorker('worker-2', 10, 'default');
    currentTime += timeoutMs + 1000;
    registry.heartbeat('worker-2'); // worker-2 is alive

    const placement2 = await registry.acquirePlacement('tenant-1', 'account-d');
    expect(placement2.workerId).toBe('worker-2');
    expect(placement2.generation).toBe(2); // Fencing token incremented
  });

  it('handles CAS conflicts explicitly', async () => {
    registry.registerWorker('worker-1', 10, 'default');

    const originalCompareAndSet = store.compareAndSet.bind(store);
    
    // Simulate a concurrent write
    store.compareAndSet = async (ten: string, acc: string, exp: number, data: AccountPlacementRecord) => {
      await originalCompareAndSet(ten, acc, exp, { workerId: 'hacker', storageNamespace: 'default', generation: 99 });
      return originalCompareAndSet(ten, acc, exp, data);
    };

    await expect(registry.acquirePlacement('tenant-1', 'account-e'))
      .rejects.toThrow(/CAS conflict/);
  });

  it('handles worker recovery correctly', async () => {
    registry.registerWorker('worker-1', 10, 'default');
    registry.registerWorker('worker-2', 10, 'default');

    const placement1 = await registry.acquirePlacement('tenant-1', 'account-f');
    const originalWorker = placement1.workerId;
    const backupWorker = originalWorker === 'worker-1' ? 'worker-2' : 'worker-1';

    // Original worker dies
    currentTime += timeoutMs + 1000;
    registry.heartbeat(backupWorker);

    // Failover occurs
    const placement2 = await registry.acquirePlacement('tenant-1', 'account-f');
    expect(placement2.workerId).toBe(backupWorker);
    expect(placement2.generation).toBe(2);

    // Original worker comes back online
    registry.heartbeat(originalWorker);
    
    // Next placement check should still stick to the backup worker, as it's alive and owns the state
    const placement3 = await registry.acquirePlacement('tenant-1', 'account-f');
    expect(placement3.workerId).toBe(backupWorker);
    expect(placement3.generation).toBe(2);
  });
});

describe('RedisSharedAccountStateStore', () => {
  it('supports CAS semantics using a fake redis client', async () => {
    // Create a fake Redis client that simulates EVAL
    const dataStore = new Map<string, string>();
    const fakeRedis = {
      hmget: async (key: string, field1: string, field2: string) => {
        const val = dataStore.get(key);
        if (!val) return [null, null];
        const parsed = JSON.parse(val);
        return [parsed.data, String(parsed.version)];
      },
      eval: async (lua: string, numkeys: number, key: string, expectedVersionStr: string, dataStr: string) => {
        const expectedVersion = parseInt(expectedVersionStr, 10);
        const current = dataStore.get(key);
        const currentVersion = current ? JSON.parse(current).version : 0;
        
        if (currentVersion === expectedVersion) {
          dataStore.set(key, JSON.stringify({ data: dataStr, version: expectedVersion + 1 }));
          return 1;
        }
        return 0;
      }
    } as unknown as Redis;

    const store = new RedisSharedAccountStateStore<{ value: string }>(fakeRedis);
    const tenantId = 't-123';
    const accountId = 'a-456';

    // Initial get
    let res = await store.get(tenantId, accountId);
    expect(res).toBeNull();

    // Initial set
    let success = await store.compareAndSet(tenantId, accountId, 0, { value: 'initial' });
    expect(success).toBe(true);

    // Read back
    res = await store.get(tenantId, accountId);
    expect(res).toBeDefined();
    expect(res!.data).toEqual({ value: 'initial' });
    expect(res!.version).toBe(1);

    // Conflict
    success = await store.compareAndSet(tenantId, accountId, 0, { value: 'conflict' });
    expect(success).toBe(false);

    // Update
    success = await store.compareAndSet(tenantId, accountId, 1, { value: 'updated' });
    expect(success).toBe(true);
    
    res = await store.get(tenantId, accountId);
    expect(res!.version).toBe(2);
  });
});
