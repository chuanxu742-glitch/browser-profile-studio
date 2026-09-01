import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

import { BrowserToolError } from '../domain.js';
import type { ProfileStore } from '../profile/profile-store.js';
import type { ProfileMetadata } from '../profile/types.js';

export type LocalBrowserType = 'chrome' | 'edge' | 'firefox';

export interface LocalBrowserCandidate {
  readonly name: string;
  readonly type: LocalBrowserType;
  readonly userDataPath: string;
}

export interface LocalBrowserProfile {
  readonly sourceId: string;
  readonly name: string;
  readonly path: string;
  readonly hasCookies: boolean;
  readonly hasLocalStorage: boolean;
  readonly hasIndexedDb: boolean;
  readonly hasSavedPasswords: boolean;
  readonly inUse: boolean;
}

export interface DetectedLocalBrowser {
  readonly name: string;
  readonly type: LocalBrowserType;
  readonly userDataPath: string;
  readonly profiles: readonly LocalBrowserProfile[];
}

export interface LocalBrowserImportOptions {
  readonly sourceId: string;
  readonly confirmBrowserClosed: boolean;
}

export interface LocalBrowserImportResult {
  readonly profile: ProfileMetadata;
  readonly browserName: string;
  readonly browserType: LocalBrowserType;
  readonly sourceProfileName: string;
  readonly copiedFiles: number;
  readonly copiedBytes: number;
  readonly importedData: readonly string[];
  readonly excludedData: readonly string[];
  readonly warnings: readonly string[];
}

export interface LocalBrowserImporterOptions {
  readonly candidates?: readonly LocalBrowserCandidate[];
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
  readonly localAppData?: string;
  readonly appData?: string;
  readonly maxFiles?: number;
  readonly maxBytes?: number;
}

interface ResolvedSource {
  readonly browser: DetectedLocalBrowser;
  readonly profile: LocalBrowserProfile;
}

interface CopyStats {
  files: number;
  bytes: number;
  importedData: Set<string>;
  warnings: Set<string>;
}

const DEFAULT_MAX_FILES = 250_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024 * 1024;

const CHROMIUM_PROFILE_ENTRIES: ReadonlyArray<readonly [string, string]> = [
  ['Network', 'cookies'],
  ['Cookies', 'cookies'],
  ['Local Storage', 'localStorage'],
  ['IndexedDB', 'indexedDb'],
  ['Session Storage', 'sessionStorage'],
  ['WebStorage', 'localStorage'],
  ['Service Worker', 'serviceWorkerStorage'],
  ['Storage', 'siteStorage'],
  ['SharedStorage', 'siteStorage'],
  ['Trust Tokens', 'siteStorage'],
  ['Trust Tokens-journal', 'siteStorage'],
  ['QuotaManager', 'siteStorage'],
  ['QuotaManager-journal', 'siteStorage'],
  ['DIPS', 'siteStorage'],
  ['DIPS-journal', 'siteStorage'],
];

const FIREFOX_PROFILE_ENTRIES: ReadonlyArray<readonly [string, string]> = [
  ['cookies.sqlite', 'cookies'],
  ['cookies.sqlite-wal', 'cookies'],
  ['cookies.sqlite-shm', 'cookies'],
  ['storage', 'siteStorage'],
  ['storage.sqlite', 'siteStorage'],
  ['webappsstore.sqlite', 'localStorage'],
  ['permissions.sqlite', 'sitePermissions'],
  ['content-prefs.sqlite', 'sitePreferences'],
  ['containers.json', 'containers'],
  ['sessionstore.jsonlz4', 'sessionStorage'],
  ['sessionstore-backups', 'sessionStorage'],
  ['sessionCheckpoints.json', 'sessionStorage'],
  ['SiteSecurityServiceState.txt', 'siteSecurityState'],
];

const CHROMIUM_LOCKS = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
const FIREFOX_LOCKS = ['parent.lock', '.parentlock', 'lock'];
const EXCLUDED_DATA = Object.freeze(['savedPasswords', 'history', 'bookmarks', 'autofill', 'extensions']);

export class LocalBrowserImporter {
  private readonly maxFiles: number;
  private readonly maxBytes: number;

  public constructor(
    private readonly profileStore: ProfileStore,
    private readonly options: LocalBrowserImporterOptions = {},
  ) {
    this.maxFiles = boundedLimit(options.maxFiles, DEFAULT_MAX_FILES);
    this.maxBytes = boundedLimit(options.maxBytes, DEFAULT_MAX_BYTES);
  }

  public async scan(): Promise<DetectedLocalBrowser[]> {
    const detected: DetectedLocalBrowser[] = [];
    for (const candidate of this.options.candidates ?? defaultCandidates(this.options)) {
      const browser = await this.scanCandidate(candidate);
      if (browser && browser.profiles.length > 0) detected.push(browser);
    }
    return detected;
  }

  public async importProfile(options: LocalBrowserImportOptions): Promise<LocalBrowserImportResult> {
    if (options.confirmBrowserClosed !== true) {
      throw new BrowserToolError('APPROVAL_REQUIRED', 'Close the source browser and confirm before importing local browser data.');
    }
    if (!/^[a-f0-9]{64}$/.test(options.sourceId)) {
      throw new BrowserToolError('INVALID_ARGUMENT', 'Invalid local browser source ID.');
    }

    const source = await this.resolveSource(options.sourceId);
    if (!source) throw new BrowserToolError('SESSION_NOT_FOUND', 'The selected local browser profile is no longer available. Scan again.');
    if (source.profile.inUse) {
      throw new BrowserToolError('INVALID_STATE', `Close ${source.browser.name} completely before importing this profile.`);
    }

    const profileId = await this.availableProfileId(source.browser.type, source.profile.name, source.profile.sourceId);
    const created = await this.profileStore.createProfile({
      profileId,
      name: `从${source.browser.name}导入-${source.profile.name}`,
      tags: ['已导入', '本机浏览器', source.browser.name, source.profile.name],
      engine: source.browser.type === 'firefox' ? 'firefox' : 'chromium',
      description: '由本机浏览器迁移服务创建；仅导入网站会话数据，不导入密码库、历史记录或未受管扩展。',
    });

    const destination = this.profileStore.getProfileDir(profileId);
    const stats: CopyStats = { files: 0, bytes: 0, importedData: new Set(), warnings: new Set() };
    try {
      if (source.browser.type === 'firefox') {
        await this.copySelectedEntries(source.profile.path, destination, FIREFOX_PROFILE_ENTRIES, stats);
      } else {
        await this.copyChromiumLocalState(source.browser.userDataPath, destination, stats);
        await this.copySelectedEntries(source.profile.path, join(destination, 'Default'), CHROMIUM_PROFILE_ENTRIES, stats);
        if (source.profile.hasCookies) {
          stats.warnings.add('Chromium Cookie 受 Windows DPAPI/App-Bound Encryption 保护时，目标内核可能无法解密；首次启动后请检查登录状态。');
        }
      }

      const updated = await this.profileStore.updateProfile(profileId, {
        description: `从 ${source.browser.name} / ${source.profile.name} 导入于 ${new Date().toISOString()}；已复制 ${stats.files} 个网站会话文件。`,
      });
      return {
        profile: updated,
        browserName: source.browser.name,
        browserType: source.browser.type,
        sourceProfileName: source.profile.name,
        copiedFiles: stats.files,
        copiedBytes: stats.bytes,
        importedData: [...stats.importedData].sort(),
        excludedData: EXCLUDED_DATA,
        warnings: [...stats.warnings],
      };
    } catch (error) {
      await rm(destination, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof BrowserToolError) throw error;
      const reason = safeErrorReason(error);
      if (['EBUSY', 'EACCES', 'EPERM'].includes(reason)) {
        throw new BrowserToolError('INVALID_STATE', `Close ${source.browser.name}, including background processes, before importing this profile.`, {
          details: { reason },
        });
      }
      throw new BrowserToolError('INTERNAL_ERROR', 'Local browser data could not be copied.', { details: { reason } });
    }
  }

  private async scanCandidate(candidate: LocalBrowserCandidate): Promise<DetectedLocalBrowser | undefined> {
    const userDataPath = resolve(candidate.userDataPath);
    if (!existsSync(userDataPath)) return undefined;
    let rootReal: string;
    try {
      rootReal = await realpath(userDataPath);
    } catch {
      return undefined;
    }

    const entries = await readdir(rootReal, { withFileTypes: true }).catch(() => []);
    const profileEntries = entries.filter((entry) => {
      if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
      if (candidate.type !== 'firefox') return entry.name === 'Default' || /^Profile \d+$/.test(entry.name);
      const path = join(rootReal, entry.name);
      return existsSync(join(path, 'prefs.js'))
        || existsSync(join(path, 'cookies.sqlite'))
        || existsSync(join(path, 'places.sqlite'))
        || existsSync(join(path, 'storage'));
    });
    const inUse = await browserAppearsInUse(candidate.type, rootReal, profileEntries.map((entry) => join(rootReal, entry.name)));
    const profiles: LocalBrowserProfile[] = [];

    for (const entry of profileEntries) {
      const path = join(rootReal, entry.name);
      let profileReal: string;
      try {
        profileReal = await realpath(path);
      } catch {
        continue;
      }
      if (!isInside(rootReal, profileReal)) continue;
      const sourceId = sourceDigest(candidate.type, profileReal);
      profiles.push({
        sourceId,
        name: entry.name,
        path: profileReal,
        hasCookies: hasAny(profileReal, candidate.type === 'firefox' ? ['cookies.sqlite'] : ['Network/Cookies', 'Cookies']),
        hasLocalStorage: hasAny(profileReal, candidate.type === 'firefox' ? ['storage/default', 'webappsstore.sqlite'] : ['Local Storage', 'WebStorage']),
        hasIndexedDb: hasAny(profileReal, candidate.type === 'firefox' ? ['storage/default'] : ['IndexedDB']),
        hasSavedPasswords: hasAny(profileReal, candidate.type === 'firefox' ? ['logins.json'] : ['Login Data']),
        inUse,
      });
    }

    return { name: candidate.name, type: candidate.type, userDataPath: rootReal, profiles };
  }

  private async resolveSource(sourceId: string): Promise<ResolvedSource | undefined> {
    for (const browser of await this.scan()) {
      const profile = browser.profiles.find((item) => item.sourceId === sourceId);
      if (profile) return { browser, profile };
    }
    return undefined;
  }

  private async availableProfileId(type: LocalBrowserType, profileName: string, sourceId: string): Promise<string> {
    const slug = profileName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'profile';
    const base = `imported-${type}-${slug}-${sourceId.slice(0, 8)}`;
    if (!await this.profileStore.getProfile(base)) return base;
    for (let index = 2; index <= 99; index += 1) {
      const candidate = `${base}-${index}`;
      if (!await this.profileStore.getProfile(candidate)) return candidate;
    }
    throw new BrowserToolError('RESOURCE_EXHAUSTED', 'Too many imports exist for this local browser profile.');
  }

  private async copyChromiumLocalState(sourceRoot: string, destinationRoot: string, stats: CopyStats): Promise<void> {
    const source = join(sourceRoot, 'Local State');
    if (!existsSync(source)) {
      stats.warnings.add('未找到 Chromium Local State；加密 Cookie 可能无法在目标 Profile 中读取。');
      return;
    }
    const raw = await readFile(source, 'utf8');
    const parsed = JSON.parse(raw) as { os_crypt?: unknown };
    if (parsed.os_crypt === undefined) {
      stats.warnings.add('Chromium Local State 不包含 os_crypt；加密 Cookie 可能无法在目标 Profile 中读取。');
      return;
    }
    const destination = join(destinationRoot, 'Local State');
    const payload = Buffer.from(JSON.stringify({ os_crypt: parsed.os_crypt }));
    this.consumeBudget(stats, payload.byteLength);
    await writeFile(destination, payload, { mode: 0o600 });
    stats.importedData.add('cookieEncryptionMetadata');
  }

  private async copySelectedEntries(
    sourceRoot: string,
    destinationRoot: string,
    entries: ReadonlyArray<readonly [string, string]>,
    stats: CopyStats,
  ): Promise<void> {
    await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
    for (const [relativePath, dataKind] of entries) {
      const source = resolve(sourceRoot, relativePath);
      if (!isInside(sourceRoot, source) || !existsSync(source)) continue;
      const destination = resolve(destinationRoot, relativePath);
      if (!isInside(destinationRoot, destination)) throw new BrowserToolError('INTERNAL_ERROR', 'Unsafe browser import destination.');
      const before = stats.files;
      await this.copyPath(source, destination, stats);
      if (stats.files > before) stats.importedData.add(dataKind);
    }
  }

  private async copyPath(source: string, destination: string, stats: CopyStats): Promise<void> {
    const info = await lstat(source);
    if (info.isSymbolicLink()) {
      stats.warnings.add(`已跳过符号链接：${basename(source)}`);
      return;
    }
    if (info.isDirectory()) {
      await mkdir(destination, { recursive: true, mode: 0o700 });
      for (const entry of await readdir(source, { withFileTypes: true })) {
        if (entry.name === 'LOCK' || entry.name.endsWith('.lock') || entry.name.endsWith('.tmp')) continue;
        await this.copyPath(join(source, entry.name), join(destination, entry.name), stats);
      }
      return;
    }
    if (!info.isFile()) return;
    this.consumeBudget(stats, info.size);
    await mkdir(resolve(destination, '..'), { recursive: true, mode: 0o700 });
    await copyFile(source, destination);
  }

  private consumeBudget(stats: CopyStats, bytes: number): void {
    if (stats.files + 1 > this.maxFiles || stats.bytes + bytes > this.maxBytes) {
      throw new BrowserToolError('RESOURCE_EXHAUSTED', 'Local browser import exceeds the configured file or size limit.');
    }
    stats.files += 1;
    stats.bytes += bytes;
  }
}

export function defaultCandidates(options: LocalBrowserImporterOptions = {}): LocalBrowserCandidate[] {
  const platform = options.platform ?? process.platform;
  const home = resolve(options.homeDir ?? homedir());
  if (platform === 'win32') {
    const localAppData = resolve(options.localAppData ?? process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'));
    const appData = resolve(options.appData ?? process.env.APPDATA ?? join(home, 'AppData', 'Roaming'));
    return [
      { name: 'Google Chrome', type: 'chrome', userDataPath: join(localAppData, 'Google', 'Chrome', 'User Data') },
      { name: 'Microsoft Edge', type: 'edge', userDataPath: join(localAppData, 'Microsoft', 'Edge', 'User Data') },
      { name: 'Mozilla Firefox', type: 'firefox', userDataPath: join(appData, 'Mozilla', 'Firefox', 'Profiles') },
    ];
  }
  if (platform === 'darwin') {
    return [
      { name: 'Google Chrome', type: 'chrome', userDataPath: join(home, 'Library', 'Application Support', 'Google', 'Chrome') },
      { name: 'Microsoft Edge', type: 'edge', userDataPath: join(home, 'Library', 'Application Support', 'Microsoft Edge') },
      { name: 'Mozilla Firefox', type: 'firefox', userDataPath: join(home, 'Library', 'Application Support', 'Firefox', 'Profiles') },
    ];
  }
  return [
    { name: 'Google Chrome', type: 'chrome', userDataPath: join(home, '.config', 'google-chrome') },
    { name: 'Microsoft Edge', type: 'edge', userDataPath: join(home, '.config', 'microsoft-edge') },
    { name: 'Mozilla Firefox', type: 'firefox', userDataPath: join(home, '.mozilla', 'firefox') },
  ];
}

async function browserAppearsInUse(type: LocalBrowserType, root: string, profiles: readonly string[]): Promise<boolean> {
  const lockNames = type === 'firefox' ? FIREFOX_LOCKS : CHROMIUM_LOCKS;
  const roots = type === 'firefox' ? profiles : [root];
  if (roots.some((path) => lockNames.some((name) => existsSync(join(path, name))))) return true;
  for (const profile of profiles) {
    const databases = type === 'firefox'
      ? [join(profile, 'cookies.sqlite')]
      : [join(profile, 'Network', 'Cookies'), join(profile, 'Cookies')];
    for (const database of databases) {
      if (!existsSync(database)) continue;
      try {
        const handle = await open(database, 'r+');
        await handle.close();
      } catch (error) {
        if (['EBUSY', 'EACCES', 'EPERM'].includes(safeErrorReason(error))) return true;
      }
    }
  }
  return false;
}

function sourceDigest(type: LocalBrowserType, path: string): string {
  return createHash('sha256').update(`${type}\0${resolve(path).toLowerCase()}`).digest('hex');
}

function hasAny(root: string, entries: readonly string[]): boolean {
  return entries.some((entry) => existsSync(join(root, entry)));
}

function isInside(rootValue: string, targetValue: string): boolean {
  const root = resolve(rootValue);
  const target = resolve(targetValue);
  const nested = relative(root, target);
  return nested !== '' && !nested.startsWith('..') && !isAbsolute(nested);
}

function boundedLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}

function safeErrorReason(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown';
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' ? code : error.name;
}
