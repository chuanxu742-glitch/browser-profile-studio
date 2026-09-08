import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BrowserStorageState } from './types.js';
import type { SecretVault } from '../security/secret-vault.js';


export interface VersionedCheckpointStoreOptions {
  /** Maximum number of checkpoints to keep per profile (1-1000) */
  readonly maxCheckpoints?: number;
  /** Optional vault for encrypting checkpoints at rest */
  readonly vault?: SecretVault;
  /** Maximum unencrypted JSON bytes accepted per checkpoint (1-128 MiB). */
  readonly maxCheckpointBytes?: number;
}

export class CheckpointConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckpointConflictError';
  }
}

export class CheckpointCorruptionError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'CheckpointCorruptionError';
  }
}

const BoundedString = z.string().max(1_048_576);
const KeyPathSchema = z.union([
  z.string().max(4_096),
  z.array(z.string().max(4_096)).max(128),
  z.null(),
]);
const BrowserStorageStateSchema = z.object({
  cookies: z.array(z.object({
    name: z.string().max(4_096),
    value: BoundedString,
    domain: z.string().max(8_192),
    path: z.string().max(8_192),
    expires: z.number().finite().optional(),
    httpOnly: z.boolean().optional(),
    secure: z.boolean().optional(),
    sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
  }).strict()).max(20_000),
  origins: z.array(z.object({
    origin: z.string().max(8_192),
    localStorage: z.array(z.object({
      name: z.string().max(4_096),
      value: BoundedString,
    }).strict()).max(20_000),
    indexedDB: z.array(z.object({
      name: z.string().max(4_096),
      version: z.number().safe().nonnegative(),
      stores: z.array(z.object({
        name: z.string().max(4_096),
        keyPath: KeyPathSchema.optional(),
        autoIncrement: z.boolean(),
        indexes: z.array(z.object({
          name: z.string().max(4_096),
          keyPath: KeyPathSchema,
          unique: z.boolean(),
          multiEntry: z.boolean(),
        }).strict()).max(10_000),
        records: z.array(z.object({
          key: z.unknown(),
          value: z.unknown(),
        }).strict()).max(100_000),
      }).strict()).max(10_000),
    }).strict()).max(1_000).optional(),
  }).strict()).max(1_000),
  credentials: z.array(z.unknown()).max(1_000).optional(),
}).strict().transform((state) => state as unknown as BrowserStorageState);

export class VersionedCheckpointStore {
  private readonly maxCheckpoints: number;
  private readonly vault: SecretVault | undefined;
  private readonly maxCheckpointBytes: number;
  private readonly maxStoredBytes: number;

  constructor(
    private readonly baseDir: string,
    options: VersionedCheckpointStoreOptions = {},
  ) {
    const max = options.maxCheckpoints ?? 10;
    if (!Number.isSafeInteger(max) || max < 1 || max > 1000) {
      throw new Error(`Invalid maxCheckpoints: ${max}`);
    }
    const maxCheckpointBytes = options.maxCheckpointBytes ?? 32 * 1024 * 1024;
    if (
      !Number.isSafeInteger(maxCheckpointBytes)
      || maxCheckpointBytes < 1024 * 1024
      || maxCheckpointBytes > 128 * 1024 * 1024
    ) {
      throw new Error(`Invalid maxCheckpointBytes: ${maxCheckpointBytes}`);
    }
    this.maxCheckpoints = max;
    this.maxCheckpointBytes = maxCheckpointBytes;
    this.maxStoredBytes = Math.ceil(maxCheckpointBytes * 1.5) + 4_096;
    this.vault = options.vault;
  }

  private parseState(serialized: string): BrowserStorageState {
    try {
      if (Buffer.byteLength(serialized, 'utf8') > this.maxStoredBytes) {
        throw new Error('Stored checkpoint exceeds the configured byte limit');
      }
      let data = serialized;
      if (this.vault && this.vault.isEncrypted(data)) {
        data = this.vault.decrypt(data);
      } else if (!this.vault && serialized.startsWith('enc:v1:')) {
        throw new Error('Data is encrypted but no vault was provided');
      }
      if (Buffer.byteLength(data, 'utf8') > this.maxCheckpointBytes) {
        throw new Error('Checkpoint JSON exceeds the configured byte limit');
      }
      return BrowserStorageStateSchema.parse(JSON.parse(data));
    } catch (error) {
      throw new CheckpointCorruptionError(
        `Failed to parse or validate checkpoint: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
  }

  private async writeAtomic(filePath: string, data: string): Promise<void> {
    const tempPath = `${filePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tempPath, data, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tempPath, filePath);
    } finally {
      await fs.unlink(tempPath).catch(() => {});
    }
  }

  private async writeAtomicExclusive(tempFilePath: string, finalFilePath: string): Promise<boolean> {
    try {
      await fs.link(tempFilePath, finalFilePath);
      return true;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        return false;
      }
      if (code === 'EXDEV' || code === 'EPERM' || code === 'ENOTSUP') {
        try {
          await fs.copyFile(tempFilePath, finalFilePath, fs.constants.COPYFILE_EXCL);
          return true;
        } catch (copyErr: unknown) {
          if ((copyErr as NodeJS.ErrnoException).code === 'EEXIST') return false;
          throw copyErr;
        }
      }
      throw err;
    } finally {
      await fs.unlink(tempFilePath).catch(() => {});
    }
  }

  private validateProfileId(profileId: string): void {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(profileId)) {
      throw new Error(`Invalid profile ID: ${profileId}`);
    }
  }

  private validateVersion(version: number | undefined): void {
    if (version !== undefined && (!Number.isSafeInteger(version) || version < 0)) {
      throw new Error(`Invalid version: ${version}`);
    }
  }

  /**
   * Save a new checkpoint. If expectedVersion is provided, enforces CAS.
   */
  public async saveState(
    profileId: string,
    state: BrowserStorageState,
    expectedVersion?: number
  ): Promise<number> {
    this.validateProfileId(profileId);
    this.validateVersion(expectedVersion);
    const profileDir = path.join(this.baseDir, profileId);
    await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });

    const currentVersion = await this.getLatestVersion(profileId);
    if (expectedVersion !== undefined && currentVersion !== expectedVersion) {
      throw new CheckpointConflictError(
        `Optimistic concurrency failure: expected version ${expectedVersion} but found ${currentVersion}`,
      );
    }

    const occupiedVersions = await this.getAvailableVersions(profileId);
    const highestOccupiedVersion = occupiedVersions[0] ?? 0;
    const newVersion = Math.max(currentVersion, highestOccupiedVersion) + 1;
    this.validateVersion(newVersion);
    const validatedState = BrowserStorageStateSchema.parse(state);
    let data = JSON.stringify(validatedState);
    if (Buffer.byteLength(data, 'utf8') > this.maxCheckpointBytes) {
      throw new Error('Checkpoint JSON exceeds the configured byte limit');
    }
    if (this.vault) data = this.vault.encrypt(data);

    const checkpointPath = path.join(profileDir, `checkpoint_${newVersion}.json`);
    const tempPath = path.join(profileDir, `checkpoint_${newVersion}_${randomUUID()}.tmp`);
    await fs.writeFile(tempPath, data, { encoding: 'utf8', mode: 0o600 });

    const success = await this.writeAtomicExclusive(tempPath, checkpointPath);
    if (!success) {
      throw new CheckpointConflictError(
        `Optimistic concurrency failure: checkpoint version ${newVersion} already exists.`
      );
    }

    const latestPath = path.join(profileDir, 'latest');
    await this.writeAtomic(latestPath, String(newVersion));

    await this.prune(profileId);

    return newVersion;
  }

  /**
   * Retrieve the latest state. Recovers automatically if the `latest` pointer
   * or the pointed file is corrupted.
   */
  public async getLatestState(
    profileId: string,
  ): Promise<{ version: number; state: BrowserStorageState } | null> {
    this.validateProfileId(profileId);
    const profileDir = path.join(this.baseDir, profileId);
    try {
      await fs.access(profileDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }

    const versions = await this.getAvailableVersions(profileId);
    for (const version of versions) {
      const state = await this.tryReadCheckpoint(profileId, version);
      if (!state) continue;
      const latestPath = path.join(profileDir, 'latest');
      await this.writeAtomic(latestPath, String(version)).catch(() => undefined);
      return { version, state };
    }
    return null;
  }

  /**
   * Determine the current latest version number.
   * Scans and verifies if the 'latest' pointer is corrupted.
   */
  public async getLatestVersion(profileId: string): Promise<number> {
    this.validateProfileId(profileId);
    const result = await this.getLatestState(profileId);
    return result ? result.version : 0;
  }

  private async tryReadCheckpoint(profileId: string, version: number): Promise<BrowserStorageState | null> {
    this.validateProfileId(profileId);
    this.validateVersion(version);
    const checkpointPath = path.join(this.baseDir, profileId, `checkpoint_${version}.json`);
    try {
      const info = await fs.lstat(checkpointPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > this.maxStoredBytes) return null;
      return this.parseState(await fs.readFile(checkpointPath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof CheckpointCorruptionError) {
        return null;
      }
      throw error;
    }
  }

  private async getAvailableVersions(profileId: string): Promise<number[]> {
    this.validateProfileId(profileId);
    const profileDir = path.join(this.baseDir, profileId);
    let files: string[];
    try {
      files = await fs.readdir(profileDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }

    const versions: number[] = [];
    for (const file of files) {
      const match = /^checkpoint_(\d+)\.json$/.exec(file);
      if (match) {
        const v = parseInt(match[1]!, 10);
        if (Number.isSafeInteger(v) && v >= 0) {
          versions.push(v);
        }
      }
    }

    // Sort descending
    versions.sort((a, b) => b - a);
    return versions;
  }

  private async prune(profileId: string): Promise<void> {
    this.validateProfileId(profileId);
    if (this.maxCheckpoints <= 0) return;

    const profileDir = path.join(this.baseDir, profileId);
    const versions = await this.getAvailableVersions(profileId);

    // Keep up to maxCheckpoints. Since versions are sorted descending,
    // we keep the first `maxCheckpoints` elements.
    const toDelete = versions.slice(this.maxCheckpoints);
    for (const version of toDelete) {
      try {
        await fs.unlink(path.join(profileDir, `checkpoint_${version}.json`));
      } catch {
        // ignore errors during cleanup
      }
    }
  }
}
