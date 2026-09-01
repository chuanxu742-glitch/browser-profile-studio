import { randomUUID } from 'node:crypto';
import { Cluster, Redis } from 'ioredis';
import type { RedisOptions } from 'ioredis';

import type { TaskQueueAdapter } from './queue-adapter.js';
import { TaskLeaseLostError } from './types.js';
import type { DistributedTaskRecord, WorkerNodeInfo, TaskPriority } from './types.js';
import { DEFAULT_TENANT_ID, normalizeTenantId } from './tenant.js';

const PRIORITY_SCORES: Record<TaskPriority, number> = {
  CRITICAL: 1,
  HIGH: 2,
  NORMAL: 3,
  LOW: 4,
};

export type RedisMode = 'standalone' | 'cluster';

export interface RedisAdapterOptions {
  redisUrl?: string | undefined;
  redisMode?: RedisMode | undefined;
  /** Cluster startup nodes as redis:// URLs or host:port values. */
  redisClusterNodes?: readonly string[] | undefined;
  keyPrefix?: string | undefined;
  taskTtlSeconds?: number | undefined; // 已完成任务保留时长，默认 7 天
  leaseSeconds?: number | undefined; // Worker 崩溃后的任务租约，默认 5 分钟
  /** Independent queue partitions per tenant. Must be identical on all nodes. */
  shardCount?: number | undefined;
}

type RedisClient = Redis | Cluster;
type RedisTransaction = ReturnType<Redis['multi']>;

/**
 * Redis-backed distributed queue with both standalone and native Redis
 * Cluster modes. Every tenant/shard uses one hash tag so each Lua operation
 * stays on one Redis Cluster slot; different tenants and shards can spread
 * across the cluster.
 */
export class RedisQueueAdapter implements TaskQueueAdapter {
  public readonly shardCount: number;
  private readonly redis: RedisClient;
  private readonly prefix: string;
  private readonly taskTtlSeconds: number;
  private readonly leaseSeconds: number;

  public get leaseDurationMs(): number {
    return this.leaseSeconds * 1_000;
  }

  public constructor(options: RedisAdapterOptions = {}) {
    this.prefix = options.keyPrefix ?? 'antigravity:crawler:';
    this.taskTtlSeconds = boundedInteger(options.taskTtlSeconds ?? 604_800, 60, 31_536_000, 604_800); // 7 days
    this.leaseSeconds = boundedInteger(options.leaseSeconds ?? 300, 30, 3_600, 300);
    this.shardCount = boundedInteger(
      options.shardCount ?? parseShardCount(process.env.REDIS_SHARD_COUNT),
      1,
      64,
      16,
    );

    const configuredNodes = options.redisClusterNodes ?? parseClusterNodes(process.env.REDIS_CLUSTER_NODES);
    const mode = options.redisMode ?? parseRedisMode(process.env.REDIS_MODE, configuredNodes.length > 0);
    if (mode === 'cluster') {
      if (configuredNodes.length === 0) throw new Error('Redis Cluster mode requires REDIS_CLUSTER_NODES.');
      this.redis = new Cluster(configuredNodes.map(parseClusterNode), clusterOptions(options.redisUrl));
    } else {
      const url = options.redisUrl ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
      this.redis = new Redis(standaloneOptions(url) as RedisOptions & { replyMapping?: 'legacy' });
    }
  }

  public async enqueueTask(task: DistributedTaskRecord): Promise<void> {
    if (task.leaseId !== undefined) {
      await this.enqueueOwnedTask(task);
      return;
    }
    await this.enqueueBatch([task]);
  }

  public async enqueueBatch(tasks: readonly DistributedTaskRecord[]): Promise<void> {
    const ownedTasks = tasks.filter((task) => task.leaseId !== undefined);
    if (ownedTasks.length > 0) {
      if (ownedTasks.length !== tasks.length) {
        throw new Error('Owned and unowned tasks cannot be mixed in one enqueue batch.');
      }
      for (const task of ownedTasks) await this.enqueueOwnedTask(task);
      return;
    }
    const grouped = new Map<string, DistributedTaskRecord[]>();
    for (const task of tasks) {
      const tenantId = normalizeTenantId(task.tenantId);
      const shard = this.taskShard(task.id);
      const key = `${tenantId}\0${shard}`;
      const group = grouped.get(key) ?? [];
      group.push({ ...task, tenantId });
      grouped.set(key, group);
    }

    for (const [key, groupedTasks] of grouped) {
      const separator = key.lastIndexOf('\0');
      const tenantId = key.slice(0, separator);
      const shard = Number(key.slice(separator + 1));
      await this.enqueueUnownedBatch(groupedTasks, tenantId, shard);
    }
  }

  public async dequeueTask(workerId: string, tenantId = DEFAULT_TENANT_ID, shard = 0): Promise<DistributedTaskRecord | null> {
    const normalizedTenantId = normalizeTenantId(tenantId);
    const normalizedShard = this.normalizeShard(shard);
    const leaseId = randomUUID();
    // 过期租约回收、原子弹出和租约登记全部在同一 hash slot 完成。
    const lua = `
      local now = tonumber(ARGV[1])
      local leaseUntil = now + tonumber(ARGV[2])
      local taskTtl = tonumber(ARGV[3])
      local leaseId = ARGV[4]
      local workerId = ARGV[5]

      local expired = redis.call('zrangebyscore', KEYS[3], '-inf', now)
      for _, expiredId in ipairs(expired) do
        local expiredKey = KEYS[2] .. expiredId
        local expiredRaw = redis.call('get', expiredKey)
        if expiredRaw then
          local decoded, expiredTask = pcall(cjson.decode, expiredRaw)
          if decoded and type(expiredTask) == 'table' then
            local expiredState = expiredTask['state']
            if expiredState == 'RUNNING' then
              local retries = tonumber(expiredTask['retries'] or 0) + 1
              expiredTask['retries'] = retries
              expiredTask['workerId'] = nil
              expiredTask['leaseId'] = nil
              expiredTask['startedAt'] = nil
              expiredTask['error'] = 'Worker lease expired before task completion.'
              if retries <= tonumber(expiredTask['maxRetries'] or 0) then
                expiredTask['state'] = 'PENDING'
                local priority = 3
                if expiredTask['priority'] == 'CRITICAL' then priority = 1 end
                if expiredTask['priority'] == 'HIGH' then priority = 2 end
                if expiredTask['priority'] == 'LOW' then priority = 4 end
                redis.call('set', expiredKey, cjson.encode(expiredTask))
                redis.call('zadd', KEYS[1], priority * 1000000000000 + tonumber(expiredTask['createdAt'] or now), expiredId)
              else
                expiredTask['state'] = 'FAILED'
                expiredTask['completedAt'] = now
                redis.call('set', expiredKey, cjson.encode(expiredTask), 'EX', taskTtl)
              end
            elseif expiredState == 'PENDING' or expiredState == 'RETRYING' then
              -- A task can be in a retry handoff state while the original
              -- worker still owns its lease. Clear that ownership before
              -- making it visible to a new worker, so the old worker cannot
              -- race the next dequeue with a late write.
              expiredTask['workerId'] = nil
              expiredTask['leaseId'] = nil
              expiredTask['startedAt'] = nil
              local priority = 3
              if expiredTask['priority'] == 'CRITICAL' then priority = 1 end
              if expiredTask['priority'] == 'HIGH' then priority = 2 end
              if expiredTask['priority'] == 'LOW' then priority = 4 end
              redis.call('set', expiredKey, cjson.encode(expiredTask))
              redis.call('zadd', KEYS[1], priority * 1000000000000 + tonumber(expiredTask['createdAt'] or now), expiredId)
            end
          end
        end
        redis.call('zrem', KEYS[3], expiredId)
      end

      local popped = redis.call('zpopmin', KEYS[1], 1)
      if #popped == 0 then return nil end
      local taskId = popped[1]
      local taskKey = KEYS[2] .. taskId
      local raw = redis.call('get', taskKey)
      if not raw then return nil end
      local decoded, task = pcall(cjson.decode, raw)
      if not decoded or type(task) ~= 'table' then
        redis.call('zrem', KEYS[3], taskId)
        return nil
      end
      local state = task['state']
      if state ~= 'PENDING' and state ~= 'RETRYING' then
        redis.call('zrem', KEYS[3], taskId)
        return nil
      end
      task['state'] = 'RUNNING'
      task['workerId'] = workerId
      task['leaseId'] = leaseId
      task['startedAt'] = now
      local leasedRaw = cjson.encode(task)
      redis.call('set', taskKey, leasedRaw)
      redis.call('zadd', KEYS[3], leaseUntil, taskId)
      return {taskId, leasedRaw}
    `;

    const result = (await this.redis.eval(
      lua,
      3,
      this.pendingKey(normalizedTenantId, normalizedShard),
      this.taskPrefix(normalizedTenantId, normalizedShard),
      this.processingKey(normalizedTenantId, normalizedShard),
      Date.now(),
      this.leaseSeconds * 1_000,
      this.taskTtlSeconds,
      leaseId,
      workerId,
    )) as [string, string] | null;

    if (!result) return null;
    const [taskId, raw] = result;
    let task: DistributedTaskRecord;
    try {
      task = JSON.parse(raw) as DistributedTaskRecord;
    } catch {
      await this.redis.zrem(this.processingKey(normalizedTenantId, normalizedShard), taskId).catch(() => undefined);
      return null;
    }
    if (task.id !== taskId || task.tenantId !== normalizedTenantId) {
      await this.redis.zrem(this.processingKey(normalizedTenantId, normalizedShard), taskId).catch(() => undefined);
      return null;
    }
    if (task.state !== 'RUNNING' || task.workerId !== workerId || task.leaseId !== leaseId) {
      await this.redis.zrem(this.processingKey(normalizedTenantId, normalizedShard), taskId).catch(() => undefined);
      return null;
    }
    return task;
  }

  public async updateTask(task: DistributedTaskRecord): Promise<void> {
    const tenantId = normalizeTenantId(task.tenantId);
    const shard = this.taskShard(task.id);
    const normalizedTask = { ...task, tenantId };
    const taskKey = this.taskKey(tenantId, shard, task.id);
    const lua = `
      local expectedLeaseId = ARGV[1]
      local expectedWorkerId = ARGV[2]
      local encodedTask = ARGV[3]
      local now = tonumber(ARGV[4])
      local leaseMs = tonumber(ARGV[5])
      local taskTtl = tonumber(ARGV[6])
      local decodedIncoming, incomingTask = pcall(cjson.decode, encodedTask)
      if not decodedIncoming or type(incomingTask) ~= 'table' then return 0 end

      local existingRaw = redis.call('get', KEYS[1])
      if existingRaw then
        local decodedExisting, existingTask = pcall(cjson.decode, existingRaw)
        if not decodedExisting or type(existingTask) ~= 'table' then return 0 end
        local existingLeaseId = existingTask['leaseId']
        local existingWorkerId = existingTask['workerId']
        if expectedLeaseId ~= '' then
          if existingLeaseId ~= expectedLeaseId or existingWorkerId ~= expectedWorkerId then return 0 end
          local leaseUntil = redis.call('zscore', KEYS[2], incomingTask['id'])
          if not leaseUntil or tonumber(leaseUntil) <= now then return 0 end
        elseif existingLeaseId ~= nil then
          return 0
        end
      elseif expectedLeaseId ~= '' then
        return 0
      end

      redis.call('set', KEYS[1], encodedTask)
      if incomingTask['state'] == 'RUNNING'
        or (incomingTask['state'] == 'PENDING' and expectedLeaseId ~= '')
        or (incomingTask['state'] == 'RETRYING' and expectedLeaseId ~= '') then
        redis.call('zadd', KEYS[2], now + leaseMs, incomingTask['id'])
      else
        redis.call('zrem', KEYS[2], incomingTask['id'])
      end
      if incomingTask['state'] == 'COMPLETED' or incomingTask['state'] == 'FAILED' or incomingTask['state'] == 'CANCELLED' then
        redis.call('zrem', KEYS[3], incomingTask['id'])
        redis.call('expire', KEYS[1], taskTtl)
      end
      return 1
    `;
    const result = await this.redis.eval(
      lua,
      3,
      taskKey,
      this.processingKey(tenantId, shard),
      this.pendingKey(tenantId, shard),
      normalizedTask.leaseId ?? '',
      normalizedTask.workerId ?? '',
      JSON.stringify(normalizedTask),
      Date.now(),
      this.leaseSeconds * 1_000,
      this.taskTtlSeconds,
    );
    if (Number(result) !== 1) throw new TaskLeaseLostError();
  }

  public async renewTaskLease(task: DistributedTaskRecord): Promise<boolean> {
    if (!task.leaseId || !task.workerId) return false;
    const tenantId = normalizeTenantId(task.tenantId);
    const shard = this.taskShard(task.id);
    const lua = `
      local raw = redis.call('get', KEYS[1])
      if not raw then return 0 end
      local decoded, current = pcall(cjson.decode, raw)
      if not decoded or type(current) ~= 'table' then return 0 end
      if current['state'] ~= 'RUNNING' or current['workerId'] ~= ARGV[1] or current['leaseId'] ~= ARGV[2] then return 0 end
      redis.call('zadd', KEYS[2], tonumber(ARGV[3]) + tonumber(ARGV[4]), current['id'])
      return 1
    `;
    const result = await this.redis.eval(
      lua,
      2,
      this.taskKey(tenantId, shard, task.id),
      this.processingKey(tenantId, shard),
      task.workerId,
      task.leaseId,
      Date.now(),
      this.leaseSeconds * 1_000,
    );
    return Number(result) === 1;
  }

  public async getTask(taskId: string, tenantId = DEFAULT_TENANT_ID): Promise<DistributedTaskRecord | null> {
    const normalizedTenantId = normalizeTenantId(tenantId);
    const raw = await this.redis.get(this.taskKey(normalizedTenantId, this.taskShard(taskId), taskId));
    if (!raw) return null;
    try {
      const task = JSON.parse(raw) as DistributedTaskRecord;
      return task.id === taskId && task.tenantId === normalizedTenantId ? task : null;
    } catch {
      return null;
    }
  }

  public async listTasks(limit = 100, tenantId = DEFAULT_TENANT_ID): Promise<DistributedTaskRecord[]> {
    const normalizedTenantId = normalizeTenantId(tenantId);
    const boundedLimit = boundedInteger(limit, 1, 500, 100);
    const results: DistributedTaskRecord[] = [];
    for (let shard = 0; shard < this.shardCount && results.length < boundedLimit; shard++) {
      const keys = await this.scanKeys(this.taskPattern(normalizedTenantId, shard), boundedLimit - results.length);
      if (keys.length === 0) continue;
      const values = await this.redis.mget(keys);
      for (const value of values) {
        if (!value) continue;
        try {
          const task = JSON.parse(value) as DistributedTaskRecord;
          if (task.tenantId === normalizedTenantId) results.push(task);
        } catch {}
      }
    }
    return results.slice(0, boundedLimit);
  }

  public async updateWorkerHeartbeat(worker: WorkerNodeInfo): Promise<void> {
    const tenantId = normalizeTenantId(worker.tenantId);
    const key = this.workerKey(tenantId, worker.workerId);
    const payload = JSON.stringify({ ...worker, tenantId, lastHeartbeat: Date.now() });
    await this.redis.set(key, payload, 'EX', 60);
  }

  public async listWorkers(tenantId = DEFAULT_TENANT_ID): Promise<WorkerNodeInfo[]> {
    const normalizedTenantId = normalizeTenantId(tenantId);
    const keys = await this.scanKeys(this.workerPattern(normalizedTenantId), 1_000);
    if (keys.length === 0) return [];
    const values = await this.redis.mget(keys);
    const workers: WorkerNodeInfo[] = [];
    for (const value of values) {
      if (!value) continue;
      try {
        const worker = JSON.parse(value) as WorkerNodeInfo;
        if (worker.tenantId === normalizedTenantId) workers.push(worker);
      } catch {}
    }
    return workers;
  }

  public async isUrlSeen(url: string, tenantId = DEFAULT_TENANT_ID): Promise<boolean> {
    const key = this.seenKey(normalizeTenantId(tenantId));
    const now = Date.now();
    await this.redis.zremrangebyscore(key, 0, now);
    const expiresAt = await this.redis.zscore(key, url);
    return expiresAt !== null && Number(expiresAt) > now;
  }

  public async claimUrl(url: string, ttlSeconds = 2_592_000, tenantId = DEFAULT_TENANT_ID): Promise<boolean> {
    return this.claimUrls([url], ttlSeconds, tenantId);
  }

  public async claimUrls(urls: readonly string[], ttlSeconds = 2_592_000, tenantId = DEFAULT_TENANT_ID): Promise<boolean> {
    if (urls.length === 0 || ttlSeconds <= 0) return false;
    const key = this.seenKey(normalizeTenantId(tenantId));
    const now = Date.now();
    const expiresAt = now + ttlSeconds * 1_000;
    const lua = `
      local now = tonumber(ARGV[1])
      redis.call('zremrangebyscore', KEYS[1], 0, now)
      for i = 3, #ARGV do
        if redis.call('zscore', KEYS[1], ARGV[i]) then return 0 end
      end
      for i = 3, #ARGV do
        redis.call('zadd', KEYS[1], ARGV[2], ARGV[i])
      end
      return 1
    `;
    const result = await this.redis.eval(lua, 1, key, now, expiresAt, ...urls);
    return Number(result) === 1;
  }

  public async releaseUrls(urls: readonly string[], tenantId = DEFAULT_TENANT_ID): Promise<void> {
    if (urls.length === 0) return;
    const key = this.seenKey(normalizeTenantId(tenantId));
    // Keep the compensation atomic so a concurrent claim cannot observe a
    // partially released batch. The key is tenant-scoped (and therefore also
    // safe for native Redis Cluster hash-slot routing).
    const lua = `
      for i = 1, #ARGV do
        redis.call('zrem', KEYS[1], ARGV[i])
      end
      return 1
    `;
    await this.redis.eval(lua, 1, key, ...urls);
  }

  public async markUrlSeen(url: string, ttlSeconds = 2_592_000, tenantId = DEFAULT_TENANT_ID): Promise<void> {
    if (ttlSeconds <= 0) return;
    await this.redis.zadd(this.seenKey(normalizeTenantId(tenantId)), Date.now() + ttlSeconds * 1_000, url);
  }

  public async close(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }

  /**
   * Return a task to its partition only while the caller still owns the
   * current lease. This is the queue-side half of retry fencing: a worker
   * that lost the lease cannot turn a newer worker's RUNNING record back into
   * PENDING (or overwrite its lease token).
   */
  private async enqueueOwnedTask(task: DistributedTaskRecord): Promise<void> {
    const tenantId = normalizeTenantId(task.tenantId);
    const shard = this.taskShard(task.id);
    const normalizedTask = { ...task, tenantId };
    const taskKey = this.taskKey(tenantId, shard, task.id);
    const lua = `
      local raw = redis.call('get', KEYS[1])
      if not raw then return 0 end
      local decodedCurrent, current = pcall(cjson.decode, raw)
      if not decodedCurrent or type(current) ~= 'table' then return 0 end
      if current['workerId'] ~= ARGV[1] or current['leaseId'] ~= ARGV[2] then return 0 end
      if current['state'] ~= 'RUNNING' and current['state'] ~= 'PENDING' and current['state'] ~= 'RETRYING' then return 0 end
      local leaseUntil = redis.call('zscore', KEYS[3], current['id'])
      if leaseUntil and tonumber(leaseUntil) <= tonumber(ARGV[5]) then return 0 end

      local decodedIncoming, incoming = pcall(cjson.decode, ARGV[3])
      if not decodedIncoming or type(incoming) ~= 'table' then return 0 end
      if incoming['state'] ~= 'PENDING' and incoming['state'] ~= 'RETRYING' then return 0 end

      redis.call('set', KEYS[1], ARGV[3])
      redis.call('zadd', KEYS[2], ARGV[4], incoming['id'])
      redis.call('zrem', KEYS[3], incoming['id'])
      return 1
    `;
    const score = PRIORITY_SCORES[normalizedTask.priority] * 1_000_000_000_000 + normalizedTask.createdAt;
    const result = await this.redis.eval(
      lua,
      3,
      taskKey,
      this.pendingKey(tenantId, shard),
      this.processingKey(tenantId, shard),
      normalizedTask.workerId ?? '',
      normalizedTask.leaseId ?? '',
      JSON.stringify(normalizedTask),
      score,
      Date.now(),
    );
    if (Number(result) !== 1) throw new TaskLeaseLostError();
  }

  /**
   * Insert scheduler/migration records only when the current record has no
   * fencing token. Keeping the check and all writes in one script prevents an
   * old token-less worker from racing a dequeue and overwriting its lease.
   */
  private async enqueueUnownedBatch(
    tasks: readonly DistributedTaskRecord[],
    tenantId: string,
    shard: number,
  ): Promise<void> {
    if (tasks.length === 0) return;
    const taskKeys = tasks.map((task) => this.taskKey(tenantId, shard, task.id));
    const lua = `
      for index = 3, #KEYS do
        local raw = redis.call('get', KEYS[index])
        if raw then
          local decoded, current = pcall(cjson.decode, raw)
          if not decoded or type(current) ~= 'table' then return 0 end
          if current['leaseId'] ~= nil then return 0 end
        end
      end
      local argIndex = 1
      local taskIndex = 3
      while argIndex <= #ARGV do
        redis.call('set', KEYS[taskIndex], ARGV[argIndex])
        redis.call('zadd', KEYS[1], ARGV[argIndex + 1], ARGV[argIndex + 2])
        redis.call('zrem', KEYS[2], ARGV[argIndex + 2])
        argIndex = argIndex + 3
        taskIndex = taskIndex + 1
      end
      return 1
    `;
    const args: Array<string | number> = [];
    for (const task of tasks) {
      args.push(
        JSON.stringify(task),
        PRIORITY_SCORES[task.priority] * 1_000_000_000_000 + task.createdAt,
        task.id,
      );
    }
    const result = await this.redis.eval(
      lua,
      taskKeys.length + 2,
      this.pendingKey(tenantId, shard),
      this.processingKey(tenantId, shard),
      ...taskKeys,
      ...args,
    );
    if (Number(result) !== 1) throw new TaskLeaseLostError();
  }

  private taskShard(taskId: string): number {
    let hash = 2_166_136_261;
    for (let index = 0; index < taskId.length; index++) {
      hash ^= taskId.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619);
    }
    return (hash >>> 0) % this.shardCount;
  }

  private normalizeShard(shard: number): number {
    if (!Number.isInteger(shard) || shard < 0 || shard >= this.shardCount) return 0;
    return shard;
  }

  private tag(tenantId: string, shard: number): string {
    return `{t:${tenantId}:s:${this.normalizeShard(shard)}}`;
  }

  private pendingKey(tenantId: string, shard: number): string {
    return `${this.prefix}${this.tag(tenantId, shard)}:queue:pending`;
  }

  private processingKey(tenantId: string, shard: number): string {
    return `${this.prefix}${this.tag(tenantId, shard)}:queue:processing`;
  }

  private taskPrefix(tenantId: string, shard: number): string {
    return `${this.prefix}${this.tag(tenantId, shard)}:task:`;
  }

  private taskKey(tenantId: string, shard: number, taskId: string): string {
    return `${this.taskPrefix(tenantId, shard)}${taskId}`;
  }

  private taskPattern(tenantId: string, shard: number): string {
    return `${this.taskPrefix(tenantId, shard)}*`;
  }

  private metaTag(tenantId: string): string {
    return `{t:${tenantId}:meta}`;
  }

  private seenKey(tenantId: string): string {
    return `${this.prefix}${this.metaTag(tenantId)}:seen_urls`;
  }

  private workerKey(tenantId: string, workerId: string): string {
    return `${this.prefix}${this.metaTag(tenantId)}:worker:${workerId}`;
  }

  private workerPattern(tenantId: string): string {
    return `${this.prefix}${this.metaTag(tenantId)}:worker:*`;
  }

  private async scanKeys(pattern: string, limit: number): Promise<string[]> {
    const boundedLimit = boundedInteger(limit, 1, 10_000, 100);
    const clients: Redis[] = this.redis instanceof Cluster ? this.redis.nodes('master') : [this.redis];
    const keys: string[] = [];
    for (const client of clients) {
      let cursor = '0';
      do {
        const [nextCursor, batch] = await client.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          Math.min(500, Math.max(25, boundedLimit)),
        );
        keys.push(...batch);
        cursor = nextCursor;
      } while (cursor !== '0' && keys.length < boundedLimit);
      if (keys.length >= boundedLimit) break;
    }
    return keys.slice(0, boundedLimit);
  }
}

function standaloneOptions(redisUrl?: string): RedisOptions {
  const options: RedisOptions = {
    lazyConnect: false,
    maxRetriesPerRequest: 3,
  };
  if (!redisUrl) return options;
  const parsed = parseRedisUrl(redisUrl);
  const endpoint = parseClusterNode(redisUrl);
  return {
    ...options,
    host: endpoint.host,
    port: endpoint.port,
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

type RedisClusterOptions = NonNullable<ConstructorParameters<typeof Cluster>[1]>;
type RedisClusterNodeOptions = NonNullable<RedisClusterOptions['redisOptions']>;

function clusterOptions(redisUrl: string | undefined): RedisClusterOptions {
  const options: RedisClusterOptions = {
    enableReadyCheck: true,
    maxRedirections: 16,
    retryDelayOnFailover: 100,
    retryDelayOnClusterDown: 250,
    clusterRetryStrategy: (attempts: number) => Math.min(2_000, 100 + attempts * 100),
    redisOptions: clusterNodeOptions(redisUrl),
  };
  return options;
}

function clusterNodeOptions(redisUrl: string | undefined): RedisClusterNodeOptions {
  const options: RedisClusterNodeOptions = {
    lazyConnect: false,
    maxRetriesPerRequest: 3,
  };
  if (!redisUrl) return options;
  const parsed = parseRedisUrl(redisUrl);
  return {
    ...options,
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

function parseRedisMode(raw: string | undefined, hasClusterNodes: boolean): RedisMode {
  if (raw === undefined || raw.trim() === '') return hasClusterNodes ? 'cluster' : 'standalone';
  const value = raw.trim().toLowerCase();
  if (value === 'standalone' || value === 'cluster') return value;
  throw new Error('REDIS_MODE must be standalone or cluster.');
}

function parseClusterNodes(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === '') return [];
  const values = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (values.length === 0) throw new Error('REDIS_CLUSTER_NODES must contain at least one node.');
  return Object.freeze(values);
}

function parseClusterNode(raw: string): { host: string; port: number } {
  const parsed = parseRedisUrl(raw);
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') throw new Error('Invalid Redis Cluster startup node.');
  const port = Number(parsed.port || 6379);
  if (!parsed.hostname || !Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid Redis Cluster startup node.');
  return { host: parsed.hostname, port };
}

function parseRedisUrl(raw: string): URL {
  const value = raw.includes('://') ? raw : `redis://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Invalid Redis connection URL.');
  }
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') throw new Error('Invalid Redis connection URL.');
  if (!parsed.hostname) throw new Error('Invalid Redis connection URL.');
  return parsed;
}

function parseShardCount(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 16;
  if (!/^\d+$/.test(raw.trim())) throw new Error('REDIS_SHARD_COUNT must be an integer.');
  return Number(raw.trim());
}

function boundedInteger(value: number, minimum: number, maximum: number, fallback: number): number {
  return Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, Math.floor(value)))
    : fallback;
}

/**
 * ioredis resolves a transaction with one tuple per command. A successful
 * network round-trip can therefore still contain command-level errors; those
 * must be surfaced to callers instead of being mistaken for a durable ACK.
 */
async function execMulti(transaction: RedisTransaction): Promise<void> {
  const replies = await transaction.exec();
  if (!replies) throw new Error('Redis transaction was aborted before execution.');
  for (const reply of replies) {
    const [error] = reply;
    if (error) throw error;
  }
}
