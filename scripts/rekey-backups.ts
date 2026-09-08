import { randomUUID } from 'node:crypto';
import { lstat, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ProfileBackupService } from '../src/security/profile-backup.js';
import { SecretVault } from '../src/security/secret-vault.js';

async function main(): Promise<void> {
  const oldKey = process.env.OLD_STUDIO_MASTER_KEY;
  const newKey = process.env.NEW_STUDIO_MASTER_KEY;
  if (!oldKey || !newKey) throw new Error('OLD_STUDIO_MASTER_KEY and NEW_STUDIO_MASTER_KEY are required');
  if (oldKey === newKey) throw new Error('The replacement backup key must differ from the current key');

  const oldVault = new SecretVault(oldKey);
  const newVault = new SecretVault(newKey);
  const service = new ProfileBackupService();
  const backupDir = process.env.BACKUP_DIR || join(process.cwd(), 'data', 'backups');
  const files = (await readdir(backupDir)).filter((file) => file.endsWith('.backup')).sort();
  let completed = 0;
  let failed = 0;

  for (const file of files) {
    const backupPath = join(backupDir, file);
    const info = await lstat(backupPath);
    if (!info.isFile() || info.isSymbolicLink()) {
      failed += 1;
      console.error(`Skipped non-regular backup: ${file}`);
      continue;
    }
    const replacementPath = `${backupPath}.rekey.${randomUUID()}`;
    try {
      await service.rekey(backupPath, oldVault, newVault, replacementPath);
      await rename(replacementPath, backupPath);
      completed += 1;
    } catch (error) {
      failed += 1;
      await rm(replacementPath, { force: true }).catch(() => undefined);
      console.error(`Failed to rekey ${file}: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  console.log(JSON.stringify({ backupDir, completed, failed, total: files.length }));
  if (failed > 0) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Backup rekey failed');
  process.exitCode = 1;
});
