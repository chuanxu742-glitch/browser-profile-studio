import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { unzipSync } from 'fflate';
import { atomicWriteFile, readJsonWithBackup } from '../storage/atomic-file.js';

const MAX_COMPRESSED_BYTES = 12 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 1_000;
const FORBIDDEN_PERMISSIONS = new Set(['nativeMessaging', 'debugger', 'management']);
const HIGH_RISK_PERMISSIONS = new Set(['cookies', 'webRequest', 'webRequestBlocking', 'proxy', 'privacy', 'history', 'downloads', 'clipboardRead', 'clipboardWrite']);
const FORBIDDEN_SUFFIXES = ['.exe', '.dll', '.msi', '.bat', '.cmd', '.ps1', '.com', '.scr'];

export interface ManagedExtensionRecord {
  readonly extensionId: string;
  readonly name: string;
  readonly version: string;
  readonly manifestVersion: 2 | 3;
  readonly sha256: string;
  readonly contentSha256: string;
  readonly permissions: readonly string[];
  readonly hostPermissions: readonly string[];
  readonly highRiskPermissions: readonly string[];
  readonly engines: readonly ('chromium' | 'firefox')[];
  readonly geckoId?: string;
  readonly firefoxSignaturePresent: boolean;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface ExtensionIndex { readonly schemaVersion: 1; records: ManagedExtensionRecord[]; }
interface WebExtensionManifest {
  name?: unknown; version?: unknown; manifest_version?: unknown; permissions?: unknown; host_permissions?: unknown;
  optional_permissions?: unknown; optional_host_permissions?: unknown;
  content_scripts?: Array<{ matches?: unknown }>;
  key?: unknown; browser_specific_settings?: { gecko?: { id?: unknown } }; applications?: { gecko?: { id?: unknown } };
}

export interface ManagedExtensionLaunchDescriptor {
  readonly extensionId: string;
  readonly directory: string;
  readonly packagePath: string;
  readonly geckoId?: string;
}

export class ManagedExtensionStore {
  private records = new Map<string, ManagedExtensionRecord>();
  private loaded = false;
  private writeTail: Promise<void> = Promise.resolve();
  private readonly indexPath: string;

  public constructor(private readonly rootDir: string) { this.indexPath = join(rootDir, 'index.json'); }

  public async init(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    if (!existsSync(this.indexPath)) return;
    const index = await readJsonWithBackup<ExtensionIndex>(this.indexPath);
    for (const record of index.records ?? []) if (existsSync(this.getDirectory(record.extensionId))) this.records.set(record.extensionId, record);
  }

  public async list(): Promise<ManagedExtensionRecord[]> { await this.init(); return [...this.records.values()].map(cloneRecord).sort((a, b) => b.updatedAt - a.updatedAt); }
  public async get(extensionId: string): Promise<ManagedExtensionRecord | undefined> { await this.init(); const value = this.records.get(extensionId); return value ? cloneRecord(value) : undefined; }

  public async importPackage(input: { packageBase64: string; approveHighRisk?: boolean }): Promise<ManagedExtensionRecord> {
    await this.init();
    if (typeof input.packageBase64 !== 'string' || !input.packageBase64) throw new Error('EXTENSION_PACKAGE_REQUIRED');
    if (input.packageBase64.length > Math.ceil(MAX_COMPRESSED_BYTES / 3) * 4 || !isCanonicalBase64(input.packageBase64)) throw new Error('EXTENSION_PACKAGE_INVALID');
    const archive = Buffer.from(input.packageBase64, 'base64');
    if (!archive.length || archive.length > MAX_COMPRESSED_BYTES) throw new Error('EXTENSION_PACKAGE_SIZE_INVALID');
    let entries: Record<string, Uint8Array>;
    let declaredFiles = 0; let declaredBytes = 0;
    try {
      entries = unzipSync(archive, { filter: (file) => {
        validateArchivePath(file.name);
        declaredFiles += 1; declaredBytes += file.originalSize;
        if (declaredFiles > MAX_FILES) throw new Error('EXTENSION_FILE_COUNT_INVALID');
        if (declaredBytes > MAX_UNCOMPRESSED_BYTES) throw new Error('EXTENSION_UNCOMPRESSED_SIZE_INVALID');
        if (FORBIDDEN_SUFFIXES.some((suffix) => file.name.toLowerCase().endsWith(suffix))) throw new Error('EXTENSION_EXECUTABLE_FORBIDDEN');
        return true;
      } });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('EXTENSION_')) throw error;
      throw new Error('EXTENSION_ARCHIVE_INVALID');
    }
    const names = Object.keys(entries);
    if (!names.length || names.length > MAX_FILES) throw new Error('EXTENSION_FILE_COUNT_INVALID');
    let totalBytes = 0;
    for (const [name, bytes] of Object.entries(entries)) {
      validateArchivePath(name);
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_UNCOMPRESSED_BYTES) throw new Error('EXTENSION_UNCOMPRESSED_SIZE_INVALID');
      if (FORBIDDEN_SUFFIXES.some((suffix) => name.toLowerCase().endsWith(suffix))) throw new Error('EXTENSION_EXECUTABLE_FORBIDDEN');
    }
    const manifestEntry = locateManifest(names);
    let manifest: WebExtensionManifest;
    try { manifest = JSON.parse(Buffer.from(entries[manifestEntry]!).toString('utf8')) as WebExtensionManifest; } catch { throw new Error('EXTENSION_MANIFEST_INVALID'); }
    const normalized = validateManifest(manifest, input.approveHighRisk === true, names, manifestEntry);
    const sha256 = createHash('sha256').update(archive).digest('hex');
    const existing = [...this.records.values()].find((record) => record.sha256 === sha256);
    if (existing) return cloneRecord(existing);
    const extensionId = `ext_${randomUUID().slice(0, 10)}`;
    const temporary = join(this.rootDir, `.tmp-${extensionId}`);
    const target = this.getDirectory(extensionId);
    await mkdir(temporary, { recursive: true, mode: 0o700 });
    try {
      const prefix = manifestEntry.slice(0, -'manifest.json'.length);
      for (const [archiveName, bytes] of Object.entries(entries)) {
        if (!archiveName.startsWith(prefix)) continue;
        const relative = archiveName.slice(prefix.length);
        if (!relative || relative.endsWith('/')) continue;
        const output = resolve(temporary, 'unpacked', ...relative.split('/'));
        const unpackedRoot = resolve(temporary, 'unpacked');
        if (output !== unpackedRoot && !output.startsWith(`${unpackedRoot}${sep}`)) throw new Error('EXTENSION_PATH_INVALID');
        await mkdir(dirname(output), { recursive: true, mode: 0o700 });
        await writeFile(output, bytes, { mode: 0o600 });
      }
      await writeFile(join(temporary, 'package.xpi'), archive, { mode: 0o600 });
      await rename(temporary, target);
    } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
    const now = Date.now();
    const contentSha256 = digestArchiveContents(entries, manifestEntry.slice(0, -'manifest.json'.length));
    const record: ManagedExtensionRecord = { extensionId, ...normalized, sha256, contentSha256, enabled: true, createdAt: now, updatedAt: now };
    this.records.set(extensionId, record); await this.persist(); return cloneRecord(record);
  }

  public async update(extensionId: string, input: { enabled?: boolean }): Promise<ManagedExtensionRecord> {
    await this.init(); const current = this.records.get(extensionId); if (!current) throw new Error('EXTENSION_NOT_FOUND');
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('EXTENSION_ENABLED_INVALID');
    const updated = { ...current, ...(input.enabled !== undefined ? { enabled: input.enabled } : {}), updatedAt: Date.now() };
    this.records.set(extensionId, updated); await this.persist(); return cloneRecord(updated);
  }

  public async delete(extensionId: string): Promise<boolean> {
    await this.init(); if (!this.records.delete(extensionId)) return false;
    await rm(this.getDirectory(extensionId), { recursive: true, force: true }); await this.persist(); return true;
  }

  public async resolveForLaunch(extensionIds: readonly string[], engine: 'chromium' | 'firefox'): Promise<ManagedExtensionLaunchDescriptor[]> {
    await this.init(); const result: ManagedExtensionLaunchDescriptor[] = []; const geckoIds = new Set<string>();
    for (const id of [...new Set(extensionIds)].slice(0, 32)) {
      const record = this.records.get(id); if (!record) throw new Error('EXTENSION_NOT_FOUND');
      if (!record.enabled) continue;
      if (!record.engines.includes(engine)) throw new Error('EXTENSION_ENGINE_UNSUPPORTED');
      const directory = this.getDirectory(id); const packagePath = join(directory, 'package.xpi');
      const hash = createHash('sha256').update(await readFile(packagePath)).digest('hex');
      if (hash !== record.sha256) throw new Error('EXTENSION_INTEGRITY_FAILED');
      if (await digestDirectory(join(directory, 'unpacked')) !== record.contentSha256) throw new Error('EXTENSION_INTEGRITY_FAILED');
      if (engine === 'firefox' && record.geckoId) {
        if (geckoIds.has(record.geckoId)) throw new Error('EXTENSION_GECKO_ID_CONFLICT');
        geckoIds.add(record.geckoId);
      }
      result.push({ extensionId: id, directory: join(directory, 'unpacked'), packagePath, ...(record.geckoId ? { geckoId: record.geckoId } : {}) });
    }
    return result;
  }

  private getDirectory(extensionId: string): string { if (!/^ext_[A-Za-z0-9_-]+$/.test(extensionId)) throw new Error('EXTENSION_ID_INVALID'); return join(this.rootDir, extensionId); }
  private persist(): Promise<void> { const operation = this.writeTail.then(() => atomicWriteFile(this.indexPath, JSON.stringify({ schemaVersion: 1, records: [...this.records.values()] }, null, 2))); this.writeTail = operation.catch(() => undefined); return operation; }
}

function validateArchivePath(name: string): void {
  const segments = name.split('/');
  if (!name || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.includes('\0')
    || segments.some((segment, index) => segment === '..' || segment === '.' || (!segment && index !== segments.length - 1))) throw new Error('EXTENSION_PATH_INVALID');
}
function locateManifest(names: string[]): string {
  const matches = names.filter((name) => name === 'manifest.json' || /^[^/]+\/manifest\.json$/.test(name));
  if (matches.length !== 1) throw new Error('EXTENSION_MANIFEST_INVALID'); return matches[0]!;
}
function validateManifest(manifest: WebExtensionManifest, approved: boolean, archiveNames: readonly string[], manifestEntry: string): Omit<ManagedExtensionRecord, 'extensionId' | 'sha256' | 'contentSha256' | 'enabled' | 'createdAt' | 'updatedAt'> {
  if (typeof manifest.name !== 'string' || !manifest.name.trim() || manifest.name.length > 128) throw new Error('EXTENSION_NAME_INVALID');
  if (typeof manifest.version !== 'string' || !/^\d+(?:\.\d+){0,3}$/.test(manifest.version)) throw new Error('EXTENSION_VERSION_INVALID');
  if (manifest.manifest_version !== 2 && manifest.manifest_version !== 3) throw new Error('EXTENSION_MANIFEST_VERSION_INVALID');
  const declaredPermissions = [...new Set([...stringArray(manifest.permissions), ...stringArray(manifest.optional_permissions)])];
  const permissions = declaredPermissions.filter((permission) => !isHostPermission(permission));
  const hostPermissions = [...new Set([
    ...stringArray(manifest.host_permissions), ...stringArray(manifest.optional_host_permissions),
    ...declaredPermissions.filter(isHostPermission),
    ...(Array.isArray(manifest.content_scripts) ? manifest.content_scripts.flatMap((script) => stringArray(script?.matches)) : []),
  ])].slice(0, 512);
  if (permissions.some((permission) => FORBIDDEN_PERMISSIONS.has(permission))) throw new Error('EXTENSION_PERMISSION_FORBIDDEN');
  const highRiskPermissions = permissions.filter((permission) => HIGH_RISK_PERMISSIONS.has(permission));
  if ((highRiskPermissions.length || hostPermissions.some(isBroadHostPermission)) && !approved) throw new Error('EXTENSION_HIGH_RISK_APPROVAL_REQUIRED');
  const geckoIdValue = manifest.browser_specific_settings?.gecko?.id ?? manifest.applications?.gecko?.id;
  const geckoId = typeof geckoIdValue === 'string' && isValidGeckoId(geckoIdValue) ? geckoIdValue : undefined;
  const lowerNames = new Set(archiveNames.map((name) => name.toLowerCase()));
  const firefoxSignaturePresent = manifestEntry === 'manifest.json'
    && lowerNames.has('meta-inf/mozilla.rsa') && lowerNames.has('meta-inf/mozilla.sf') && lowerNames.has('meta-inf/manifest.mf');
  const engines: Array<'chromium' | 'firefox'> = [];
  if (manifest.manifest_version === 3) engines.push('chromium');
  if (geckoId && firefoxSignaturePresent) engines.push('firefox');
  if (!engines.length) throw new Error('EXTENSION_ENGINE_UNSUPPORTED');
  return { name: manifest.name.trim(), version: manifest.version, manifestVersion: manifest.manifest_version, permissions, hostPermissions, highRiskPermissions, engines, firefoxSignaturePresent, ...(geckoId ? { geckoId } : {}) };
}
function stringArray(value: unknown): string[] { return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))].slice(0, 256) : []; }
function isHostPermission(value: string): boolean { return value === '<all_urls>' || value.includes('://'); }
function isBroadHostPermission(value: string): boolean { return value === '<all_urls>' || /^(?:\*|https?|wss?):\/\/\*\//.test(value); }
function isValidGeckoId(value: string): boolean { return /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$/.test(value) || /^\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}$/.test(value); }
function isCanonicalBase64(value: string): boolean {
  if (!value.length || value.length % 4 !== 0) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  for (let index = 0; index < value.length - padding; index += 1) {
    const code = value.charCodeAt(index);
    if (!((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 43 || code === 47)) return false;
  }
  return padding === 0 || !value.slice(0, -padding).includes('=');
}
function cloneRecord(record: ManagedExtensionRecord): ManagedExtensionRecord { return { ...record, permissions: [...record.permissions], hostPermissions: [...record.hostPermissions], highRiskPermissions: [...record.highRiskPermissions], engines: [...record.engines] }; }

function digestArchiveContents(entries: Record<string, Uint8Array>, prefix: string): string {
  const hash = createHash('sha256');
  for (const name of Object.keys(entries).filter((name) => name.startsWith(prefix) && !name.endsWith('/')).sort(comparePathNames)) {
    const relativeName = name.slice(prefix.length); hash.update(relativeName); hash.update('\0'); hash.update(entries[name]!); hash.update('\0');
  }
  return hash.digest('hex');
}

async function digestDirectory(root: string): Promise<string> {
  const files: string[] = [];
  const visit = async (directory: string) => { for (const entry of await readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) await visit(path); else if (entry.isFile()) files.push(path); else throw new Error('EXTENSION_INTEGRITY_FAILED'); } };
  await visit(root); const hash = createHash('sha256');
  for (const path of files.sort((a, b) => comparePathNames(relative(root, a), relative(root, b)))) { hash.update(relative(root, path).split(sep).join('/')); hash.update('\0'); hash.update(await readFile(path)); hash.update('\0'); }
  return hash.digest('hex');
}

function comparePathNames(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
