import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CHROMIX_RELEASE } from '../fingerprint/runtime-identity.js';
import type { FirefoxLaunchOptions } from './firefox-launcher.js';

const MANIFEST = 'chromix-install.json';
const EXPECTED_EXECUTABLE_SHA256 = 'f37fdf5e7bfad0c1885c9200b9cda5bee51e76975277429e20b8b76625c0abfc';
const EXPECTED_LIBRARY_SHA256 = '2475c0e9e8ce254c0d70e5556ffa1f778a54ed812489a0b107a6de838a826f3b';
const EXPECTED_INVENTORY_SHA256 = 'ff6264c465e053742d6738e83e2bf987c9968bb6a6e146f87e051423f6380cfb';
const DIGEST = /^[a-f0-9]{64}$/;

/** This selects an independent installed distribution; build-provenance.json is never consulted. */
export async function resolveVerifiedChromix(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ executablePath: string }> {
  const configured = environment.CHROMIX_EXECUTABLE_PATH?.trim();
  if (!configured || !isAbsolute(configured)) throw new Error('CHROMIX_PATH_REQUIRED: set absolute CHROMIX_EXECUTABLE_PATH');
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('CHROMIX_PLATFORM_UNSUPPORTED: Windows x64 required');
  if (basename(configured).toLowerCase() !== 'chrome.exe') throw new Error('CHROMIX_EXECUTABLE_MISMATCH');
  const root = dirname(configured);
  if (!await regularFile(configured) || !await regularFile(join(root, MANIFEST))) throw new Error('CHROMIX_INSTALL_INVALID: executable or manifest is not a regular file');
  if (resolve(await realpath(root)).toLowerCase() !== resolve(root).toLowerCase()) throw new Error('CHROMIX_INSTALL_INVALID: linked installation directory');
  const manifest: unknown = JSON.parse(await readFile(join(root, MANIFEST), 'utf8'));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('CHROMIX_MANIFEST_INVALID');
  const record = manifest as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.distribution !== CHROMIX_RELEASE.distribution
    || record.browserVersion !== CHROMIX_RELEASE.browserVersion || record.archiveSha256 !== CHROMIX_RELEASE.archiveSha256
    || Object.keys(record).sort().join(',') !== 'archiveSha256,browserVersion,distribution,files,schemaVersion'
    || !record.files || typeof record.files !== 'object' || Array.isArray(record.files)) {
    throw new Error('CHROMIX_MANIFEST_MISMATCH');
  }
  const inventory = record.files as Record<string, unknown>;
  if (!DIGEST.test(String(inventory['chrome.exe'] ?? '')) || !DIGEST.test(String(inventory['chrome.dll'] ?? ''))) {
    throw new Error('CHROMIX_MANIFEST_MISMATCH: chrome.exe and chrome.dll required');
  }
  if (inventory['chrome.exe'] !== EXPECTED_EXECUTABLE_SHA256
    || inventory['chrome.dll'] !== EXPECTED_LIBRARY_SHA256) {
    throw new Error('CHROMIX_MANIFEST_MISMATCH: official executable and library hashes required');
  }
  const remaining = new Set(Object.keys(inventory));
  const seenCase = new Set<string>();
  for (const name of remaining) {
    if (!safeInventoryPath(name) || !DIGEST.test(String(inventory[name])) || seenCase.has(name.toLowerCase())) {
      throw new Error('CHROMIX_MANIFEST_INVALID: unsafe path, case collision or digest');
    }
    seenCase.add(name.toLowerCase());
  }
  const inventoryHash = createHash('sha256');
  for (const name of [...remaining].sort()) inventoryHash.update(`${name}\t${inventory[name]}\n`, 'utf8');
  if (remaining.size !== 681 || inventoryHash.digest('hex') !== EXPECTED_INVENTORY_SHA256) {
    throw new Error('CHROMIX_MANIFEST_MISMATCH: official full-file inventory required');
  }
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = relative(root, path).split(sep).join('/');
      if ((name !== MANIFEST && !safeInventoryPath(name)) || entry.isSymbolicLink()
        || (!entry.isDirectory() && !entry.isFile()) || name.toLowerCase() === MANIFEST && name !== MANIFEST) {
        throw new Error(`CHROMIX_INSTALL_INVALID: unsafe filesystem entry ${name}`);
      }
      if (entry.isDirectory()) {
        if (!(await lstat(path)).isDirectory()) throw new Error(`CHROMIX_INSTALL_INVALID: linked directory ${name}`);
        pending.push(path);
      } else if (name !== MANIFEST) {
        if (!remaining.delete(name) || !await regularFile(path)) throw new Error(`CHROMIX_INSTALL_INVALID: extra or linked file ${name}`);
        const digest = await sha256(path);
        if (digest !== inventory[name]) throw new Error(`CHROMIX_FILE_HASH_MISMATCH: ${name}`);
      }
    }
  }
  if (remaining.size) throw new Error(`CHROMIX_INSTALL_INVALID: missing files ${[...remaining].join(',')}`);
  return { executablePath: configured };
}

function safeInventoryPath(name: string): boolean {
  return name !== MANIFEST && !name.includes('\\') && !name.includes(':') && !name.includes('\0')
    && name.split('/').every(part => part.length > 0 && part !== '.' && part !== '..' && !/[. ]$/.test(part));
}

async function regularFile(path: string): Promise<boolean> {
  try { return (await lstat(path)).isFile(); } catch { return false; }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Names are present in the released 93c851 source; binary behavior still requires isolated acceptance. */
export function chromixProfileArgs(options: FirefoxLaunchOptions): string[] {
  const profile = options.fingerprintProfile;
  if (!profile || profile.engine !== 'chromium' || profile.browserVersion !== CHROMIX_RELEASE.browserVersion || profile.os !== 'windows') {
    throw new Error('CHROMIX_PERSONA_INVALID: Windows Chromium 152 fingerprint required');
  }
  if (profile.syntheticDeviceTests) throw new Error('CHROMIX_SYNTHETIC_DEVICE_UNVERIFIED');
  if (profile.canvas.enabled || profile.audio.enabled) {
    throw new Error('CHROMIX_NOISE_UNSUPPORTED: native release launches disable canvas/audio perturbation');
  }
  if (!Number.isSafeInteger(profile.canvas.seed) || profile.canvas.seed < 1) {
    throw new Error('CHROMIX_FINGERPRINT_SEED_INVALID: seed must be a nonzero decimal integer');
  }
  const cores = profile.hardware.hardwareConcurrency;
  const memory = profile.hardware.deviceMemory;
  if (!Number.isInteger(cores) || cores < 1 || cores > 128 || ![0.25, 0.5, 1, 2, 4, 8, 16, 32].includes(memory)) {
    throw new Error('CHROMIX_HARDWARE_INVALID');
  }
  if (options.locale !== profile.geo.locale || options.timezoneId !== profile.geo.timezoneId) {
    throw new Error('CHROMIX_GEO_MISMATCH');
  }
  if (!Number.isInteger(profile.screen.width) || !Number.isInteger(profile.screen.height)
    || profile.screen.width < 1 || profile.screen.height < 1
    || profile.screen.width > 32768 || profile.screen.height > 32768
    || profile.screen.availWidth !== profile.screen.width
    || !Number.isInteger(profile.screen.availHeight) || profile.screen.availHeight < 1
    || profile.screen.availHeight > profile.screen.height) {
    throw new Error('CHROMIX_SCREEN_GEOMETRY_INVALID');
  }
  if (!profile.platformVersion || !/^\d+(?:\.\d+){1,3}$/.test(profile.platformVersion)) {
    throw new Error('CHROMIX_PLATFORM_VERSION_INVALID');
  }
  const locale = Intl.getCanonicalLocales(profile.geo.locale)[0]!;
  const languages = profile.geo.languages.map(language => Intl.getCanonicalLocales(language)[0]!);
  if (!languages.length || languages[0] !== locale || new Set(languages).size !== languages.length) {
    throw new Error('CHROMIX_LANGUAGE_MISMATCH: native languages must match the profile locale and HTTP languages');
  }
  const fonts = profile.fontPolicy?.allowlist;
  if (fonts !== undefined && (!fonts.length || fonts.length > 256
    || fonts.some(font => !font || font !== font.trim() || font.length > 128 || /[,\u0000-\u001f]/.test(font))
    || new Set(fonts.map(font => font.toLowerCase())).size !== fonts.length)) {
    throw new Error('CHROMIX_FONT_POLICY_INVALID: provide 1–256 distinct font family names without commas or controls');
  }
  const timezone = new Intl.DateTimeFormat('en-US', { timeZone: profile.geo.timezoneId }).resolvedOptions().timeZone;
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(timezone)) throw new Error('CHROMIX_TIMEZONE_INVALID');
  return [
    `--fingerprint=${profile.canvas.seed}`,
    '--fingerprint-platform=windows',
    `--fingerprint-brand-version=${CHROMIX_RELEASE.browserVersion}`,
    '--fingerprint-brand=Chrome',
    `--fingerprint-platform-version=${profile.platformVersion}`,
    `--fingerprint-hardware-concurrency=${cores}`,
    `--fingerprint-device-memory=${memory}`,
    `--fingerprint-screen-width=${profile.screen.width}`,
    `--fingerprint-screen-height=${profile.screen.height}`,
    `--fingerprint-taskbar-height=${profile.screen.height - profile.screen.availHeight}`,
    `--fingerprint-timezone=${timezone}`,
    `--fingerprint-locale=${locale}`,
    `--uxr-languages=${languages.join(',')}`,
    '--fingerprint-noise=false',
    ...(fonts ? ['--fingerprint-font-policy=restricted', `--fingerprint-font-whitelist=${fonts.join(',')}`] : []),
  ];
}
