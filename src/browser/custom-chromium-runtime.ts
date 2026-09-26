import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { FirefoxLaunchOptions } from './firefox-launcher.js';
import { managedBrowserIdentity } from '../fingerprint/runtime-identity.js';

export const EXPECTED_CHROMIUM_CORE = Object.freeze({
  chromiumRevision: '782af9cb30a53f54487e5d2e44738645a8ec457c',
  playwrightVersion: '1.62.1',
  patchPath: 'patches/0001-native-process-profile.patch',
  patchSha256: 'df671ba4895f1853a2d89554f0cc716043b96d7491747aa6b906f9a10e6228e5',
  renderingPatchPath: 'patches/0002-native-rendering-surfaces.patch',
  renderingPatchSha256: '71e9dcd83e60d99683a68a749b85d103ee50113a33fe11d66cac32d4a97ad444',
});

export async function resolveVerifiedChromiumCore(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ executablePath: string } | undefined> {
  const configured = environment.ABS_CHROMIUM_EXECUTABLE_PATH?.trim();
  if (!configured) return undefined;
  if (!isAbsolute(configured)) throw new Error('CUSTOM_CHROMIUM_PATH_INVALID: use an absolute path');
  const target = process.platform === 'win32' && process.arch === 'x64' ? 'win-x64'
    : process.platform === 'linux' && process.arch === 'x64' ? 'linux-x64' : undefined;
  if (!target) throw new Error('CUSTOM_CHROMIUM_PLATFORM_UNSUPPORTED');
  const executablePath = await realpath(configured);
  if (!(await stat(executablePath)).isFile()) throw new Error('CUSTOM_CHROMIUM_NOT_FILE');
  if (basename(executablePath).toLowerCase() !== (target === 'win-x64' ? 'chrome.exe' : 'chrome')) {
    throw new Error('CUSTOM_CHROMIUM_EXECUTABLE_MISMATCH');
  }
  const provenance: unknown = JSON.parse(await readFile(join(dirname(executablePath), 'build-provenance.json'), 'utf8'));
  if (!provenance || typeof provenance !== 'object') throw new Error('CUSTOM_CHROMIUM_PROVENANCE_INVALID');
  const record = provenance as Record<string, unknown>;
  const patches = Array.isArray(record.patches) ? record.patches : [];
  if (record.schemaVersion !== 1 || record.engine !== 'chromium' || record.target !== target
      || record.browserVersion !== managedBrowserIdentity('chromium').fullVersion
      || record.chromiumRevision !== EXPECTED_CHROMIUM_CORE.chromiumRevision
      || record.playwrightVersion !== EXPECTED_CHROMIUM_CORE.playwrightVersion
      || patches.length !== 2
      || patches[0]?.path !== EXPECTED_CHROMIUM_CORE.patchPath
      || patches[0]?.sha256 !== EXPECTED_CHROMIUM_CORE.patchSha256
      || patches[1]?.path !== EXPECTED_CHROMIUM_CORE.renderingPatchPath
      || patches[1]?.sha256 !== EXPECTED_CHROMIUM_CORE.renderingPatchSha256) {
    throw new Error('CUSTOM_CHROMIUM_PROVENANCE_MISMATCH');
  }
  const files = record.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    throw new Error('CUSTOM_CHROMIUM_PROVENANCE_MISMATCH');
  }
  const inventory = files as Record<string, unknown>;
  const remaining = new Set(Object.keys(inventory));
  const executableName = target === 'win-x64' ? 'chrome.exe' : 'chrome';
  if (inventory[executableName] !== record.executableSha256 ||
      (target === 'win-x64' && !remaining.has('chrome.dll'))) {
    throw new Error('CUSTOM_CHROMIUM_PROVENANCE_MISMATCH');
  }
  for (const name of remaining) {
    const expectedHash = inventory[name];
    if (name === 'build-provenance.json' || name.includes('\\') || name.includes(':') ||
        name.split('/').some(part => !part || part === '.' || part === '..') ||
        typeof expectedHash !== 'string' || !/^[0-9a-f]{64}$/.test(expectedHash)) {
      throw new Error('CUSTOM_CHROMIUM_PROVENANCE_MISMATCH');
    }
  }
  const root = dirname(executablePath);
  const directories = [root];
  while (directories.length) {
    const directory = directories.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('CUSTOM_CHROMIUM_PROVENANCE_MISMATCH');
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(path);
        continue;
      }
      if (!entry.isFile()) throw new Error('CUSTOM_CHROMIUM_PROVENANCE_MISMATCH');
      const name = relative(root, path).split(sep).join('/');
      if (name === 'build-provenance.json') continue;
      if (!remaining.has(name)) throw new Error('CUSTOM_CHROMIUM_PROVENANCE_MISMATCH');
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      if (hash.digest('hex') !== inventory[name]) throw new Error('CUSTOM_CHROMIUM_HASH_MISMATCH');
      remaining.delete(name);
    }
  }
  if (remaining.size) throw new Error('CUSTOM_CHROMIUM_PROVENANCE_MISMATCH');
  return { executablePath };
}

export function nativeChromiumProfileArgs(
  options: FirefoxLaunchOptions,
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  const profile = options.fingerprintProfile;
  const locale = options.locale ?? profile?.geo.locale;
  const timezone = options.timezoneId ?? profile?.geo.timezoneId;
  const args: string[] = [];
  if (locale) {
    const canonical = Intl.getCanonicalLocales(locale)[0]!;
    const languages = profile?.geo.languages ?? [canonical];
    const canonicalLanguages = languages.map(language => Intl.getCanonicalLocales(language)[0]!);
    if (!canonicalLanguages.length || canonicalLanguages[0] !== canonical) {
      throw new Error('CUSTOM_CHROMIUM_LANGUAGE_MISMATCH');
    }
    args.push(`--abs-locale=${canonical}`, `--abs-languages=${canonicalLanguages.join(',')}`,
      `--accept-lang=${canonicalLanguages.join(',')}`);
  }
  if (timezone) {
    // Validate before a malformed native flag can crash a renderer.
    const canonical = new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone;
    if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(canonical)) throw new Error('CUSTOM_CHROMIUM_TIMEZONE_INVALID');
    args.push(`--abs-timezone=${canonical}`);
  }
  if (profile) {
    const cores = profile.hardware.hardwareConcurrency;
    if (!Number.isInteger(cores) || cores < 1 || cores > 256) throw new Error('CUSTOM_CHROMIUM_CORES_INVALID');
    args.push(`--abs-hardware-concurrency=${cores}`);
    const memory = profile.hardware.deviceMemory;
    if (![0.25, 0.5, 1, 2, 4, 8].includes(memory)) throw new Error('CUSTOM_CHROMIUM_MEMORY_INVALID');
    args.push(`--abs-device-memory=${memory}`);
    for (const [surface, config] of [['canvas', profile.canvas], ['audio', profile.audio]] as const) {
      if (!config.enabled) continue;
      if (!Number.isInteger(config.seed) || config.seed < 0 || config.seed > 0xffffffff) {
        throw new Error(`CUSTOM_CHROMIUM_${surface.toUpperCase()}_SEED_INVALID`);
      }
      args.push(`--abs-${surface}-seed=${config.seed}`);
    }
    const stringFlag = (name: string, value: string | undefined) => {
      if (value === undefined) return;
      if (!value.trim() || value.length > 512 || !/^[\x20-\x7e]+$/.test(value)) {
        throw new Error(`CUSTOM_CHROMIUM_IDENTITY_INVALID: ${name}`);
      }
      args.push(`--abs-${name}=${value}`);
    };
    stringFlag('webgl-vendor', profile.webgl.unmaskedVendor);
    stringFlag('webgl-renderer', profile.webgl.unmaskedRenderer);
    if (!profile.webgpu.supported) {
      args.push('--abs-webgpu-disabled=1');
    } else if (profile.webgpu.adapterInfo) {
      for (const field of ['vendor', 'architecture', 'device', 'description'] as const) {
        // Empty metadata denotes an unknown field; preserve the real backend.
        const value = profile.webgpu.adapterInfo[field];
        if (value) stringFlag(`webgpu-${field}`, value);
      }
    }
    const fonts = environment.ABS_CHROMIUM_FONT_ALLOWLIST ?? profile.fontPolicy?.allowlist?.join(',');
    if (fonts !== undefined) {
      const families = fonts.split(',').map(family => family.trim());
      if (families.length > 128 || families.some(family => !family || family.length > 128
          || !/^[\x20-\x7e]+$/.test(family))) throw new Error('CUSTOM_CHROMIUM_FONTS_INVALID');
      args.push(`--abs-font-allowlist=${[...new Set(families)].join(',')}`);
    }
  }
  return args;
}
