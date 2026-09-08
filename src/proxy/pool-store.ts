import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { normalizeProxyConfig } from './validator.js';
import { checkProxy } from './checker.js';
import type { ProxyConfig, ProxyCheckResult } from './types.js';
import type { SecretVault } from '../security/secret-vault.js';
import { atomicWriteFile, readJsonWithBackup } from '../storage/atomic-file.js';

export interface ProxyPoolRecord extends ProxyConfig {
  readonly proxyId: string;
  readonly name: string;
  readonly tags: readonly string[];
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastCheckedAt?: number;
  readonly lastCheck?: ProxyCheckResult;
  readonly consecutiveFailures?: number;
  readonly consecutiveSuccesses?: number;
  readonly quarantineUntil?: number;
}

export interface ProxyPoolInput extends ProxyConfig {
  readonly name?: string;
  readonly tags?: readonly string[];
  readonly enabled?: boolean;
}

export class ProxyPoolStore {
  private records = new Map<string, ProxyPoolRecord>();
  private loaded = false;
  private writeTail: Promise<void> = Promise.resolve();
  private cursor = 0;

  public constructor(
    private readonly path: string,
    private readonly vault?: SecretVault,
    private readonly clock: () => number = Date.now,
    private readonly checker: (proxy: ProxyConfig) => Promise<ProxyCheckResult> = checkProxy
  ) {}

  public async list(): Promise<ProxyPoolRecord[]> {
    await this.load();
    return [...this.records.values()].map(cloneProxy).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  public async get(proxyId: string): Promise<ProxyPoolRecord | undefined> {
    await this.load();
    const value = this.records.get(proxyId);
    return value ? cloneProxy(value) : undefined;
  }

  public async create(input: ProxyPoolInput): Promise<ProxyPoolRecord> {
    await this.load();
    const normalized = normalizeProxyConfig(input);
    const now = this.clock();
    const proxyId = `pxy_${randomUUID().slice(0, 8)}`;
    const record: ProxyPoolRecord = {
      proxyId,
      name: input.name?.trim() || proxyId,
      server: normalized.server,
      type: normalized.type,
      ...(normalized.username !== undefined ? { username: normalized.username } : {}),
      ...(normalized.password !== undefined ? { password: normalized.password } : {}),
      ...(normalized.bypass !== undefined ? { bypass: normalized.bypass } : {}),
      tags: [...(input.tags ?? [])].map((tag) => tag.trim()).filter(Boolean).slice(0, 32),
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(proxyId, record);
    await this.persist();
    return cloneProxy(record);
  }

  public async update(proxyId: string, input: Partial<ProxyPoolInput>): Promise<ProxyPoolRecord> {
    await this.load();
    const existing = this.records.get(proxyId);
    if (!existing) throw new Error('PROXY_NOT_FOUND');
    const candidate = normalizeProxyConfig({
      server: input.server ?? existing.server,
      ...(input.username ?? existing.username ? { username: input.username ?? existing.username } : {}),
      ...(input.password ?? existing.password ? { password: input.password ?? existing.password } : {}),
      ...(input.bypass ?? existing.bypass ? { bypass: input.bypass ?? existing.bypass } : {}),
    });
    const connectionChanged = candidate.server !== existing.server
      || candidate.username !== existing.username
      || candidate.password !== existing.password
      || candidate.bypass !== existing.bypass;
    const updated: ProxyPoolRecord = {
      ...withoutProxyHealth(existing),
      server: candidate.server,
      type: candidate.type,
      ...(candidate.username !== undefined ? { username: candidate.username } : {}),
      ...(candidate.password !== undefined ? { password: candidate.password } : {}),
      ...(candidate.bypass !== undefined ? { bypass: candidate.bypass } : {}),
      ...(input.name !== undefined ? { name: input.name.trim() || existing.name } : {}),
      ...(input.tags !== undefined ? { tags: input.tags.map((tag) => tag.trim()).filter(Boolean).slice(0, 32) } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(!connectionChanged && existing.lastCheckedAt !== undefined ? { lastCheckedAt: existing.lastCheckedAt } : {}),
      ...(!connectionChanged && existing.lastCheck !== undefined ? { lastCheck: existing.lastCheck } : {}),
      ...(!connectionChanged && existing.consecutiveFailures !== undefined ? { consecutiveFailures: existing.consecutiveFailures } : {}),
      ...(!connectionChanged && existing.consecutiveSuccesses !== undefined ? { consecutiveSuccesses: existing.consecutiveSuccesses } : {}),
      ...(!connectionChanged && existing.quarantineUntil !== undefined ? { quarantineUntil: existing.quarantineUntil } : {}),
      updatedAt: this.clock(),
    };
    this.records.set(proxyId, updated);
    await this.persist();
    return cloneProxy(updated);
  }

  public async delete(proxyId: string): Promise<boolean> {
    await this.load();
    const deleted = this.records.delete(proxyId);
    if (deleted) await this.persist();
    return deleted;
  }

  public async check(proxyId: string): Promise<ProxyPoolRecord> {
    await this.load();
    const record = this.records.get(proxyId);
    if (!record) throw new Error('PROXY_NOT_FOUND');

    const result = await this.checker(record);
    const now = this.clock();

    let failures = record.consecutiveFailures ?? 0;
    let successes = record.consecutiveSuccesses ?? 0;
    let quarantineUntil = record.quarantineUntil;

    if (result.success) {
      failures = 0;
      if (quarantineUntil !== undefined && now < quarantineUntil) {
        successes = 0;
      } else {
        successes += 1;
        if (successes >= 2) {
          quarantineUntil = undefined;
        }
      }
    } else {
      successes = 0;
      failures += 1;
      const threshold = 3;
      if (failures >= threshold) {
        const base = 5 * 60 * 1000;
        const max = 24 * 60 * 60 * 1000;
        const cooldown = Math.min(max, base * (2 ** (failures - threshold)));
        quarantineUntil = now + cooldown;
      }
    }

    const updated: ProxyPoolRecord = {
      ...withoutProxyHealth(record),
      lastCheckedAt: now,
      lastCheck: result,
      updatedAt: now,
      consecutiveFailures: failures,
      consecutiveSuccesses: successes,
      ...(quarantineUntil !== undefined ? { quarantineUntil } : {}),
    };
    this.records.set(proxyId, updated);
    await this.persist();
    return cloneProxy(updated);
  }

  public async next(tags: readonly string[] = []): Promise<ProxyPoolRecord | undefined> {
    const now = this.clock();
    const records = (await this.list()).filter((record) => record.enabled
      && record.lastCheck?.success === true
      && record.quarantineUntil === undefined
      && tags.every((tag) => record.tags.includes(tag)));
    if (!records.length) return undefined;
    const selected = records[this.cursor % records.length];
    this.cursor = (this.cursor + 1) % Number.MAX_SAFE_INTEGER;
    return selected ? cloneProxy(selected) : undefined;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.path)) return;
    const raw = await readJsonWithBackup<ProxyPoolRecord[]>(this.path);
    let needsMigration = false;
    for (const item of raw) {
      if (this.vault && item.password && !this.vault.isEncrypted(item.password)) needsMigration = true;
      this.records.set(item.proxyId, {
        ...item,
        ...(item.password !== undefined ? { password: this.vault?.decrypt(item.password) ?? item.password } : {}),
      });
    }
    if (needsMigration) await this.persist();
  }

  private persist(): Promise<void> {
    const operation = this.writeTail.then(async () => {
      const records = [...this.records.values()].map((item) => ({
        ...item,
        ...(item.password !== undefined ? { password: this.vault?.encrypt(item.password) ?? item.password } : {}),
      }));
      await atomicWriteFile(this.path, JSON.stringify(records, null, 2));
    });
    this.writeTail = operation.catch(() => undefined);
    return operation;
  }
}

function cloneProxy(value: ProxyPoolRecord): ProxyPoolRecord {
  return { ...value, tags: [...value.tags], ...(value.lastCheck ? { lastCheck: { ...value.lastCheck } } : {}) };
}

function withoutProxyHealth(value: ProxyPoolRecord): ProxyPoolRecord {
  return {
    proxyId: value.proxyId,
    name: value.name,
    server: value.server,
    ...(value.type !== undefined ? { type: value.type } : {}),
    ...(value.username !== undefined ? { username: value.username } : {}),
    ...(value.password !== undefined ? { password: value.password } : {}),
    ...(value.bypass !== undefined ? { bypass: value.bypass } : {}),
    tags: [...value.tags],
    enabled: value.enabled,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}
