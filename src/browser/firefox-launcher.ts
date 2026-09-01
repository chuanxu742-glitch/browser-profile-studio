/**
 * Narrow Playwright Firefox adapter. Keeping launch behind this interface
 * makes lifecycle tests use a local fake without weakening production rules.
 */
export interface FirefoxContextLike {
  browser?(): { version(): string } | null;
  pages?(): FirefoxPageLike[];
  newPage?(): Promise<FirefoxPageLike>;
  close(): Promise<void>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  route?(pattern: string, handler: (...args: unknown[]) => Promise<void> | void): Promise<void>;
  setDefaultTimeout?(milliseconds: number): void;
  setDefaultNavigationTimeout?(milliseconds: number): void;
  addInitScript?(script: string | { content?: string }): Promise<void>;
  addCookies?(cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
  }>): Promise<void>;
  cookies?(): Promise<Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'Strict' | 'Lax' | 'None';
  }>>;
}

export interface FirefoxPageLike {
  url(): string;
  goto?(url: string, options?: Record<string, unknown>): Promise<unknown>;
  close?(): Promise<void>;
  bringToFront?(): Promise<void>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  locator(selector: string): unknown;
  evaluate?(expression: string, arg?: unknown): Promise<unknown>;
  [key: string]: unknown;
}

export interface FirefoxLaunchOptions {
  headless: boolean;
  viewport?: { width: number; height: number } | undefined;
  proxy?: {
    server: string;
    username?: string;
    password?: string;
    bypass?: string;
  } | undefined;
  timezoneId?: string | undefined;
  locale?: string | undefined;
  geolocation?: { latitude: number; longitude: number; accuracy?: number } | undefined;
  permissions?: string[] | undefined;
  extraHTTPHeaders?: Record<string, string> | undefined;
  userAgent?: string | undefined;
  initScript?: string | undefined;
  managedExtensions?: readonly {
    extensionId: string;
    directory: string;
    packagePath: string;
    geckoId?: string;
  }[] | undefined;
  fingerprintProfile?: import('../fingerprint/types.js').UnifiedFingerprintProfile | undefined;
}

export interface FirefoxLauncherLike {
  launchPersistentContext(profileDirectory: string, options: FirefoxLaunchOptions): Promise<FirefoxContextLike>;
}

import { join } from 'node:path';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { atomicWriteFile } from '../storage/atomic-file.js';
import { managedBrowserIdentity } from '../fingerprint/runtime-identity.js';
import type { UnifiedFingerprintProfile } from '../fingerprint/types.js';
import { resolveVerifiedFirefoxCore } from './custom-firefox-runtime.js';

/**
 * Firefox reads these preferences inside Window, Dedicated/Shared Worker and
 * Service Worker globals. Using the native preference path also aligns the
 * HTTP User-Agent and Accept-Language headers before worker script execution.
 */
export function firefoxFingerprintUserPrefs(profile?: UnifiedFingerprintProfile): Record<string, string | number | boolean> {
  if (!profile) return {};
  return {
    'general.useragent.override': profile.userAgent,
    'general.appversion.override': profile.appVersion,
    'general.platform.override': profile.platform,
    ...(profile.oscpu ? { 'general.oscpu.override': profile.oscpu } : {}),
    'intl.accept_languages': profile.geo.languages.join(', '),
    'dom.maxHardwareConcurrency': profile.hardware.hardwareConcurrency,
    'dom.antigravityFingerprintHardwareConcurrency': profile.hardware.hardwareConcurrency,
    'dom.antigravityFingerprintTimezone': profile.geo.timezoneId,
    'webgl.vendor-string-override': profile.webgl.unmaskedVendor || profile.webgl.vendor,
    'webgl.renderer-string-override': profile.webgl.unmaskedRenderer || profile.webgl.renderer,
  };
}

/** Launch only the version-locked Playwright Firefox build. Engine substitution is forbidden. */
export async function launchPersistentFirefox(
  profileDirectory: string,
  options: FirefoxLaunchOptions,
): Promise<FirefoxContextLike> {
  const module = await import('playwright');
  const firefox = module.firefox as unknown as {
    launchPersistentContext(directory: string, launchOptions: Record<string, unknown>): Promise<FirefoxContextLike>;
  };
  await installManagedFirefoxExtensions(profileDirectory, options.managedExtensions ?? []);
  const customCore = await resolveVerifiedFirefoxCore();

  const launchConfig = {
    headless: options.headless,
    ...(options.viewport ? { viewport: options.viewport } : {}),
    ...(options.proxy ? { proxy: options.proxy } : {}),
    ...(options.timezoneId ? { timezoneId: options.timezoneId } : {}),
    ...(options.locale ? { locale: options.locale } : {}),
    ...(options.geolocation ? { geolocation: options.geolocation } : {}),
    ...(options.permissions ? { permissions: options.permissions } : {}),
    ...(options.extraHTTPHeaders ? { extraHTTPHeaders: options.extraHTTPHeaders } : {}),
    ...(options.userAgent ? { userAgent: options.userAgent } : {}),
    ...(customCore ? { executablePath: customCore.executablePath } : {}),
    args: [
      '--window-size=1280,800',
      '--window-position=100,100',
    ],
    firefoxUserPrefs: {
      'dom.webdriver.enabled': false,
      'privacy.resistFingerprinting': false,
      'media.peerconnection.ice.default_address_only': true,
      'webgl.force-enabled': true,
      'layers.acceleration.force-enabled': true,
      'gfx.font_rendering.cleartype_params.rendering_mode': 5,
      ...(options.managedExtensions?.length ? {
        'extensions.autoDisableScopes': 0,
        'extensions.enabledScopes': 15,
        'extensions.update.enabled': false,
      } : {}),
      ...firefoxFingerprintUserPrefs(options.fingerprintProfile),
    },
    acceptDownloads: false,
  };

  const context = await firefox.launchPersistentContext(profileDirectory, launchConfig);
  await assertManagedRuntimeVersion(context, 'firefox');

  if (options.initScript && typeof context?.addInitScript === 'function') {
    await context.addInitScript(options.initScript);
  }

  return context;
}

export async function assertManagedRuntimeVersion(
  context: FirefoxContextLike,
  engine: 'firefox' | 'chromium',
): Promise<void> {
  const actualVersion = context.browser?.()?.version();
  const expectedVersion = managedBrowserIdentity(engine).fullVersion;
  if (actualVersion !== undefined && actualVersion !== expectedVersion) {
    await context.close().catch(() => undefined);
    throw new Error(`BROWSER_RUNTIME_VERSION_MISMATCH: expected ${engine} ${expectedVersion}, received ${actualVersion}`);
  }
}

export const defaultFirefoxLauncher: FirefoxLauncherLike = {
  launchPersistentContext: launchPersistentFirefox,
};

async function installManagedFirefoxExtensions(profileDirectory: string, extensions: NonNullable<FirefoxLaunchOptions['managedExtensions']>): Promise<void> {
  const extensionsDirectory = join(profileDirectory, 'extensions');
  const indexPath = join(profileDirectory, '.abs-managed-extensions.json');
  let previous: string[] = [];
  try { previous = JSON.parse(await readFile(indexPath, 'utf8')) as string[]; } catch { /* First launch. */ }
  const filenames = extensions.filter((extension) => extension.geckoId).map((extension) => `${extension.geckoId}.xpi`);
  for (const filename of previous) {
    if (/^[A-Za-z0-9._@{}-]+\.xpi$/.test(filename) && !filenames.includes(filename)) await rm(join(extensionsDirectory, filename), { force: true });
  }
  if (filenames.length) await mkdir(extensionsDirectory, { recursive: true, mode: 0o700 });
  for (const extension of extensions) {
    if (!extension.geckoId) continue;
    await copyFile(extension.packagePath, join(extensionsDirectory, `${extension.geckoId}.xpi`));
  }
  await atomicWriteFile(indexPath, JSON.stringify(filenames));
}
