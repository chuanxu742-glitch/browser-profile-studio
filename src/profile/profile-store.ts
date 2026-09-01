import { mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ProfileMetadata,
  ProfileCreateOptions,
  ProfileSummary,
  CookieRecord,
  CookieFormat,
  ProfileFingerprintSettings,
} from './types.js';
import { cookiesToNetscape, parseCookies } from './cookie-converter.js';
import { normalizeProxyConfig } from '../proxy/validator.js';
import { BrowserToolError } from '../domain.js';
import type { SecretVault } from '../security/secret-vault.js';
import { atomicWriteFile, readJsonWithBackup } from '../storage/atomic-file.js';
import { browserVersionFromUserAgent, managedBrowserIdentity } from '../fingerprint/runtime-identity.js';

export interface ProfileStoreOptions { readonly vault?: SecretVault; }
export interface DeletedProfile { readonly profileId: string; readonly name: string; readonly deletedAt: number; }

export class ProfileStore {
  private readonly rootDir: string;

  public constructor(rootDir: string, private readonly options: ProfileStoreOptions = {}) {
    this.rootDir = rootDir;
  }

  public async init(): Promise<void> {
    if (!existsSync(this.rootDir)) {
      await mkdir(this.rootDir, { recursive: true });
    }
  }

  public getProfileDir(profileId: string): string {
    this.assertSafeProfileId(profileId);
    return join(this.rootDir, profileId);
  }

  public getMetadataPath(profileId: string): string {
    return join(this.getProfileDir(profileId), 'metadata.json');
  }

  public getCookiesPath(profileId: string): string {
    return join(this.getProfileDir(profileId), 'cookies.json');
  }

  public getStorageStatePath(profileId: string): string {
    return join(this.getProfileDir(profileId), 'storage_state.json');
  }

  public async createProfile(options: ProfileCreateOptions): Promise<ProfileMetadata> {
    await this.init();
    const name = (options.name || '').trim();
    if (!name) {
      throw new BrowserToolError('INVALID_ARGUMENT', 'Profile name cannot be empty.');
    }
    assertManagedUserAgent(options.userAgent, options.engine ?? 'firefox');

    const profileId = options.profileId ? options.profileId.trim() : `prf_${randomUUID().slice(0, 8)}`;
    this.assertSafeProfileId(profileId);

    const dir = this.getProfileDir(profileId);
    if (existsSync(dir)) {
      throw new BrowserToolError('INVALID_ARGUMENT', `Profile with ID "${profileId}" already exists.`);
    }

    await mkdir(dir, { recursive: true });

    let normalizedProxy;
    if (options.proxy) {
      normalizedProxy = normalizeProxyConfig(options.proxy);
    }

    const now = Date.now();
    const fingerprint = normalizeFingerprintSettings(options.fingerprint);
    const metadata: ProfileMetadata = {
      profileId,
      name,
      createdAt: now,
      updatedAt: now,
      ...(options.description !== undefined ? { description: options.description } : {}),
      ...(options.tags !== undefined ? { tags: options.tags } : {}),
      ...(normalizedProxy ? {
        proxy: {
          server: normalizedProxy.server,
          ...(normalizedProxy.type ? { type: normalizedProxy.type } : {}),
          ...(normalizedProxy.username !== undefined ? { username: normalizedProxy.username } : {}),
          ...(normalizedProxy.password !== undefined ? { password: normalizedProxy.password } : {}),
          ...(normalizedProxy.bypass !== undefined ? { bypass: normalizedProxy.bypass } : {}),
        },
      } : {}),
      ...(options.geo !== undefined ? { geo: options.geo } : {}),
      engine: options.engine || 'firefox',
      ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
      ...(options.customHeaders !== undefined ? { customHeaders: options.customHeaders } : {}),
      fingerprint,
      ...(options.twoFactorSecret !== undefined ? { twoFactorSecret: options.twoFactorSecret } : {}),
      ...(options.proxyId !== undefined ? { proxyId: options.proxyId } : {}),
      ...(options.extensionIds !== undefined ? { extensionIds: normalizeExtensionIds(options.extensionIds) } : {}),
    };

    await this.writeMetadata(metadata);

    if (options.initialCookies) {
      const parsed = parseCookies(options.initialCookies, options.cookieFormat || 'json');
      await this.saveCookies(profileId, parsed);
    }

    return metadata;
  }

  public async getProfile(profileId: string): Promise<ProfileMetadata | null> {
    try {
      const metaPath = this.getMetadataPath(profileId);
      if (!existsSync(metaPath)) {
        return null;
      }
      const raw = await readFile(metaPath, 'utf-8');
      const persisted = JSON.parse(raw) as ProfileMetadata;
      const decrypted = this.decryptMetadata(persisted);
      const migrated = removeLegacyGeneratedUserAgent(decrypted);
      if (migrated !== decrypted || (this.options.vault && this.metadataNeedsMigration(persisted))) {
        await this.writeMetadata(migrated).catch(() => undefined);
      }
      return migrated;
    } catch {
      return null;
    }
  }

  public async listProfiles(): Promise<ProfileSummary[]> {
    await this.init();
    const entries = await readdir(this.rootDir, { withFileTypes: true });
    const summaries: ProfileSummary[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const meta = await this.getProfile(entry.name);
        if (meta) {
          summaries.push({
            profileId: meta.profileId,
            name: meta.name,
            createdAt: meta.createdAt,
            updatedAt: meta.updatedAt,
            ...(meta.proxy?.server !== undefined ? { proxyServer: meta.proxy.server } : {}),
            ...(meta.geo?.countryCode !== undefined ? { country: meta.geo.countryCode } : {}),
            engine: meta.engine || 'firefox',
            ...(meta.tags !== undefined ? { tags: [...meta.tags] } : {}),
            hasTwoFactorSecret: Boolean(meta.twoFactorSecret),
            ...(meta.proxyId !== undefined ? { proxyId: meta.proxyId } : {}),
            ...(meta.extensionIds !== undefined ? { extensionIds: [...meta.extensionIds] } : {}),
          });
        }
      }
    }

    return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  public async updateProfile(profileId: string, updates: Partial<ProfileMetadata>): Promise<ProfileMetadata> {
    const existing = await this.getProfile(profileId);
    if (!existing) {
      throw new BrowserToolError('SESSION_NOT_FOUND', `Profile "${profileId}" not found.`);
    }

    const updated: ProfileMetadata = {
      ...existing,
      ...updates,
      profileId: existing.profileId,
      createdAt: existing.createdAt,
      updatedAt: Date.now(),
    };
    assertManagedUserAgent(updated.userAgent, updated.engine ?? 'firefox');
    if (updates.extensionIds !== undefined) (updated as { extensionIds?: readonly string[] }).extensionIds = normalizeExtensionIds(updates.extensionIds);

    if (updates.proxy) {
      const norm = normalizeProxyConfig(updates.proxy);
      (updated as any).proxy = {
        server: norm.server,
        type: norm.type,
        username: norm.username,
        password: norm.password,
        bypass: norm.bypass,
      };
    }

    await this.writeMetadata(updated);
    return updated;
  }

  public async deleteProfile(profileId: string): Promise<boolean> {
    this.assertSafeProfileId(profileId);
    const dir = this.getProfileDir(profileId);
    if (!existsSync(dir)) {
      return false;
    }
    const trashDir = join(this.rootDir, '.trash');
    await mkdir(trashDir, { recursive: true, mode: 0o700 });
    await rename(dir, join(trashDir, `${profileId}--${Date.now()}`));
    return true;
  }

  public async listDeletedProfiles(): Promise<DeletedProfile[]> {
    const trashDir = join(this.rootDir, '.trash');
    if (!existsSync(trashDir)) return [];
    const result: DeletedProfile[] = [];
    for (const entry of await readdir(trashDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const match = entry.name.match(/^(.+)--(\d+)$/);
      if (!match) continue;
      try {
        const metadata = await readJsonWithBackup<ProfileMetadata>(join(trashDir, entry.name, 'metadata.json'));
        result.push({ profileId: match[1]!, name: metadata.name, deletedAt: Number(match[2]) });
      } catch { /* Ignore corrupted trash entries. */ }
    }
    return result.sort((a, b) => b.deletedAt - a.deletedAt);
  }

  public async restoreProfile(profileId: string): Promise<ProfileMetadata> {
    this.assertSafeProfileId(profileId);
    if (existsSync(this.getProfileDir(profileId))) throw new BrowserToolError('INVALID_ARGUMENT', `Profile "${profileId}" already exists.`);
    const trashDir = join(this.rootDir, '.trash');
    const candidates = (await readdir(trashDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${profileId}--`))
      .sort((a, b) => b.name.localeCompare(a.name));
    const selected = candidates[0];
    if (!selected) throw new BrowserToolError('SESSION_NOT_FOUND', `Deleted profile "${profileId}" not found.`);
    await rename(join(trashDir, selected.name), this.getProfileDir(profileId));
    const restored = await this.getProfile(profileId);
    if (!restored) throw new BrowserToolError('INTERNAL_ERROR', `Restored profile "${profileId}" is unreadable.`);
    return this.updateProfile(profileId, {});
  }

  public async purgeDeletedProfile(profileId: string): Promise<boolean> {
    this.assertSafeProfileId(profileId);
    const trashDir = join(this.rootDir, '.trash');
    if (!existsSync(trashDir)) return false;
    const entries = await readdir(trashDir, { withFileTypes: true });
    let deleted = false;
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith(`${profileId}--`)) {
        await rm(join(trashDir, entry.name), { recursive: true, force: true });
        deleted = true;
      }
    }
    return deleted;
  }

  public async getCookies(profileId: string): Promise<CookieRecord[]> {
    const cookiePath = this.getCookiesPath(profileId);
    if (!existsSync(cookiePath)) {
      return [];
    }
    try {
      const raw = await readFile(cookiePath, 'utf-8');
      const cookies = JSON.parse(raw) as CookieRecord[];
      const decrypted = cookies.map((cookie) => ({
        ...cookie,
        value: this.options.vault?.decrypt(cookie.value) ?? cookie.value,
      }));
      if (this.options.vault && cookies.some((cookie) => cookie.value && !this.options.vault!.isEncrypted(cookie.value))) {
        await this.saveCookies(profileId, decrypted).catch(() => undefined);
      }
      return decrypted;
    } catch {
      return [];
    }
  }

  public async saveCookies(profileId: string, cookies: readonly CookieRecord[]): Promise<void> {
    const cookiePath = this.getCookiesPath(profileId);
    const persisted = cookies.map((cookie) => ({
      ...cookie,
      value: this.options.vault?.encrypt(cookie.value) ?? cookie.value,
    }));
    await atomicWriteFile(cookiePath, JSON.stringify(persisted, null, 2));
  }

  public async exportCookies(profileId: string, format: CookieFormat = 'json'): Promise<string> {
    const cookies = await this.getCookies(profileId);
    if (format === 'netscape') {
      return cookiesToNetscape(cookies);
    }
    return JSON.stringify(cookies, null, 2);
  }

  public async importCookies(
    profileId: string,
    raw: string | readonly CookieRecord[],
    format: CookieFormat = 'json',
  ): Promise<number> {
    const existing = await this.getProfile(profileId);
    if (!existing) {
      throw new BrowserToolError('SESSION_NOT_FOUND', `Profile "${profileId}" not found.`);
    }
    const newCookies = parseCookies(raw, format);
    const existingCookies = await this.getCookies(profileId);

    // Merge by domain + path + name
    const cookieMap = new Map<string, CookieRecord>();
    for (const c of existingCookies) {
      cookieMap.set(`${c.domain}:${c.path}:${c.name}`, c);
    }
    for (const c of newCookies) {
      cookieMap.set(`${c.domain}:${c.path}:${c.name}`, c);
    }

    const merged = Array.from(cookieMap.values());
    await this.saveCookies(profileId, merged);
    await this.updateProfile(profileId, {});
    return merged.length;
  }

  private assertSafeProfileId(profileId: string): void {
    if (!profileId || typeof profileId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(profileId)) {
      throw new BrowserToolError('INVALID_ARGUMENT', `Invalid profile ID: "${profileId}". Must contain only alphanumeric, underscores, and dashes.`);
    }
  }

  private async writeMetadata(metadata: ProfileMetadata): Promise<void> {
    const persisted: ProfileMetadata = {
      ...metadata,
      ...(metadata.proxy?.password !== undefined ? {
        proxy: {
          ...metadata.proxy,
          password: this.options.vault?.encrypt(metadata.proxy.password) ?? metadata.proxy.password,
        },
      } : {}),
      ...(metadata.twoFactorSecret !== undefined ? {
        twoFactorSecret: this.options.vault?.encrypt(metadata.twoFactorSecret) ?? metadata.twoFactorSecret,
      } : {}),
    };
    await atomicWriteFile(this.getMetadataPath(metadata.profileId), JSON.stringify(persisted, null, 2));
  }

  private decryptMetadata(metadata: ProfileMetadata): ProfileMetadata {
    return {
      ...metadata,
      ...(metadata.proxy?.password !== undefined ? {
        proxy: {
          ...metadata.proxy,
          password: this.options.vault?.decrypt(metadata.proxy.password) ?? metadata.proxy.password,
        },
      } : {}),
      ...(metadata.twoFactorSecret !== undefined ? {
        twoFactorSecret: this.options.vault?.decrypt(metadata.twoFactorSecret) ?? metadata.twoFactorSecret,
      } : {}),
    };
  }

  private metadataNeedsMigration(metadata: ProfileMetadata): boolean {
    const vault = this.options.vault;
    if (!vault) return false;
    return Boolean(
      (metadata.proxy?.password && !vault.isEncrypted(metadata.proxy.password))
      || (metadata.twoFactorSecret && !vault.isEncrypted(metadata.twoFactorSecret)),
    );
  }
}

function normalizeFingerprintSettings(
  value: Partial<ProfileFingerprintSettings> | undefined,
): ProfileFingerprintSettings {
  const generatedSeed = Number.parseInt(randomUUID().replaceAll('-', '').slice(0, 8), 16) || 1;
  const seed = boundedInteger(value?.seed, 1, 0xffff_ffff, generatedSeed);
  const hardwareConcurrency = value?.hardwareConcurrency === undefined
    ? undefined
    : boundedInteger(value.hardwareConcurrency, 1, 64, 8);
  const deviceMemory = value?.deviceMemory === undefined
    ? undefined
    : boundedInteger(value.deviceMemory, 1, 128, 8);
  const screen = value?.screen;
  const normalizedScreen = screen === undefined ? undefined : {
    width: boundedInteger(screen.width, 320, 16_384, 1920),
    height: boundedInteger(screen.height, 240, 16_384, 1080),
    ...(screen.availWidth !== undefined
      ? { availWidth: boundedInteger(screen.availWidth, 320, 16_384, screen.width) }
      : {}),
    ...(screen.availHeight !== undefined
      ? { availHeight: boundedInteger(screen.availHeight, 240, 16_384, screen.height) }
      : {}),
    ...(screen.colorDepth !== undefined
      ? { colorDepth: boundedInteger(screen.colorDepth, 8, 48, 24) }
      : {}),
    ...(screen.devicePixelRatio !== undefined
      ? { devicePixelRatio: boundedNumber(screen.devicePixelRatio, 0.5, 4, 1) }
      : {}),
  };

  return {
    seed,
    ...(value?.os !== undefined ? { os: value.os } : {}),
    ...(hardwareConcurrency !== undefined ? { hardwareConcurrency } : {}),
    ...(deviceMemory !== undefined ? { deviceMemory } : {}),
    ...(normalizedScreen !== undefined ? { screen: normalizedScreen } : {}),
  };
}

function boundedInteger(value: number | undefined, minimum: number, maximum: number, fallback: number): number {
  return Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, Math.floor(value!)))
    : fallback;
}

function boundedNumber(value: number | undefined, minimum: number, maximum: number, fallback: number): number {
  return Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, value!))
    : fallback;
}

function normalizeExtensionIds(values: readonly string[]): string[] {
  if (!Array.isArray(values)) throw new BrowserToolError('INVALID_ARGUMENT', 'extensionIds must be an array.');
  const ids = [...new Set(values.filter((value): value is string => typeof value === 'string'))];
  if (ids.length > 32 || ids.some((value) => !/^ext_[A-Za-z0-9_-]+$/.test(value))) throw new BrowserToolError('INVALID_ARGUMENT', 'extensionIds contains an invalid managed extension ID.');
  return ids;
}

function assertManagedUserAgent(userAgent: string | undefined, engine: 'firefox' | 'chromium'): void {
  if (userAgent === undefined) return;
  const managed = managedBrowserIdentity(engine);
  const version = browserVersionFromUserAgent(userAgent, engine);
  if (version?.split('.')[0] !== managed.majorVersion) {
    throw new BrowserToolError(
      'INVALID_ARGUMENT',
      `Custom User-Agent must identify managed ${engine} major version ${managed.majorVersion}. Leave it blank to generate a compatible value automatically.`,
    );
  }
}

function removeLegacyGeneratedUserAgent(metadata: ProfileMetadata): ProfileMetadata {
  if (!metadata.userAgent) return metadata;
  const isLegacyFirefox = /^Mozilla\/5\.0 \((?:Windows NT 10\.0; Win64; x64|Macintosh; Intel Mac OS X 10\.15); rv:128\.0\) Gecko\/20100101 Firefox\/128\.0$/.test(metadata.userAgent);
  const isLegacyChromium = /^Mozilla\/5\.0 \((?:Windows NT 10\.0; Win64; x64|Macintosh; Intel Mac OS X 10_15_7)\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/126\.0\.0\.0 Safari\/537\.36$/.test(metadata.userAgent);
  if (!isLegacyFirefox && !isLegacyChromium) return metadata;
  const { userAgent: _legacyUserAgent, ...migrated } = metadata;
  return migrated;
}
