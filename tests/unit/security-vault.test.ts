import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SecretVault } from '../../src/security/secret-vault.js';
import { ProfileStore } from '../../src/profile/profile-store.js';

describe('encrypted Studio persistence', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('encrypts and authenticates an AES-GCM envelope', () => {
    const vault = new SecretVault('0123456789abcdef0123456789abcdef');
    const encrypted = vault.encrypt('sensitive-value');
    expect(encrypted).toMatch(/^enc:v1:/);
    expect(encrypted).not.toContain('sensitive-value');
    expect(vault.decrypt(encrypted)).toBe('sensitive-value');
    expect(() => new SecretVault('fedcba9876543210fedcba9876543210').decrypt(encrypted)).toThrow();
  });

  it('stores profile secrets and cookies encrypted and returns decrypted values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vault-profile-'));
    temporaryDirectories.push(root);
    const vault = new SecretVault('0123456789abcdef0123456789abcdef');
    const store = new ProfileStore(root, { vault });
    const profile = await store.createProfile({
      profileId: 'encrypted-profile',
      name: 'Encrypted',
      proxy: { server: 'http://proxy.example:8080', password: 'proxy-password' },
      twoFactorSecret: 'JBSWY3DPEHPK3PXP',
      initialCookies: [{ name: 'session', value: 'cookie-secret', domain: '.example.com', path: '/' }],
    });
    const metadataRaw = await readFile(store.getMetadataPath(profile.profileId), 'utf8');
    const cookiesRaw = await readFile(store.getCookiesPath(profile.profileId), 'utf8');
    expect(metadataRaw).toContain('enc:v1:');
    expect(metadataRaw).not.toContain('proxy-password');
    expect(metadataRaw).not.toContain('JBSWY3DPEHPK3PXP');
    expect(cookiesRaw).not.toContain('cookie-secret');
    expect((await store.getProfile(profile.profileId))?.proxy?.password).toBe('proxy-password');
    expect((await store.getProfile(profile.profileId))?.twoFactorSecret).toBe('JBSWY3DPEHPK3PXP');
    expect((await store.getCookies(profile.profileId))[0]?.value).toBe('cookie-secret');
  });

  it('migrates legacy plaintext metadata and cookies on first read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vault-migrate-'));
    temporaryDirectories.push(root);
    const profileDir = join(root, 'legacy');
    await mkdir(profileDir, { recursive: true });
    const now = Date.now();
    await writeFile(join(profileDir, 'metadata.json'), JSON.stringify({
      profileId: 'legacy', name: 'Legacy', createdAt: now, updatedAt: now, engine: 'firefox',
      fingerprint: { seed: 1 }, twoFactorSecret: 'LEGACY2FA', proxy: { server: 'http://localhost:8080', password: 'LEGACYPASS' },
    }));
    await writeFile(join(profileDir, 'cookies.json'), JSON.stringify([{ name: 'sid', value: 'LEGACYCOOKIE', domain: '.example.com', path: '/' }]));
    const store = new ProfileStore(root, { vault: new SecretVault('0123456789abcdef0123456789abcdef') });
    expect((await store.getProfile('legacy'))?.twoFactorSecret).toBe('LEGACY2FA');
    expect((await store.getCookies('legacy'))[0]?.value).toBe('LEGACYCOOKIE');
    expect(await readFile(join(profileDir, 'metadata.json'), 'utf8')).not.toContain('LEGACY2FA');
    expect(await readFile(join(profileDir, 'cookies.json'), 'utf8')).not.toContain('LEGACYCOOKIE');
  });
});
