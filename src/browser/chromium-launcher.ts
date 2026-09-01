/** Chromium launch/attach adapter used by the optional control-plane worker. */
import { assertManagedRuntimeVersion } from './firefox-launcher.js';
import type { FirefoxContextLike, FirefoxLaunchOptions, FirefoxLauncherLike, FirefoxPageLike } from './firefox-launcher.js';
import type { UnifiedFingerprintProfile } from '../fingerprint/types.js';
import { buildWorkerBootstrap } from '../fingerprint/stealth-scripts.js';
import { RawCdpConnection, type RawCdpEvent } from './raw-cdp-connection.js';

interface ChromiumCdpContext extends FirefoxContextLike {
  newCDPSession(page: FirefoxPageLike): Promise<{
    send(method: string, parameters: Record<string, unknown>): Promise<unknown>;
  }>;
}

export interface ChromiumLauncherLike extends FirefoxLauncherLike {
  connectOverCDP(endpoint: string): Promise<FirefoxContextLike>;
}

export async function launchPersistentChromium(
  profileDirectory: string,
  options: FirefoxLaunchOptions,
): Promise<FirefoxContextLike> {
  if (options.headless && options.managedExtensions?.length) throw new Error('EXTENSION_HEADED_REQUIRED');
  const module = await import('playwright');
  const chromium = module.chromium as unknown as {
    launchPersistentContext(directory: string, launchOptions: Record<string, unknown>): Promise<FirefoxContextLike>;
  };
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
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--excludeSwitches=enable-automation',
      '--use-mock-keychain',
      ...(options.fingerprintProfile ? [
        '--remote-debugging-port=0',
        '--remote-debugging-address=127.0.0.1',
        `--user-agent=${options.fingerprintProfile.userAgent}`,
      ] : []),
      ...managedChromiumArgs(options.managedExtensions),
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    acceptDownloads: false,
  };

  // Only the Playwright-managed Chromium build is allowed. Falling back to a
  // locally installed Chrome or Edge would invalidate the generated profile.
  const context = await chromium.launchPersistentContext(profileDirectory, launchConfig);
  await assertManagedRuntimeVersion(context, 'chromium');
  if (options.fingerprintProfile) {
    await installManagedServiceWorkerIdentity(context, options.fingerprintProfile, profileDirectory);
    await installManagedChromiumIdentity(context as ChromiumCdpContext, options.fingerprintProfile);
  }

  if (options.initScript && typeof context?.addInitScript === 'function') {
    await context.addInitScript(options.initScript);
  }

  return context;
}

async function installManagedServiceWorkerIdentity(
  context: FirefoxContextLike,
  profile: UnifiedFingerprintProfile,
  profileDirectory: string,
): Promise<void> {
  let connection: RawCdpConnection;
  try {
    connection = await RawCdpConnection.connect(profileDirectory);
  } catch (error) {
    await context.close().catch(() => undefined);
    throw new Error(`SERVICE_WORKER_FINGERPRINT_SETUP_FAILED:${error instanceof Error ? error.message : 'unknown'}`);
  }
  context.on?.('close', () => connection.close());
  const configuredTargets = new Set<string>();
  const override = managedChromiumUserAgentOverride(profile);
  const bootstrap = buildWorkerBootstrap(profile);

  const configureTarget = async (sessionId: string, targetId: string, paused: boolean): Promise<void> => {
    try {
      await connection.send('Emulation.setUserAgentOverride', override, sessionId);
      await connection.send('Network.setUserAgentOverride', override, sessionId);
      const evaluation = await connection.send('Runtime.evaluate', {
        expression: bootstrap,
        awaitPromise: false,
        returnByValue: false,
      }, sessionId);
      if (evaluation.exceptionDetails) throw new Error('SERVICE_WORKER_BOOTSTRAP_EVALUATION_FAILED');
    } finally {
      if (paused) await connection.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => undefined);
    }
    configuredTargets.add(targetId);
  };

  const handleAttached = (event: RawCdpEvent): void => {
    if (event.method !== 'Target.attachedToTarget') return;
    const params = event.params;
    const target = params?.targetInfo as { targetId?: unknown; type?: unknown } | undefined;
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : event.sessionId;
    const targetId = typeof target?.targetId === 'string' ? target.targetId : undefined;
    if (target?.type !== 'service_worker' || !sessionId || !targetId || configuredTargets.has(targetId)) return;
    configuredTargets.add(targetId);
    void configureTarget(sessionId, targetId, true).catch(() => context.close().catch(() => undefined));
  };
  connection.onEvent(handleAttached);

  try {
    await connection.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [{ type: 'service_worker', exclude: false }, { exclude: true }],
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const targets = await connection.send('Target.getTargets', {
      filter: [{ type: 'service_worker', exclude: false }, { exclude: true }],
    });
    const targetInfos = Array.isArray(targets.targetInfos) ? targets.targetInfos : [];
    for (const item of targetInfos) {
      const target = item as { targetId?: unknown; type?: unknown };
      if (target.type !== 'service_worker' || typeof target.targetId !== 'string' || configuredTargets.has(target.targetId)) continue;
      configuredTargets.add(target.targetId);
      const attached = await connection.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      if (typeof attached.sessionId !== 'string') throw new Error('SERVICE_WORKER_CDP_SESSION_MISSING');
      await configureTarget(attached.sessionId, target.targetId, false);
    }
  } catch (error) {
    connection.close();
    await context.close().catch(() => undefined);
    throw new Error(`SERVICE_WORKER_FINGERPRINT_SETUP_FAILED:${error instanceof Error ? error.message : 'unknown'}`);
  }
}

async function installManagedChromiumIdentity(
  context: ChromiumCdpContext,
  profile: UnifiedFingerprintProfile,
): Promise<void> {
  const configured = new WeakMap<object, Promise<void>>();
  const override = managedChromiumUserAgentOverride(profile);
  const applyToPage = (page: FirefoxPageLike): Promise<void> => {
    const existing = configured.get(page);
    if (existing) return existing;
    const pending = (async () => {
      const client = await context.newCDPSession(page);
      await client.send('Emulation.setUserAgentOverride', override);
    })();
    configured.set(page, pending);
    return pending;
  };

  for (const page of context.pages?.() ?? []) await applyToPage(page);
  context.on?.('page', (...args: unknown[]) => {
    const page = args[0] as FirefoxPageLike | undefined;
    if (page) void applyToPage(page).catch(() => page.close?.().catch(() => undefined));
  });
  const originalNewPage = context.newPage?.bind(context);
  if (originalNewPage) {
    context.newPage = async () => {
      const page = await originalNewPage();
      await applyToPage(page);
      return page;
    };
  }
}

function managedChromiumUserAgentOverride(profile: UnifiedFingerprintProfile): Record<string, unknown> {
  const major = profile.browserVersion.split('.')[0]!;
  const platform = profile.os === 'macos' ? 'macOS' : profile.os === 'linux' ? 'Linux' : 'Windows';
  const platformVersion = profile.os === 'macos' ? '10.15.7' : profile.os === 'linux' ? '6.8.0' : '10.0.0';
  return {
    userAgent: profile.userAgent,
    acceptLanguage: profile.geo.languages.join(','),
    platform: profile.platform,
    userAgentMetadata: {
      brands: [
        { brand: 'Chromium', version: major },
        { brand: 'Not=A?Brand', version: '99' },
      ],
      fullVersionList: [
        { brand: 'Chromium', version: profile.browserVersion },
        { brand: 'Not=A?Brand', version: '99.0.0.0' },
      ],
      fullVersion: profile.browserVersion,
      platform,
      platformVersion,
      architecture: 'x86',
      model: '',
      mobile: false,
      bitness: '64',
      wow64: false,
      formFactors: ['Desktop'],
    },
  };
}

export async function connectChromiumOverCDP(endpoint: string): Promise<FirefoxContextLike> {
  const module = await import('playwright');
  const chromium = module.chromium as unknown as {
    connectOverCDP(endpoint: string): Promise<{
      contexts(): FirefoxContextLike[];
      newContext?(): Promise<FirefoxContextLike>;
    }>;
  };
  const browser = await chromium.connectOverCDP(endpoint);
  const existing = browser.contexts()[0];
  if (existing) return existing;
  if (!browser.newContext) throw new Error('CDP browser did not expose a context');
  return browser.newContext();
}

export const defaultChromiumLauncher: ChromiumLauncherLike = {
  launchPersistentContext: launchPersistentChromium,
  connectOverCDP: connectChromiumOverCDP,
};

function managedChromiumArgs(extensions: FirefoxLaunchOptions['managedExtensions']): string[] {
  if (!extensions?.length) return [];
  const directories = extensions.map((extension) => extension.directory).join(',');
  return [`--disable-extensions-except=${directories}`, `--load-extension=${directories}`];
}
