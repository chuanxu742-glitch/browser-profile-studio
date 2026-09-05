import type { Cluster, Redis } from 'ioredis';
import type { WorkerNodeInfo } from './types.js';

export interface AccountPlacementRecord {
  workerId: string;
  storageNamespace: string;
  generation: number;
}

export interface SharedAccountStateStore<T> {
  get(tenantId: string, accountId: string): Promise<{ data: T; version: number } | null>;
  compareAndSet(tenantId: string, accountId: string, expectedVersion: number, data: T): Promise<boolean>;
}

export interface WorkerNode {
  id: string;
  tenantId: string;
  capacity: number;
  load: number;
  storageNamespace: string;
  lastHeartbeat: number;
}

const REDIS_CAS_SCRIPT = `
local currentVersion = tonumber(redis.call('HGET', KEYS[1], 'version') or '0')
local expectedVersion = tonumber(ARGV[1])
if currentVersion ~= expectedVersion then
  return 0
end
redis.call('HSET', KEYS[1], 'data', ARGV[2], 'version', tostring(expectedVersion + 1))
return 1
`;

function stateKey(tenantId: string, accountId: string): string {
  return JSON.stringify([tenantId, accountId]);
}

function validateScope(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) throw new Error(`${name} must contain 1-256 characters`);
  return normalized;
}

function validateStorageNamespace(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) {
    throw new Error('storageNamespace is invalid');
  }
  return normalized;
}

export class InMemorySharedStateStore<T> implements SharedAccountStateStore<T> {
  private readonly store = new Map<string, { data: T; version: number }>();

  async get(tenantId: string, accountId: string): Promise<{ data: T; version: number } | null> {
    const record = this.store.get(stateKey(validateScope(tenantId, 'tenantId'), validateScope(accountId, 'accountId')));
    return record ? { data: structuredClone(record.data), version: record.version } : null;
  }

  async compareAndSet(tenantId: string, accountId: string, expectedVersion: number, data: T): Promise<boolean> {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error('expectedVersion must be a nonnegative integer');
    const key = stateKey(validateScope(tenantId, 'tenantId'), validateScope(accountId, 'accountId'));
    const current = this.store.get(key);
    if ((current?.version ?? 0) !== expectedVersion) return false;
    this.store.set(key, { data: structuredClone(data), version: expectedVersion + 1 });
    return true;
  }
}

export class RedisSharedAccountStateStore<T> implements SharedAccountStateStore<T> {
  constructor(
    private readonly redis: Redis | Cluster,
    private readonly prefix = 'placement',
  ) {
    if (!/^[A-Za-z0-9:_-]{1,64}$/.test(prefix)) throw new Error('Redis placement prefix is invalid');
  }

  async get(tenantId: string, accountId: string): Promise<{ data: T; version: number } | null> {
    const values = await this.redis.hmget(this.redisKey(tenantId, accountId), 'data', 'version');
    const dataString = values[0] ?? null;
    const versionString = values[1] ?? null;
    if (dataString === null && versionString === null) return null;
    if (dataString === null || versionString === null || !/^\d+$/.test(versionString)) {
      throw new Error('Corrupt shared account state record');
    }
    const version = Number(versionString);
    if (!Number.isSafeInteger(version) || version < 1) throw new Error('Corrupt shared account state version');
    return { data: JSON.parse(dataString) as T, version };
  }

  async compareAndSet(tenantId: string, accountId: string, expectedVersion: number, data: T): Promise<boolean> {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error('expectedVersion must be a nonnegative integer');
    const serialized = JSON.stringify(data);
    if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > 10 * 1024 * 1024) {
      throw new Error('Shared account state is not serializable or exceeds 10 MiB');
    }
    const result = await this.redis.eval(
      REDIS_CAS_SCRIPT,
      1,
      this.redisKey(tenantId, accountId),
      String(expectedVersion),
      serialized,
    );
    return result === 1;
  }

  private redisKey(tenantId: string, accountId: string): string {
    const tenant = encodeURIComponent(validateScope(tenantId, 'tenantId'));
    const account = encodeURIComponent(validateScope(accountId, 'accountId'));
    return `${this.prefix}:{${tenant}}:${account}`;
  }
}

export class AccountPlacementRegistry {
  private readonly workers = new Map<string, WorkerNode>();

  constructor(
    private readonly store: SharedAccountStateStore<AccountPlacementRecord>,
    private readonly clock: () => number = Date.now,
    private readonly heartbeatTimeoutMs = 30_000,
  ) {
    if (!Number.isSafeInteger(heartbeatTimeoutMs) || heartbeatTimeoutMs < 1_000) {
      throw new Error('heartbeatTimeoutMs must be an integer of at least 1000');
    }
  }

  registerWorker(id: string, capacity: number, storageNamespace: string, tenantId = '*'): void {
    const workerId = validateScope(id, 'workerId');
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 10_000) {
      throw new Error('Worker capacity must be an integer from 1 to 10000');
    }
    this.workers.set(workerId, {
      id: workerId,
      tenantId: validateScope(tenantId, 'tenantId'),
      capacity,
      load: 0,
      storageNamespace: validateStorageNamespace(storageNamespace),
      lastHeartbeat: this.readNow(),
    });
  }

  heartbeat(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (worker) worker.lastHeartbeat = this.readNow();
  }

  updateLoad(workerId: string, load: number): void {
    if (!Number.isSafeInteger(load) || load < 0) throw new Error('Worker load must be a nonnegative integer');
    const worker = this.workers.get(workerId);
    if (worker) worker.load = load;
  }

  syncWorkers(workers: readonly WorkerNodeInfo[]): void {
    const incoming = new Set<string>();
    for (const worker of workers) {
      if (!worker.healthy || !Number.isSafeInteger(worker.capacity) || worker.capacity < 1 || worker.capacity > 10_000
        || !Number.isSafeInteger(worker.activeTasks) || worker.activeTasks < 0
        || !Number.isFinite(worker.lastHeartbeat)) continue;
      try {
        const workerId = validateScope(worker.workerId, 'workerId');
        this.workers.set(workerId, {
          id: workerId,
          tenantId: validateScope(worker.tenantId, 'tenantId'),
          capacity: worker.capacity,
          load: worker.activeTasks,
          storageNamespace: validateStorageNamespace(worker.storageNamespace ?? `local:${workerId}`),
          lastHeartbeat: worker.lastHeartbeat,
        });
        incoming.add(workerId);
      } catch {
        continue;
      }
    }
    for (const workerId of this.workers.keys()) {
      if (!incoming.has(workerId)) this.workers.delete(workerId);
    }
  }

  removeWorker(workerId: string): void {
    this.workers.delete(workerId);
  }

  async acquirePlacement(
    tenantIdInput: string,
    accountIdInput: string,
    requiredStorageNamespace?: string,
  ): Promise<{ workerId: string; generation: number }> {
    const tenantId = validateScope(tenantIdInput, 'tenantId');
    const accountId = validateScope(accountIdInput, 'accountId');
    const requiredNamespace = requiredStorageNamespace === undefined
      ? undefined
      : validateStorageNamespace(requiredStorageNamespace);
    const current = await this.store.get(tenantId, accountId);
    const now = this.readNow();
    let candidates = [...this.workers.values()].filter((worker) => (
      (worker.tenantId === '*' || worker.tenantId === tenantId)
      && now - worker.lastHeartbeat <= this.heartbeatTimeoutMs
      && worker.load < worker.capacity
    ));

    if (current) {
      const record = this.validatePlacementRecord(current.data);
      const currentWorker = this.workers.get(record.workerId);
      const currentWorkerAlive = currentWorker !== undefined
        && (currentWorker.tenantId === '*' || currentWorker.tenantId === tenantId)
        && currentWorker.storageNamespace === record.storageNamespace
        && now - currentWorker.lastHeartbeat <= this.heartbeatTimeoutMs;
      if (requiredNamespace !== undefined && record.storageNamespace !== requiredNamespace) {
        throw new Error(`Account locked to storage namespace ${record.storageNamespace}, cannot satisfy requirement ${requiredNamespace}`);
      }
      if (currentWorkerAlive) return { workerId: record.workerId, generation: record.generation };

      candidates = candidates.filter((worker) => worker.storageNamespace === record.storageNamespace);
      if (candidates.length === 0) {
        throw new Error(`No available workers can fail over the account in namespace ${record.storageNamespace}`);
      }
      const selected = this.selectWorker(candidates, `${tenantId}\0${accountId}`);
      if (record.generation === Number.MAX_SAFE_INTEGER) throw new Error('Account placement generation is exhausted');
      const next: AccountPlacementRecord = {
        workerId: selected.id,
        storageNamespace: record.storageNamespace,
        generation: record.generation + 1,
      };
      if (!await this.store.compareAndSet(tenantId, accountId, current.version, next)) {
        throw new Error('CAS conflict: account placement modified concurrently');
      }
      return { workerId: next.workerId, generation: next.generation };
    }

    if (requiredNamespace !== undefined) candidates = candidates.filter((worker) => worker.storageNamespace === requiredNamespace);
    if (candidates.length === 0) {
      throw new Error(requiredNamespace === undefined
        ? 'No available workers for new placement'
        : `No available workers in storage namespace: ${requiredNamespace}`);
    }
    const selected = this.selectWorker(candidates, `${tenantId}\0${accountId}`);
    const next: AccountPlacementRecord = {
      workerId: selected.id,
      storageNamespace: requiredNamespace ?? selected.storageNamespace,
      generation: 1,
    };
    if (!await this.store.compareAndSet(tenantId, accountId, 0, next)) {
      throw new Error('CAS conflict: account placement modified concurrently');
    }
    return { workerId: next.workerId, generation: next.generation };
  }

  private selectWorker(workers: WorkerNode[], key: string): WorkerNode {
    workers.sort((left, right) => left.id.localeCompare(right.id));
    let hash = 2_166_136_261;
    for (let index = 0; index < key.length; index += 1) {
      hash ^= key.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619);
    }
    return workers[(hash >>> 0) % workers.length]!;
  }

  private validatePlacementRecord(value: AccountPlacementRecord): AccountPlacementRecord {
    const generation = value?.generation;
    if (!value || !Number.isSafeInteger(generation) || generation < 1) throw new Error('Corrupt account placement record');
    return {
      workerId: validateScope(value.workerId, 'placement workerId'),
      storageNamespace: validateStorageNamespace(value.storageNamespace),
      generation,
    };
  }

  private readNow(): number {
    const value = this.clock();
    if (!Number.isFinite(value) || value < 0) throw new Error('Placement clock returned an invalid timestamp');
    return value;
  }
}
