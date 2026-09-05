/** Chromium launch/attach adapter used by the optional control-plane worker. */
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import type { Browser, BrowserContext } from 'playwright';
import { assertManagedRuntimeVersion } from './firefox-launcher.js';
import type { FirefoxContextLike, FirefoxLaunchOptions, FirefoxLauncherLike } from './firefox-launcher.js';
import type { UnifiedFingerprintProfile } from '../fingerprint/types.js';
import { buildWorkerBootstrap } from '../fingerprint/stealth-scripts.js';
import { RawCdpConnection } from './raw-cdp-connection.js';
import type { ManagedCdpGateway } from './raw-cdp-connection.js';

export interface ChromiumLauncherLike extends FirefoxLauncherLike {
  connectOverCDP(endpoint: string): Promise<FirefoxContextLike>;
}

export async function launchPersistentChromium(
  profileDirectory: string,
  options: FirefoxLaunchOptions,
): Promise<FirefoxContextLike> {
  if (options.headless && options.managedExtensions?.length) throw new Error('EXTENSION_HEADED_REQUIRED');
  const profile = options.fingerprintProfile;
  const hasProxyCredentials = options.proxy?.username !== undefined || options.proxy?.password !== undefined;
  const hostOs = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
  if (profile && profile.os !== hostOs) throw new Error('FINGERPRINT_OS_UNSUPPORTED: native fonts and graphics require a profile matching the host OS');
  if (profile?.webrtc === 'replace') throw new Error('WEBRTC_REPLACE_UNSUPPORTED: configure relay-only protection with a real TURN service instead');
  if (profile?.webrtc === 'disable') throw new Error('WEBRTC_DISABLE_UNSUPPORTED: Chromium supports relay-only protection, not disabling the native API');
  if (hasProxyCredentials && options.proxy?.server.startsWith('socks')) {
    throw new Error('PROXY_AUTH_UNSUPPORTED: Chromium does not support authenticated SOCKS proxies');
  }
  if (!profile) {
    if (hasProxyCredentials && !options.proxy?.username) throw new Error('PROXY_AUTH_UNSUPPORTED: empty-username proxy authentication requires a managed Chromium profile');
    const context = await chromium.launchPersistentContext(profileDirectory, {
      headless: options.headless,
      ...(options.viewport ? { viewport: options.viewport } : {}),
      ...(options.proxy ? { proxy: options.proxy } : {}),
      ...(options.timezoneId ? { timezoneId: options.timezoneId } : {}),
      ...(options.locale ? { locale: options.locale } : {}),
      ...(options.geolocation ? { geolocation: options.geolocation } : {}),
      ...(options.permissions ? { permissions: options.permissions } : {}),
      ...(options.extraHTTPHeaders ? { extraHTTPHeaders: options.extraHTTPHeaders } : {}),
      ...(options.userAgent ? { userAgent: options.userAgent } : {}),
      args: managedChromiumArgs(options.managedExtensions), acceptDownloads: false,
    });
    try {
      await assertManagedRuntimeVersion(context as unknown as FirefoxContextLike, 'chromium');
      if (options.initScript) await context.addInitScript(options.initScript);
      return context as unknown as FirefoxContextLike;
    } catch (error) { await context.close(); throw error; }
  }

  // Playwright's independent transport resumes worker targets itself. Launch the
  // locked executable, then connect its driver through the single-owner gate.
  const directory = resolve(profileDirectory);
  await mkdir(directory, { recursive: true });
  await rm(join(directory, 'DevToolsActivePort'), { force: true });
  const args = [
    `--user-data-dir=${directory}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-background-mode',
    '--disable-component-update', '--use-mock-keychain', '--disable-blink-features=AutomationControlled',
    '--disable-component-extensions-with-background-pages',
    ...(options.managedExtensions?.length ? [] : ['--disable-extensions']),
    `--user-agent=${profile.userAgent}`, `--lang=${options.locale ?? profile.geo.locale}`,
    `--accept-lang=${profile.geo.languages.join(',')}`,
    ...(options.headless ? ['--headless=new'] : []),
    ...(options.viewport ? [`--window-size=${options.viewport.width},${options.viewport.height}`] : []),
    ...(profile.webrtc !== 'direct' ? ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] : []),
    ...(options.proxy ? [`--proxy-server=${options.proxy.server}`, `--proxy-bypass-list=${options.proxy.bypass ? `${options.proxy.bypass};` : ''}<-loopback>`] : []),
    ...managedChromiumArgs(options.managedExtensions), 'about:blank',
  ];
  const processHandle = spawn(chromium.executablePath(), args, { stdio: 'ignore', windowsHide: options.headless });
  let startupFailure: Error | undefined;
  processHandle.once('error', (error) => { startupFailure = error; });
  const exited = new Promise<void>((done) => processHandle.once('exit', () => done()));
  let connection: RawCdpConnection | undefined;
  let gateway: ManagedCdpGateway | undefined;
  let browser: Browser | undefined;
  let disposed: Promise<void> | undefined;
  let gracefulClose = false;
  const dispose = (): Promise<void> => disposed ??= (async () => {
    await gateway?.close();
    connection?.close();
    if (processHandle.exitCode === null && processHandle.signalCode === null && processHandle.pid) {
      // CDP disconnect precedes Chromium's final profile flush. Let a requested
      // Browser.close exit normally before enforcing a bounded shutdown.
      const timer = setTimeout(() => processHandle.kill(), gracefulClose ? 5_000 : 0);
      timer.unref();
      try { await exited; } finally { clearTimeout(timer); }
    }
  })();
  try {
    connection = await RawCdpConnection.connect(directory);
    if (startupFailure) throw startupFailure;
    if (processHandle.exitCode !== null) throw new Error(`MANAGED_CHROMIUM_EXITED:${processHandle.exitCode}`);
    const transport = connection;
    const configure = chromiumTargetInitializer(transport, profile, options, hasProxyCredentials);
    gateway = await transport.openGateway(configure, (error) => {
      startupFailure = error;
      console.error(`MANAGED_TARGET_IDENTITY_FAILED:${error.message}`);
      void dispose();
    }, hasProxyCredentials ? { username: options.proxy?.username ?? '', password: options.proxy?.password ?? '' } : undefined);
    browser = await chromium.connectOverCDP(gateway.endpoint);
    if (startupFailure) throw startupFailure;
    const context = browser.contexts()[0];
    if (!context) throw new Error('MANAGED_CHROMIUM_CONTEXT_MISSING');
    await assertManagedRuntimeVersion(context as unknown as FirefoxContextLike, 'chromium');
    if (options.extraHTTPHeaders) await context.setExtraHTTPHeaders(options.extraHTTPHeaders);
    if (options.geolocation) await context.setGeolocation(options.geolocation);
    if (options.permissions?.length) await context.grantPermissions(options.permissions);
    await transport.send('Browser.setDownloadBehavior', { behavior: 'deny' });
    const ownedBrowser = browser;
    let closing: Promise<void> | undefined;
    context.close = () => closing ??= (async () => {
      gracefulClose = true;
      try { await transport.send('Browser.close'); } catch { /* Browser may already have exited. */ }
      await ownedBrowser.close().catch(() => undefined);
      await dispose();
    })();
    ownedBrowser.once('disconnected', () => { void dispose(); });
    return context as unknown as FirefoxContextLike;
  } catch (error) {
    await browser?.close().catch(() => undefined);
    await dispose();
    throw startupFailure ?? error;
  }
}

function chromiumTargetInitializer(
  connection: RawCdpConnection,
  profile: UnifiedFingerprintProfile,
  options: FirefoxLaunchOptions,
  authenticateProxy: boolean,
): (sessionId: string, type: string) => Promise<void> {
  const override = managedChromiumUserAgentOverride(profile);
  const bootstrap = buildWorkerBootstrap(profile);
  return async (sessionId, type) => {
    if (!['page', 'iframe', 'worker', 'shared_worker', 'service_worker'].includes(type)) return;
    if (type.endsWith('worker')) {
      await initializeWorker(connection, sessionId, type, override, bootstrap, authenticateProxy);
      return;
    }
    const page = type === 'page' || type === 'iframe';
    await connection.send('Network.setUserAgentOverride', override, sessionId);
    if (page) {
      await connection.send('Emulation.setTimezoneOverride', { timezoneId: options.timezoneId ?? profile.geo.timezoneId }, sessionId);
      await connection.send('Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: profile.hardware.hardwareConcurrency }, sessionId);
      const viewport = options.viewport ?? { width: profile.screen.width, height: profile.screen.height };
      if (type === 'page') await connection.send('Emulation.setDeviceMetricsOverride', {
        ...viewport, screenWidth: profile.screen.width, screenHeight: profile.screen.height,
        deviceScaleFactor: profile.screen.devicePixelRatio, mobile: false,
      }, sessionId);
      if (options.initScript) await connection.send('Page.addScriptToEvaluateOnNewDocument', { source: options.initScript, runImmediately: true }, sessionId);
    }
    if (authenticateProxy) await connection.send('Fetch.enable', { patterns: [{}], handleAuthRequests: true }, sessionId);
  };
}

async function initializeWorker(
  connection: RawCdpConnection,
  sessionId: string,
  type: string,
  override: Record<string, unknown>,
  bootstrap: string,
  authenticateProxy: boolean,
): Promise<void> {
  let stop = () => {};
  let timer: NodeJS.Timeout | undefined;
  const paused = new Promise<void>((resolve, reject) => {
    stop = connection.onEvent((event) => {
      if (event.sessionId === sessionId && event.method === 'Debugger.paused') resolve();
      if (event.method === 'Target.detachedFromTarget' && event.params?.sessionId === sessionId) {
        reject(new Error('MANAGED_TARGET_CLOSED_BEFORE_FIRST_SCRIPT'));
      }
    });
    timer = setTimeout(() => reject(new Error(`WORKER_FIRST_SCRIPT_PAUSE_TIMEOUT:${type}`)), 5_000);
    timer.unref();
  });
  // Service-worker protocol commands queue until its thread starts. Install the
  // first-script breakpoint before releasing that startup barrier.
  const prepared = Promise.all([
    connection.send('Debugger.enable', {}, sessionId),
    connection.send('Debugger.setInstrumentationBreakpoint', { instrumentation: 'beforeScriptExecution' }, sessionId),
    paused,
  ]);
  try {
    await Promise.all([
      connection.send('Runtime.runIfWaitingForDebugger', {}, sessionId), prepared,
    ]);
    await connection.send(type === 'service_worker' ? 'Emulation.setUserAgentOverride' : 'Network.setUserAgentOverride', override, sessionId);
    const result = await connection.send('Runtime.evaluate', {
      expression: bootstrap, returnByValue: true, disableBreaks: true,
    }, sessionId);
    if (result.exceptionDetails) throw new Error(`FINGERPRINT_BOOTSTRAP_FAILED:${type}`);
    if (authenticateProxy && type === 'service_worker') await connection.send('Fetch.enable', { patterns: [{}], handleAuthRequests: true }, sessionId);
    await connection.send('Debugger.disable', {}, sessionId);
  } finally {
    stop();
    clearTimeout(timer);
  }
}

function managedChromiumUserAgentOverride(profile: UnifiedFingerprintProfile): Record<string, unknown> {
  const major = profile.browserVersion.split('.')[0]!;
  const platform = profile.os === 'macos' ? 'macOS' : profile.os === 'linux' ? 'Linux' : 'Windows';
  const platformVersion = profile.os === 'macos' ? '10.15.7' : profile.os === 'linux' ? '6.8.0' : '10.0.0';
  return {
    userAgent: profile.userAgent, acceptLanguage: profile.geo.languages.join(','), platform: profile.platform,
    userAgentMetadata: {
      brands: [{ brand: 'Chromium', version: major }, { brand: 'Not=A?Brand', version: '99' }],
      fullVersionList: [{ brand: 'Chromium', version: profile.browserVersion }, { brand: 'Not=A?Brand', version: '99.0.0.0' }],
      fullVersion: profile.browserVersion, platform, platformVersion, architecture: 'x86',
      model: '', mobile: false, bitness: '64', wow64: false, formFactors: ['Desktop'],
    },
  };
}

export async function connectChromiumOverCDP(endpoint: string): Promise<FirefoxContextLike> {
  const browser = await chromium.connectOverCDP(endpoint);
  const existing: BrowserContext | undefined = browser.contexts()[0];
  return (existing ?? await browser.newContext()) as unknown as FirefoxContextLike;
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
