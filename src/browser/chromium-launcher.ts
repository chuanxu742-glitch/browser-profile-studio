/** Chromium launch/attach adapter used by the optional control-plane worker. */
import { createRequire } from 'node:module';
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
  if (options.fingerprintProfile) {
    const dependency = createRequire(import.meta.url)('playwright-core/package.json') as { version?: unknown };
    if (dependency.version !== '1.62.1') throw new Error('WORKER_FINGERPRINT_SETUP_FAILED: requires pinned Playwright 1.62.1');
  }
  const module = await import('playwright');
  const chromium = module.chromium as unknown as {
    launchPersistentContext(directory: string, launchOptions: Record<string, unknown>): Promise<FirefoxContextLike>;
  };
  const extraHTTPHeaders = { ...options.extraHTTPHeaders };
  if (options.fingerprintProfile) {
    const languages = options.fingerprintProfile.geo.languages;
    const explicitLanguages = Object.entries(extraHTTPHeaders).filter(([name]) => name.toLowerCase() === 'accept-language');
    for (const [, value] of explicitLanguages) {
      const requested = value.split(',').map((item) => item.split(';')[0]!.trim().toLowerCase());
      if (requested.length !== languages.length || requested.some((language, index) => language !== languages[index]!.toLowerCase())) {
        throw new Error('FINGERPRINT_ACCEPT_LANGUAGE_MISMATCH: explicit header must match the managed language list');
      }
    }
    if (!explicitLanguages.length) extraHTTPHeaders['Accept-Language'] = languages.join(',');
  }
  const launchConfig = {
    headless: options.headless,
    ...(options.viewport ? { viewport: options.viewport } : {}),
    ...(options.fingerprintProfile ? {
      screen: { width: options.fingerprintProfile.screen.width, height: options.fingerprintProfile.screen.height },
      deviceScaleFactor: options.fingerprintProfile.screen.devicePixelRatio,
    } : {}),
    ...(options.proxy ? { proxy: options.proxy } : {}),
    ...(options.timezoneId ? { timezoneId: options.timezoneId } : {}),
    ...(options.locale ? { locale: options.locale } : {}),
    ...(options.geolocation ? { geolocation: options.geolocation } : {}),
    ...(options.permissions ? { permissions: options.permissions } : {}),
    ...(Object.keys(extraHTTPHeaders).length ? { extraHTTPHeaders } : {}),
    ...(options.userAgent ? { userAgent: options.userAgent } : {}),
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--use-mock-keychain',
      ...(options.fingerprintProfile ? [
        '--remote-debugging-port=0',
        '--remote-debugging-address=127.0.0.1',
        `--user-agent=${options.fingerprintProfile.userAgent}`,
        `--lang=${options.fingerprintProfile.geo.locale}`,
        `--accept-lang=${options.fingerprintProfile.geo.languages.join(',')}`,
        ...(options.fingerprintProfile.webrtc === 'block_leak' || options.fingerprintProfile.webrtc === 'replace'
          ? ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp']
          : []),
      ] : []),
      ...managedChromiumArgs(options.managedExtensions),
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    acceptDownloads: false,
  };

  // Only the Playwright-managed Chromium build is allowed. Falling back to a
  // locally installed Chrome or Edge would invalidate the generated profile.
  const context = await chromium.launchPersistentContext(profileDirectory, launchConfig);
  try {
    await assertManagedRuntimeVersion(context, 'chromium');
    if (options.fingerprintProfile) {
      await installManagedWorkerIdentity(context, options.fingerprintProfile, profileDirectory);
      await installManagedChromiumIdentity(context as ChromiumCdpContext, options.fingerprintProfile);
    }
    if (options.initScript && typeof context?.addInitScript === 'function') {
      await context.addInitScript(options.initScript);
    }
    return context;
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
}

async function installManagedWorkerIdentity(
  context: FirefoxContextLike,
  profile: UnifiedFingerprintProfile,
  profileDirectory: string,
): Promise<void> {
  const startupGate = await gatePlaywrightWorkerStartup(context, profile);
  const connection = await RawCdpConnection.connect(profileDirectory).catch(async (error: unknown) => {
    await context.close().catch(() => undefined);
    throw new Error(`WORKER_FINGERPRINT_SETUP_FAILED:${error instanceof Error ? error.message : 'unknown'}`);
  });
  let closed = false;
  context.on?.('close', () => { closed = true; connection.close(); });
  const targets = new Map<string, { sessionId: string; ready: Promise<void> }>();
  const workerTypes: Record<string, true> = { worker: true, shared_worker: true, service_worker: true };
  const filter = [
    ...['page', 'iframe', ...Object.keys(workerTypes)].map((type) => ({ type, exclude: false })),
    { exclude: true },
  ];
  const autoAttach = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter };
  // Shared/service workers are browser-owned targets. Auto-attaching them again
  // through their page creates a second startup pause and deadlocks Runtime.enable.
  const childAutoAttach = {
    ...autoAttach,
    filter: [{ type: 'iframe', exclude: false }, { type: 'worker', exclude: false }, { exclude: true }],
  };
  const override = managedChromiumUserAgentOverride(profile);
  const bootstrap = buildWorkerBootstrap(profile);

  const configure = (sessionId: string, targetId: string, type: string, paused: boolean): Promise<void> => {
    const previous = targets.get(targetId);
    if (previous) return previous.ready;
    const ready = (async () => {
      // Auto-attachment is not recursive: each page/worker must also pause its
      // own children. This covers URL, module, shared and nested workers.
      await connection.send('Target.setAutoAttach', childAutoAttach, sessionId);
      if (workerTypes[type]) {
        await connection.send('Runtime.enable', {}, sessionId);
        await connection.send('Network.setUserAgentOverride', override, sessionId);
        const evaluated = await connection.send('Runtime.evaluate', {
          expression: bootstrap,
          awaitPromise: false,
          returnByValue: true,
        }, sessionId);
        if (evaluated.exceptionDetails) {
          throw new Error(`WORKER_BOOTSTRAP_FAILED:${JSON.stringify(evaluated.exceptionDetails)}`);
        }
      } else {
        await connection.send('Emulation.setUserAgentOverride', override, sessionId);
        await connection.send('Emulation.setHardwareConcurrencyOverride', {
          hardwareConcurrency: profile.hardware.hardwareConcurrency,
        }, sessionId);
      }
      startupGate.release(targetId);
      if (paused) await connection.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
    })();
    targets.set(targetId, { sessionId, ready });
    return ready;
  };

  const failAttachedTarget = (targetId: string, error: unknown): void => {
    if (closed || !targets.has(targetId)) return;
    // Never resume a live target with a partially installed identity.
    console.error('Worker fingerprint initialization failed:', error);
    void context.close().catch(() => undefined);
  };
  const handleAttached = (event: RawCdpEvent): void => {
    if (event.method === 'Target.detachedFromTarget') {
      const sessionId = event.params?.sessionId;
      for (const [id, target] of targets) {
        if (target.sessionId === sessionId) {
          targets.delete(id);
          startupGate.forgetTarget(id);
        }
      }
      return;
    }
    if (event.method !== 'Target.attachedToTarget') return;
    const params = event.params;
    const target = params?.targetInfo as { targetId?: unknown; type?: unknown } | undefined;
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : undefined;
    if (!sessionId || typeof target?.targetId !== 'string' || typeof target.type !== 'string') return;
    const targetId = target.targetId;
    void configure(sessionId, targetId, target.type, params?.waitingForDebugger === true)
      .catch((error: unknown) => failAttachedTarget(targetId, error));
  };
  connection.onEvent(handleAttached);
  try {
    await connection.send('Target.setAutoAttach', autoAttach);
    const available = await connection.send('Target.getTargets', { filter });
    for (const item of Array.isArray(available.targetInfos) ? available.targetInfos : []) {
      const target = item as { targetId?: unknown; type?: unknown };
      if (typeof target.targetId !== 'string' || typeof target.type !== 'string') continue;
      if (!targets.has(target.targetId)) {
        const attached = await connection.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
        if (typeof attached.sessionId !== 'string') throw new Error('WORKER_CDP_SESSION_MISSING');
        await configure(attached.sessionId, target.targetId, target.type, false);
      }
    }
    await Promise.all([...targets.values()].map((target) => target.ready));
  } catch (error) {
    connection.close();
    await context.close().catch(() => undefined);
    throw new Error(`WORKER_FINGERPRINT_SETUP_FAILED:${error instanceof Error ? error.message : 'unknown'}`);
  }
}

/**
 * The pinned in-process Playwright transport resumes worker targets on its own
 * CDP connection (including while detaching unsupported SharedWorkers). CDP's
 * startup pause is target-wide, not client-owned. Hold those real protocol
 * commands until the realm bootstrap is acknowledged; never rewrite application data.
 */
async function gatePlaywrightWorkerStartup(context: FirefoxContextLike, profile: UnifiedFingerprintProfile): Promise<{
  release(targetId: string): void;
  forgetTarget(targetId: string): void;
}> {
  interface Message {
    method?: string;
    sessionId?: string;
    params?: Record<string, unknown> & { sessionId?: string; targetInfo?: { targetId?: string; type?: string } };
  }
  interface Transport {
    send(message: Message): void;
    onmessage?: (message: Message) => void;
  }
  const client = context as unknown as { _connection?: { toImpl?: (value: unknown) => unknown } };
  const implementation = client._connection?.toImpl?.(context) as {
    _browser?: { _connection?: { _transport?: Transport; _sessions?: Map<string, { send(method: string, params: Record<string, unknown>): Promise<unknown> }> } };
  } | undefined;
  const transport = implementation?._browser?._connection?._transport;
  const protocolSessions = implementation?._browser?._connection?._sessions;
  if (!transport || typeof transport.send !== 'function' || typeof transport.onmessage !== 'function' || !(protocolSessions instanceof Map)) {
    throw new Error('WORKER_FINGERPRINT_SETUP_FAILED: pinned Playwright startup transport unavailable');
  }
  const originalSend = transport.send;
  const originalReceive = transport.onmessage;
  const send = originalSend.bind(transport);
  const receive = originalReceive.bind(transport);
  const sessions = new Map<string, string>();
  const released = new Set<string>();
  const waiting = new Map<string, Message[]>();
  const override = managedChromiumUserAgentOverride(profile);
  const receiveWithGate = (message: Message): void => {
    if (message.method === 'Target.attachedToTarget') {
      const target = message.params?.targetInfo;
      const session = message.params?.sessionId;
      if (session && target?.targetId && ['worker', 'shared_worker', 'service_worker'].includes(target.type ?? '')) {
        sessions.set(session, target.targetId);
      }
    } else if (message.method === 'Target.detachedFromTarget' && message.params?.sessionId) {
      sessions.delete(message.params.sessionId);
    }
    receive(message);
  };
  const sendWithGate = (message: Message): void => {
    const target = message.sessionId && sessions.get(message.sessionId);
    if (message.sessionId && message.method === 'Target.setAutoAttach') {
      message = { ...message, params: { ...message.params, filter: [
        { type: 'iframe', exclude: false }, { type: 'worker', exclude: false }, { exclude: true },
      ] } };
    }
    if (target && (message.method === 'Emulation.setUserAgentOverride' || message.method === 'Network.setUserAgentOverride')) {
      message = { ...message, params: { ...message.params, ...override } };
    }
    if (target && !released.has(target) && message.method === 'Runtime.runIfWaitingForDebugger') {
      const pending = waiting.get(target) ?? [];
      pending.push(message);
      waiting.set(target, pending);
      return;
    }
    send(message);
  };
  transport.onmessage = receiveWithGate;
  transport.send = sendWithGate;
  context.on?.('close', () => {
    if (transport.send === sendWithGate) transport.send = originalSend;
    if (transport.onmessage === receiveWithGate) transport.onmessage = originalReceive;
    sessions.clear();
    released.clear();
    waiting.clear();
  });
  // Remove the duplicate page-owned ServiceWorker pause before application
  // execution. Resuming that duplicate would race the browser-owned bootstrap.
  for (const [sessionId, session] of protocolSessions) {
    if (sessionId) await session.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  }
  return {
    release(targetId) {
      released.add(targetId);
      for (const message of waiting.get(targetId) ?? []) send(message);
      waiting.delete(targetId);
    },
    forgetTarget(targetId) {
      // A detached raw target with a queued Playwright resume is not safe to
      // release. Closing rejects its pending protocol callbacks rather than
      // leaving the consumer hung or running an unprofiled worker.
      if (waiting.has(targetId)) void context.close().catch(() => undefined);
      released.delete(targetId);
      waiting.delete(targetId);
    },
  };
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
      await client.send('Emulation.setHardwareConcurrencyOverride', {
        hardwareConcurrency: profile.hardware.hardwareConcurrency,
      });
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
