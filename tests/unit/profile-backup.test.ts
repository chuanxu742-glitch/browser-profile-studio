import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProfileBackupService } from '../../src/security/profile-backup.js';
import { SecretVault } from '../../src/security/secret-vault.js';

describe('ProfileBackupService', () => {
  let tempDir: string;
  let service: ProfileBackupService;
  let vault: SecretVault;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'profile-backup-test-'));
    service = new ProfileBackupService();
    vault = new SecretVault('super-secret-key-1234567890123456');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('encrypts and restores a complete profile', async () => {
    const profileDir = join(tempDir, 'profile1');
    await mkdir(join(profileDir, 'Preferences'), { recursive: true });
    await writeFile(join(profileDir, 'Preferences', 'config.json'), JSON.stringify({ theme: 'dark' }));
    await writeFile(join(profileDir, 'data.bin'), randomBytes(64));

    const backupPath = join(tempDir, 'profile.backup');
    await service.backup('profile-1', profileDir, backupPath, vault);
    expect((await readFile(backupPath, 'utf8')).startsWith('enc:v1:')).toBe(true);

    const restoreDir = join(tempDir, 'restored-profile1');
    await service.restore(backupPath, restoreDir, vault, 'profile-1');
    expect(JSON.parse(await readFile(join(restoreDir, 'Preferences', 'config.json'), 'utf8'))).toEqual({ theme: 'dark' });
    expect(await readFile(join(restoreDir, 'data.bin'))).toEqual(await readFile(join(profileDir, 'data.bin')));
  });

  it('rejects authenticated manifests whose file digest was altered', async () => {
    const profileDir = join(tempDir, 'profile-tamper');
    await mkdir(profileDir);
    await writeFile(join(profileDir, 'test.txt'), 'hello world');
    const backupPath = join(tempDir, 'tampered.backup');
    await service.backup('profile-1', profileDir, backupPath, vault);

    const manifest = JSON.parse(vault.decrypt(await readFile(backupPath, 'utf8'))) as {
      files: Record<string, { sha256: string }>;
    };
    manifest.files['test.txt']!.sha256 = '0'.repeat(64);
    await writeFile(backupPath, vault.encrypt(JSON.stringify(manifest)));

    await expect(service.restore(backupPath, join(tempDir, 'restore'), vault)).rejects.toThrow(
      'Tamper detected: SHA-256 mismatch for test.txt',
    );
  });

  it('rejects traversal entries before writing a staging file', async () => {
    const backupPath = join(tempDir, 'malicious.backup');
    const maliciousManifest = {
      version: 1,
      profileId: 'malicious',
      createdAt: new Date().toISOString(),
      files: {
        '../escaped.txt': {
          sha256: '0'.repeat(64),
          payload: Buffer.from('bad').toString('base64'),
        },
      },
    };
    await writeFile(backupPath, vault.encrypt(JSON.stringify(maliciousManifest)));

    await expect(service.restore(backupPath, join(tempDir, 'restore'), vault)).rejects.toThrow('Path traversal rejected');
  });

  it('rejects symlinks in the source profile', async () => {
    const profileDir = join(tempDir, 'profile-symlink');
    await mkdir(profileDir);
    await writeFile(join(profileDir, 'real.txt'), 'real');
    try {
      await symlink('real.txt', join(profileDir, 'link.txt'));
    } catch {
      return;
    }

    await expect(service.backup('profile-1', profileDir, join(tempDir, 'symlink.backup'), vault)).rejects.toThrow(
      'Symlinks are not allowed',
    );
  });

  it('leaves the current destination intact when verification fails', async () => {
    const profileDir = join(tempDir, 'profile-fail');
    const destination = join(tempDir, 'destination');
    await mkdir(profileDir);
    await mkdir(destination);
    await writeFile(join(profileDir, 'test.txt'), 'hello world');
    await writeFile(join(destination, 'existing.txt'), 'keep me');
    const backupPath = join(tempDir, 'failed.backup');
    await service.backup('profile-1', profileDir, backupPath, vault);

    const manifest = JSON.parse(vault.decrypt(await readFile(backupPath, 'utf8'))) as {
      files: Record<string, { sha256: string }>;
    };
    manifest.files['test.txt']!.sha256 = 'f'.repeat(64);
    await writeFile(backupPath, vault.encrypt(JSON.stringify(manifest)));

    await expect(service.restore(backupPath, destination, vault)).rejects.toThrow('Tamper detected');
    expect(await readFile(join(destination, 'existing.txt'), 'utf8')).toBe('keep me');
    await expect(readFile(join(destination, 'test.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rekeys only after validating every payload', async () => {
    const profileDir = join(tempDir, 'profile-rotate');
    await mkdir(profileDir);
    await writeFile(join(profileDir, 'secret.txt'), 'my-secret-data');
    const oldVault = new SecretVault('old-secret-12345678901234567890');
    const newVault = new SecretVault('new-secret-12345678901234567890');
    const backupPath = join(tempDir, 'old.backup');
    const rotatedPath = join(tempDir, 'new.backup');
    await service.backup('profile-1', profileDir, backupPath, oldVault);

    await service.rekey(backupPath, oldVault, newVault, rotatedPath);
    await expect(service.restore(rotatedPath, join(tempDir, 'wrong-key'), oldVault)).rejects.toThrow();
    const restored = join(tempDir, 'right-key');
    await service.restore(rotatedPath, restored, newVault);
    expect(await readFile(join(restored, 'secret.txt'), 'utf8')).toBe('my-secret-data');
  });

  it('rejects plaintext manifests and profile ID mismatches', async () => {
    const profileDir = join(tempDir, 'profile-id');
    await mkdir(profileDir);
    await writeFile(join(profileDir, 'file.txt'), 'content');
    const backupPath = join(tempDir, 'profile-id.backup');
    await service.backup('profile-1', profileDir, backupPath, vault);

    await expect(service.restore(backupPath, join(tempDir, 'mismatch'), vault, 'profile-2')).rejects.toThrow('Profile ID mismatch');
    await writeFile(join(tempDir, 'plain.backup'), vault.decrypt(await readFile(backupPath, 'utf8')));
    await expect(service.restore(join(tempDir, 'plain.backup'), join(tempDir, 'plain'), vault)).rejects.toThrow(
      'Backup manifest is not encrypted',
    );
  });

  it('enforces configured file and total byte ceilings', async () => {
    const bounded = new ProfileBackupService({ maxFileBytes: 4, maxTotalBytes: 8, maxManifestBytes: 1_024 });
    const profileDir = join(tempDir, 'oversized');
    await mkdir(profileDir);
    await writeFile(join(profileDir, 'large.bin'), Buffer.alloc(5));
    await expect(bounded.backup('profile-1', profileDir, join(tempDir, 'large.backup'), vault)).rejects.toThrow(
      'Profile file exceeds the backup size limit',
    );
  });
});
