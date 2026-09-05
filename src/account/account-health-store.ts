import * as path from 'node:path';
import { AccountHealth, type AccountHealthSnapshot } from './account-health.js';
import type { ProfileStore } from '../profile/profile-store.js';
import { atomicWriteFile, readJsonWithBackup } from '../storage/atomic-file.js';

export class AccountHealthStore {
  private readonly mutationQueues = new Map<string, Promise<void>>();
  constructor(private readonly profileStore: ProfileStore) {}

  public async getHealth(profileId: string): Promise<AccountHealthSnapshot | null> {
    try {
      const filePath = path.join(this.profileStore.getProfileDir(profileId), 'account-health.json');
      return parseStoredHealth(await readJsonWithBackup<unknown>(filePath));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  public async setHealth(profileId: string, snapshot: AccountHealthSnapshot): Promise<void> {
    await this.runExclusive(profileId, async () => {
      await this.writeHealth(profileId, snapshot);
    });
  }

  public async updateHealth(
    profileId: string,
    update: (current: AccountHealthSnapshot | null) => AccountHealthSnapshot,
  ): Promise<AccountHealthSnapshot> {
    return this.runExclusive(profileId, async () => {
      const next = update(await this.getHealth(profileId));
      await this.writeHealth(profileId, next);
      return next;
    });
  }

  private async writeHealth(profileId: string, snapshot: AccountHealthSnapshot): Promise<void> {
    const canonical = new AccountHealth(() => snapshot.lastUpdated, snapshot).getSnapshot();
    const filePath = path.join(this.profileStore.getProfileDir(profileId), 'account-health.json');
    await atomicWriteFile(filePath, JSON.stringify(canonical, null, 2), { backup: true });
  }

  private async runExclusive<T>(profileId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueues.get(profileId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const queued = previous.catch(() => undefined).then(() => gate);
    this.mutationQueues.set(profileId, queued);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.mutationQueues.get(profileId) === queued) this.mutationQueues.delete(profileId);
    }
  }
}

function parseStoredHealth(value: unknown): AccountHealthSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Account health snapshot must be an object');
  }
  const record = value as Record<string, unknown>;
  const required = ['state', 'reason', 'lastUpdated', 'failureCount', 'nextRetryAvailableAt'];
  if (Object.keys(record).length !== required.length || required.some((key) => !(key in record))) {
    throw new Error('Account health snapshot has an invalid shape');
  }
  if (record.reason !== null && typeof record.reason !== 'string') {
    throw new Error('Account health reason must be a string or null');
  }
  if (record.nextRetryAvailableAt !== null && typeof record.nextRetryAvailableAt !== 'number') {
    throw new Error('Account health nextRetryAvailableAt must be a number or null');
  }
  return new AccountHealth(() => record.lastUpdated as number, record as unknown as AccountHealthSnapshot).getSnapshot();
}
