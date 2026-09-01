import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface AtomicWriteOptions {
  readonly mode?: number;
  readonly backup?: boolean;
}

/**
 * Crash-safe small-state persistence: write and fsync a sibling temp file,
 * optionally retain the last good copy, then atomically replace the target.
 */
export async function atomicWriteFile(path: string, data: string | Uint8Array, options: AtomicWriteOptions = {}): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const mode = options.mode ?? 0o600;
  const handle = await open(temporary, 'wx', mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (options.backup !== false) {
      await stat(path);
      await copyFile(path, `${path}.bak`);
    }
  } catch {
    // No previous version to back up.
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readJsonWithBackup<T>(path: string): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (primaryError) {
    try {
      return JSON.parse(await readFile(`${path}.bak`, 'utf8')) as T;
    } catch {
      throw primaryError;
    }
  }
}
