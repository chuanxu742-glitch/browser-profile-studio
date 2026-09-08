import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, relative, sep } from 'node:path';
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { SecretVault } from './secret-vault.js';

const SAFE_PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_MANIFEST_FILES = 50_000;
const MAX_ENCODED_FILE_CHARS = 180 * 1024 * 1024;

const BackupFileSchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  payload: z.string().max(MAX_ENCODED_FILE_CHARS),
}).strict();

export const BackupManifestSchema = z.object({
  version: z.literal(1),
  profileId: z.string().regex(SAFE_PROFILE_ID),
  createdAt: z.string().datetime({ offset: true }),
  files: z.record(z.string().min(1).max(1_024), BackupFileSchema),
}).strict().superRefine((manifest, context) => {
  if (Object.keys(manifest.files).length > MAX_MANIFEST_FILES) {
    context.addIssue({ code: 'custom', message: `Backup contains more than ${MAX_MANIFEST_FILES} files` });
  }
});

export type BackupManifest = z.infer<typeof BackupManifestSchema>;

export interface ProfileBackupServiceOptions {
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxManifestBytes?: number;
}

interface ScanBudget {
  files: number;
  bytes: number;
}

export class ProfileBackupService {
  private readonly maxFiles: number;
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;
  private readonly maxManifestBytes: number;
  private readonly restoreQueues = new Map<string, Promise<void>>();

  public constructor(options: ProfileBackupServiceOptions = {}) {
    this.maxFiles = boundedLimit(options.maxFiles ?? 20_000, 1, MAX_MANIFEST_FILES, 'maxFiles');
    this.maxFileBytes = boundedLimit(options.maxFileBytes ?? 128 * 1024 * 1024, 1, 128 * 1024 * 1024, 'maxFileBytes');
    this.maxTotalBytes = boundedLimit(options.maxTotalBytes ?? 512 * 1024 * 1024, 1, 512 * 1024 * 1024, 'maxTotalBytes');
    this.maxManifestBytes = boundedLimit(options.maxManifestBytes ?? 768 * 1024 * 1024, 1, 768 * 1024 * 1024, 'maxManifestBytes');
    if (this.maxFileBytes > this.maxTotalBytes) throw new Error('maxFileBytes cannot exceed maxTotalBytes');
  }

  /** Create one authenticated, encrypted manifest for a server-owned profile directory. */
  public async backup(profileId: string, profileDir: string, backupPath: string, vault: SecretVault): Promise<void> {
    validateProfileId(profileId);
    const rootInfo = await lstat(profileDir);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Profile backup source must be a real directory');

    const files: Record<string, { sha256: string; payload: string }> = {};
    await this.scanDirectory(profileDir, profileDir, files, { files: 0, bytes: 0 });
    const sortedFiles = Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)));
    const manifest: BackupManifest = {
      version: 1,
      profileId,
      createdAt: new Date().toISOString(),
      files: sortedFiles,
    };
    const serialized = JSON.stringify(BackupManifestSchema.parse(manifest));
    this.assertManifestSize(serialized);
    await this.writeAtomically(backupPath, vault.encrypt(serialized));
  }

  /** Restore a verified backup through a crash-recoverable directory swap. */
  public async restore(backupPath: string, destDir: string, vault: SecretVault, expectedProfileId?: string): Promise<void> {
    if (expectedProfileId !== undefined) validateProfileId(expectedProfileId);
    await this.runRestoreExclusive(destDir, async () => {
      const manifest = await this.readManifest(backupPath, vault);
      if (expectedProfileId !== undefined && manifest.profileId !== expectedProfileId) {
        throw new Error(`Profile ID mismatch: expected ${expectedProfileId}, found ${manifest.profileId}`);
      }

      await this.recoverInterruptedSwap(destDir);
      const stagingDir = `${destDir}.restore-staging`;
      await rm(stagingDir, { recursive: true, force: true });
      await mkdir(stagingDir, { recursive: false, mode: 0o700 });
      let installed = false;
      const budget: ScanBudget = { files: 0, bytes: 0 };
      try {
        for (const [relPath, fileInfo] of Object.entries(manifest.files).sort(([left], [right]) => left.localeCompare(right))) {
          validateRelativePath(relPath);
          const buffer = decodeBase64(fileInfo.payload, relPath);
          this.consumeBudget(budget, buffer.byteLength, relPath);
          const hash = createHash('sha256').update(buffer).digest('hex');
          if (hash !== fileInfo.sha256) throw new Error(`Tamper detected: SHA-256 mismatch for ${relPath}`);
          const fullPath = join(stagingDir, ...relPath.split('/'));
          await mkdir(dirname(fullPath), { recursive: true, mode: 0o700 });
          await writeFile(fullPath, buffer, { flag: 'wx', mode: 0o600 });
        }
        await this.replaceDirectoryAtomically(stagingDir, destDir);
        installed = true;
      } finally {
        if (!installed) await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }

  /** Verify and re-encrypt a backup entirely in memory under a replacement key. */
  public async rekey(
    backupPath: string,
    oldVault: SecretVault,
    newVault: SecretVault,
    outputPath: string,
  ): Promise<void> {
    const manifest = await this.readManifest(backupPath, oldVault);
    const budget: ScanBudget = { files: 0, bytes: 0 };
    for (const [relPath, fileInfo] of Object.entries(manifest.files)) {
      validateRelativePath(relPath);
      const buffer = decodeBase64(fileInfo.payload, relPath);
      this.consumeBudget(budget, buffer.byteLength, relPath);
      const hash = createHash('sha256').update(buffer).digest('hex');
      if (hash !== fileInfo.sha256) throw new Error(`Tamper detected: SHA-256 mismatch for ${relPath}`);
    }
    const serialized = JSON.stringify(manifest);
    this.assertManifestSize(serialized);
    await this.writeAtomically(outputPath, newVault.encrypt(serialized));
  }

  private async scanDirectory(
    rootDir: string,
    currentDir: string,
    files: Record<string, { sha256: string; payload: string }>,
    budget: ScanBudget,
  ): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      const relPath = relative(rootDir, fullPath).split(sep).join('/');
      validateRelativePath(relPath);
      const info = await lstat(fullPath);
      if (info.isSymbolicLink()) throw new Error(`Symlinks are not allowed: ${relPath}`);
      if (info.isDirectory()) {
        await this.scanDirectory(rootDir, fullPath, files, budget);
        continue;
      }
      if (!info.isFile()) throw new Error(`Unsupported profile entry: ${relPath}`);
      if (info.size > this.maxFileBytes) throw new Error(`Profile file exceeds the backup size limit: ${relPath}`);
      const buffer = await readFile(fullPath);
      this.consumeBudget(budget, buffer.byteLength, relPath);
      files[relPath] = {
        sha256: createHash('sha256').update(buffer).digest('hex'),
        payload: buffer.toString('base64'),
      };
    }
  }

  private consumeBudget(budget: ScanBudget, bytes: number, relPath: string): void {
    if (bytes > this.maxFileBytes) throw new Error(`Profile file exceeds the backup size limit: ${relPath}`);
    budget.files += 1;
    budget.bytes += bytes;
    if (budget.files > this.maxFiles) throw new Error('Profile backup exceeds the file-count limit');
    if (!Number.isSafeInteger(budget.bytes) || budget.bytes > this.maxTotalBytes) {
      throw new Error('Profile backup exceeds the total byte limit');
    }
  }

  private async readManifest(backupPath: string, vault: SecretVault): Promise<BackupManifest> {
    const info = await lstat(backupPath);
    const maxStoredBytes = Math.ceil(this.maxManifestBytes * 1.5) + 4_096;
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Backup must be a regular file');
    if (info.size > maxStoredBytes) throw new Error('Encrypted backup exceeds the manifest size limit');
    const encrypted = await readFile(backupPath, 'utf8');
    if (!vault.isEncrypted(encrypted)) throw new Error('Backup manifest is not encrypted');
    const serialized = vault.decrypt(encrypted);
    this.assertManifestSize(serialized);
    return BackupManifestSchema.parse(JSON.parse(serialized));
  }

  private assertManifestSize(serialized: string): void {
    if (Buffer.byteLength(serialized, 'utf8') > this.maxManifestBytes) {
      throw new Error('Backup manifest exceeds the configured size limit');
    }
  }

  private async writeAtomically(filePath: string, data: string): Promise<void> {
    const tempPath = `${filePath}.tmp.${randomUUID()}`;
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    await writeFile(tempPath, data, { encoding: 'utf8', mode: 0o600 });
    try {
      await rename(tempPath, filePath);
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  private async recoverInterruptedSwap(dest: string): Promise<void> {
    const previous = `${dest}.restore-previous`;
    const destinationExists = await pathExists(dest);
    const previousExists = await pathExists(previous);
    if (!destinationExists && previousExists) await rename(previous, dest);
    else if (destinationExists && previousExists) await rm(previous, { recursive: true, force: true });
    await rm(`${dest}.restore-staging`, { recursive: true, force: true });
  }

  private async replaceDirectoryAtomically(src: string, dest: string): Promise<void> {
    const previous = `${dest}.restore-previous`;
    const destinationExists = await pathExists(dest);
    if (destinationExists) await rename(dest, previous);
    try {
      await rename(src, dest);
    } catch (error) {
      if (destinationExists) await rename(previous, dest).catch(() => undefined);
      throw error;
    }
    if (destinationExists) await rm(previous, { recursive: true, force: true });
  }

  private async runRestoreExclusive<T>(destination: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.restoreQueues.get(destination) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const queued = previous.catch(() => undefined).then(() => gate);
    this.restoreQueues.set(destination, queued);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.restoreQueues.get(destination) === queued) this.restoreQueues.delete(destination);
    }
  }
}

function validateProfileId(profileId: string): void {
  if (!SAFE_PROFILE_ID.test(profileId)) throw new Error('Invalid profile ID');
}

function validateRelativePath(relPath: string): void {
  const parts = relPath.split('/');
  if (
    relPath.length === 0
    || relPath.length > 1_024
    || relPath.startsWith('/')
    || relPath.includes('\\')
    || relPath.includes(':')
    || relPath.includes('\0')
    || parts.some((part) => part.length === 0 || part === '.' || part === '..' || part.length > 255)
  ) {
    throw new Error(`Path traversal rejected: ${relPath}`);
  }
}

function decodeBase64(value: string, relPath: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`Invalid backup payload encoding for ${relPath}`);
  }
  const buffer = Buffer.from(value, 'base64');
  if (buffer.toString('base64') !== value) throw new Error(`Invalid backup payload encoding for ${relPath}`);
  return buffer;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function boundedLimit(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a safe integer from ${minimum} to ${maximum}`);
  }
  return value;
}
