import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemorySharedStateStore } from '../src/distributed/account-placement.js';
import { MemoryLeaseManager } from '../src/distributed/profile-lease.js';
import { ProfileStore } from '../src/profile/profile-store.js';
import { VersionedCheckpointStore } from '../src/profile/versioned-checkpoint-store.js';

export interface SoakConfig {
  durationMs: number;
  accountCount: number;
  concurrency: number;
  checkpointFrequency: number;
  memoryCeilingMb: number;
  fileCeilingMb: number;
}

export interface SoakMetrics {
  cyclesCompleted: number;
  missedCycles: number;
  errors: number;
  maxMemoryMb: number;
  maxDirSizeKb: number;
  leaseLeaks: number;
}

function positiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function envInteger(name: string, fallback: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return positiveInteger(Number(raw), name, maximum);
}

export class AccountSoakHarness {
  readonly config: SoakConfig;
  readonly metrics: SoakMetrics = {
    cyclesCompleted: 0,
    missedCycles: 0,
    errors: 0,
    maxMemoryMb: 0,
    maxDirSizeKb: 0,
    leaseLeaks: 0,
  };

  private stopped = false;
  private started = false;
  private rootDir: string | undefined;
  private profileStore: ProfileStore | undefined;
  private leaseManager: MemoryLeaseManager | undefined;
  private checkpointStore: VersionedCheckpointStore | undefined;
  private readonly stateStore = new InMemorySharedStateStore<{ cycle: number }>();
  private readonly activeLeases = new Set<string>();

  constructor(config: Partial<SoakConfig> = {}) {
    const durationMs = positiveInteger(config.durationMs ?? 5_000, 'durationMs', 72 * 60 * 60 * 1_000);
    const accountCount = positiveInteger(config.accountCount ?? 10, 'accountCount', 100_000);
    const concurrency = positiveInteger(config.concurrency ?? 2, 'concurrency', 1_000);
    if (concurrency > accountCount) throw new Error('concurrency cannot exceed accountCount');
    this.config = {
      durationMs,
      accountCount,
      concurrency,
      checkpointFrequency: positiveInteger(config.checkpointFrequency ?? 5, 'checkpointFrequency', 1_000_000),
      memoryCeilingMb: positiveInteger(config.memoryCeilingMb ?? 512, 'memoryCeilingMb', 1_048_576),
      fileCeilingMb: positiveInteger(config.fileCeilingMb ?? 50, 'fileCeilingMb', 1_048_576),
    };
  }

  async start(): Promise<SoakMetrics> {
    if (this.started) throw new Error('AccountSoakHarness instances can only be started once');
    this.started = true;
    this.rootDir = await mkdtemp(join(tmpdir(), 'account-soak-'));
    this.profileStore = new ProfileStore(this.rootDir);
    await this.profileStore.init();
    this.checkpointStore = new VersionedCheckpointStore(join(this.rootDir, 'checkpoints'), { maxCheckpoints: 5 });
    this.leaseManager = new MemoryLeaseManager(30_000);

    const timer = setTimeout(() => this.stop(), this.config.durationMs);
    try {
      await Promise.all(Array.from({ length: this.config.concurrency }, (_, workerId) => this.runWorker(workerId)));
    } finally {
      clearTimeout(timer);
    }
    await this.verifyCleanup();
    return { ...this.metrics };
  }

  stop(): void {
    this.stopped = true;
  }

  async cleanup(): Promise<void> {
    this.stop();
    await this.leaseManager?.shutdown().catch(() => undefined);
    if (this.rootDir !== undefined) await rm(this.rootDir, { recursive: true, force: true });
  }

  private async runWorker(workerId: number): Promise<void> {
    const profileStore = this.profileStore!;
    const leaseManager = this.leaseManager!;
    const accountIndexes = Array.from({ length: this.config.accountCount }, (_, index) => index)
      .filter((index) => index % this.config.concurrency === workerId);
    let cycle = 0;

    while (!this.stopped) {
      const accountIndex = accountIndexes[cycle % accountIndexes.length]!;
      const profileId = `soak-a${accountIndex}`;
      const tenantId = `tenant-${workerId}`;
      try {
        await profileStore.createProfile({ name: profileId, profileId });
        const profile = await profileStore.getProfile(profileId);
        if (profile?.name !== profileId) throw new Error('Cross-account state leak detected');

        const state = await this.stateStore.get(tenantId, profileId);
        if (!await this.stateStore.compareAndSet(tenantId, profileId, state?.version ?? 0, { cycle })) {
          this.metrics.missedCycles += 1;
          throw new Error('Unexpected account state CAS conflict');
        }

        const lease = await leaseManager.acquire(tenantId, profileId);
        const leaseKey = JSON.stringify([tenantId, profileId, lease.leaseToken]);
        this.activeLeases.add(leaseKey);
        try {
          await leaseManager.renew(tenantId, profileId, lease.leaseToken);
          if (cycle > 0 && cycle % this.config.checkpointFrequency === 0) {
            const storageState = {
              cookies: [{ name: 'soak', value: `${workerId}:${cycle}`, domain: 'example.test', path: '/' }],
              origins: [],
            };
            const expectedVersion = await this.checkpointStore!.getLatestVersion(profileId);
            await this.checkpointStore!.saveState(profileId, storageState, expectedVersion);
            await profileStore.saveStorageState(profileId, storageState);
          }
        } finally {
          await leaseManager.release(tenantId, profileId, lease.leaseToken);
          this.activeLeases.delete(leaseKey);
        }

        await profileStore.deleteProfile(profileId);
        await profileStore.purgeDeletedProfile(profileId);
        this.metrics.cyclesCompleted += 1;
        await this.recordResourceUsage(cycle);
      } catch (error: unknown) {
        if (!this.stopped) {
          this.metrics.errors += 1;
          this.stop();
          process.stderr.write(`${JSON.stringify({
            event: 'worker_error',
            workerId,
            error: error instanceof Error ? error.message : String(error),
          })}\n`);
        }
      }
      cycle += 1;
    }
  }

  private async recordResourceUsage(cycle: number): Promise<void> {
    const memoryMb = process.memoryUsage().rss / 1024 / 1024;
    this.metrics.maxMemoryMb = Math.max(this.metrics.maxMemoryMb, memoryMb);
    if (memoryMb > this.config.memoryCeilingMb) {
      throw new Error(`Memory ceiling exceeded: ${memoryMb.toFixed(2)} MiB > ${this.config.memoryCeilingMb} MiB`);
    }
    if (cycle % 10 === 0) {
      const sizeKb = await this.getDirSize(this.rootDir!) / 1024;
      this.metrics.maxDirSizeKb = Math.max(this.metrics.maxDirSizeKb, sizeKb);
      if (sizeKb > this.config.fileCeilingMb * 1024) {
        throw new Error(`File ceiling exceeded: ${sizeKb.toFixed(2)} KiB > ${this.config.fileCeilingMb * 1024} KiB`);
      }
    }
  }

  private async verifyCleanup(): Promise<void> {
    if (this.activeLeases.size > 0) {
      this.metrics.leaseLeaks += this.activeLeases.size;
      throw new Error(`Lease leak detected: ${this.activeLeases.size} leases still active`);
    }
    const remainingProfiles = await this.profileStore!.listProfiles();
    if (remainingProfiles.length > 0) throw new Error(`Profile cleanup failed: ${remainingProfiles.length} profiles remain`);
    await this.leaseManager!.shutdown();
  }

  private async getDirSize(directory: string): Promise<number> {
    let size = 0;
    try {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const fullPath = join(directory, entry.name);
        size += entry.isDirectory() ? await this.getDirSize(fullPath) : (await stat(fullPath)).size;
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return size;
  }
}

async function main(): Promise<void> {
  const longMode = process.env.LONG_MODE === 'true';
  const durationMs = envInteger('SOAK_DURATION_MS', longMode ? 24 * 60 * 60 * 1_000 : 5_000, 72 * 60 * 60 * 1_000);
  if (longMode && durationMs < 24 * 60 * 60 * 1_000) {
    throw new Error('LONG_MODE requires SOAK_DURATION_MS between 24 and 72 hours');
  }
  const harness = new AccountSoakHarness({
    durationMs,
    accountCount: envInteger('SOAK_ACCOUNTS', 10, 100_000),
    concurrency: envInteger('SOAK_CONCURRENCY', 2, 1_000),
    checkpointFrequency: envInteger('SOAK_CHECKPOINT_FREQ', 5, 1_000_000),
    memoryCeilingMb: envInteger('SOAK_MEM_CEILING_MB', 512, 1_048_576),
    fileCeilingMb: envInteger('SOAK_FILE_CEILING_MB', 50, 1_048_576),
  });
  process.stdout.write(`${JSON.stringify({ event: 'start', config: harness.config })}\n`);
  const progressMs = envInteger('SOAK_PROGRESS_MS', 60_000, 60 * 60 * 1_000);
  const progressTimer = setInterval(() => {
    process.stdout.write(`${JSON.stringify({ event: 'progress', metrics: harness.metrics })}\n`);
  }, progressMs);
  progressTimer.unref();
  process.once('SIGINT', () => harness.stop());
  process.once('SIGTERM', () => harness.stop());

  try {
    const metrics = await harness.start();
    const success = metrics.errors === 0 && metrics.leaseLeaks === 0 && metrics.missedCycles === 0;
    process.stdout.write(`${JSON.stringify({ event: 'final', metrics, success })}\n`);
    if (!success) process.exitCode = 1;
  } finally {
    clearInterval(progressTimer);
    await harness.cleanup();
  }
}

if (process.argv[1]?.endsWith('run-account-soak.ts') || process.argv[1]?.endsWith('run-account-soak.js')) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({ event: 'error', error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  });
}
