import { randomInt, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { resolve, join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { launchPersistentChromium } from '../browser/chromium-launcher.js';
import { generateFingerprint } from '../fingerprint/generator.js';
import { buildStealthInjectionScript } from '../fingerprint/stealth-scripts.js';
import { managedBrowserIdentity } from '../fingerprint/runtime-identity.js';
import { normalizeProxyConfig } from '../proxy/validator.js';
import { alignGeoEnvironment } from '../geoip/aligner.js';

const profileSchema = z.object({
  schema: z.literal(1), seed: z.number().int().min(0).max(0xffffffff),
  os: z.enum(['linux', 'windows', 'macos']), countryCode: z.string().regex(/^[A-Z]{2}$/),
  locale: z.string().min(1), timezone: z.string().min(1),
  width: z.number().int().min(320).max(7680), height: z.number().int().min(240).max(4320),
  browserVersion: z.string(),
}).strict();

export async function startCdpService(env: NodeJS.ProcessEnv = process.env) {
  const host = env.CDP_HOST ?? '127.0.0.1';
  const port = z.coerce.number().int().min(0).max(65535).parse(env.CDP_PORT ?? '9222');
  const token = env.CDP_TOKEN ?? '';
  if (token && token.length < 24) throw new Error('CDP_TOKEN must contain at least 24 characters');
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !token) throw new Error('CDP_TOKEN_REQUIRED_FOR_NETWORK_BIND');
  const publicUrl = env.CDP_PUBLIC_URL ? new URL(env.CDP_PUBLIC_URL) : undefined;
  if (publicUrl && (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash)) {
    throw new Error('CDP_PUBLIC_URL must be an HTTP(S) origin');
  }
  const directory = resolve(env.CDP_PROFILE_DIR ?? 'data/cdp-profile');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadataPath = join(directory, 'cdp-profile.json');
  const explicit = {
    ...(env.CDP_SEED !== undefined ? { seed: Number(env.CDP_SEED) } : {}),
    ...(env.CDP_OS ? { os: env.CDP_OS } : {}),
    ...(env.CDP_COUNTRY ? { countryCode: env.CDP_COUNTRY } : {}),
    ...(env.CDP_LOCALE ? { locale: env.CDP_LOCALE } : {}),
    ...(env.CDP_TIMEZONE ? { timezone: env.CDP_TIMEZONE } : {}),
    ...(env.CDP_WIDTH ? { width: Number(env.CDP_WIDTH) } : {}),
    ...(env.CDP_HEIGHT ? { height: Number(env.CDP_HEIGHT) } : {}),
  };
  let metadata;
  try { metadata = profileSchema.parse(JSON.parse(await readFile(metadataPath, 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('CDP_PROFILE_METADATA_INVALID');
    const geo = alignGeoEnvironment({ ...(env.CDP_COUNTRY ? { countryCode: env.CDP_COUNTRY } : {}),
      ...(env.CDP_LOCALE ? { locale: env.CDP_LOCALE } : {}), ...(env.CDP_TIMEZONE ? { timezone: env.CDP_TIMEZONE } : {}) });
    metadata = profileSchema.parse({ schema: 1, seed: randomInt(0x100000000),
      os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
      countryCode: geo.country, locale: geo.locale, timezone: geo.timezoneId, width: 1280, height: 800,
      browserVersion: managedBrowserIdentity('chromium').fullVersion, ...explicit });
    // Validate before persisting. Concurrent first starts must use the same identity.
    Intl.getCanonicalLocales(metadata.locale);
    new Intl.DateTimeFormat(metadata.locale, { timeZone: metadata.timezone });
    try { await writeFile(metadataPath, JSON.stringify(metadata, null, 2), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      metadata = profileSchema.parse(JSON.parse(await readFile(metadataPath, 'utf8')));
    }
  }
  for (const [key, value] of Object.entries(explicit)) {
    if (metadata[key as keyof typeof metadata] !== value) throw new Error(`CDP_PROFILE_CONFIG_CONFLICT:${key}`);
  }
  if (metadata.browserVersion !== managedBrowserIdentity('chromium').fullVersion) throw new Error('CDP_PROFILE_VERSION_MISMATCH');
  const generated = generateFingerprint({ ...metadata, engine: 'chromium' });
  const fingerprint = { ...generated, viewport: { width: metadata.width, height: metadata.height },
    screen: { ...generated.screen, width: metadata.width, height: metadata.height,
      availWidth: metadata.width, availHeight: metadata.height, devicePixelRatio: 1 },
    hardware: { ...generated.hardware, screenWidth: metadata.width, screenHeight: metadata.height,
      availWidth: metadata.width, availHeight: metadata.height, devicePixelRatio: 1 } };
  const proxy = env.CDP_PROXY ? normalizeProxyConfig(env.CDP_PROXY) : undefined;
  const context = await launchPersistentChromium(directory, {
    headless: true, viewport: fingerprint.viewport, locale: metadata.locale, timezoneId: metadata.timezone,
    userAgent: fingerprint.userAgent, fingerprintProfile: fingerprint,
    initScript: buildStealthInjectionScript(fingerprint),
    ...(proxy ? { proxy: { server: proxy.server, ...(proxy.username ? { username: proxy.username } : {}),
      ...(proxy.password ? { password: proxy.password } : {}) } } : {}),
  });
  let upstream: string;
  try {
    const [debugPort, path] = (await readFile(join(directory, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
    if (!/^\d+$/.test(debugPort ?? '') || !path?.startsWith('/devtools/browser/')) throw new Error('CDP_ENDPOINT_INVALID');
    upstream = `ws://127.0.0.1:${debugPort}${path}`;
  } catch (error) { await context.close(); throw error; }
  const authorized = (request: IncomingMessage) => {
    if (!token) return true;
    const received = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    return received.length === expected.length && timingSafeEqual(received, expected);
  };
  let stopping = false;
  const peers = new Set<WebSocket>();
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/health') { res.writeHead(stopping ? 503 : 200); res.end(JSON.stringify({ ready: !stopping })); return; }
    if (!authorized(req)) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }
    if (req.method !== 'GET' || !['/json/version', '/json/version/'].includes(req.url ?? '')) { res.writeHead(404); res.end('{}'); return; }
    try {
      const origin = publicUrl ?? new URL(`http://${req.headers.host}`);
      res.end(JSON.stringify({ Browser: `Chrome/${metadata.browserVersion}`, 'Protocol-Version': '1.3',
        webSocketDebuggerUrl: `${origin.protocol === 'https:' ? 'wss:' : 'ws:'}//${origin.host}/cdp` }));
    } catch { res.writeHead(400); res.end('{}'); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const bridge = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    if (stopping || req.url !== '/cdp' || !authorized(req)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
    }
    const remote = new WebSocket(upstream, { maxPayload: 16 * 1024 * 1024, handshakeTimeout: 5000 });
    peers.add(remote);
    remote.on('error', () => socket.destroy());
    remote.on('close', () => { peers.delete(remote); socket.destroy(); });
    socket.on('close', () => remote.terminate());
    remote.once('open', () => {
      if (socket.destroyed || stopping) { remote.terminate(); return; }
      bridge.handleUpgrade(req, socket, head, local => {
        peers.add(local);
        const forward = (target: WebSocket, data: import('ws').RawData, binary: boolean) => {
          if (target.readyState !== WebSocket.OPEN) return;
          if (target.bufferedAmount > 16 * 1024 * 1024) { target.terminate(); return; }
          target.send(data, { binary }, error => { if (error) target.terminate(); });
        };
        local.on('message', (data, binary) => forward(remote, data, binary));
        remote.on('message', (data, binary) => forward(local, data, binary));
        local.on('error', () => remote.terminate());
        local.on('close', () => { peers.delete(local); remote.terminate(); });
      });
    });
  });
  let resolveClosed!: () => void;
  const closed = new Promise<void>(r => { resolveClosed = r; });
  const stop = async () => {
    if (stopping) return closed;
    stopping = true;
    for (const peer of peers) peer.terminate();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(r => server.close(() => r()));
    bridge.close();
    await context.close().catch(() => undefined);
    resolveClosed();
  };
  context.on?.('close', () => { void stop(); });
  try {
    if (stopping) throw new Error('CDP_BROWSER_CLOSED_DURING_START');
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(port, host, done); });
  } catch (error) { await stop(); throw error; }
  const address = server.address();
  if (!address || typeof address === 'string') { await stop(); throw new Error('CDP_LISTEN_FAILED'); }
  return { port: address.port, stop, closed, metadata };
}
