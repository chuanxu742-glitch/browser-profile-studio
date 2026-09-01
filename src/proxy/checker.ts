import { Buffer } from 'node:buffer';
import { createConnection, type Socket } from 'node:net';
import { connect as connectTls, type TLSSocket } from 'node:tls';
import type { ProxyConfig, ProxyCheckResult } from './types.js';
import { normalizeProxyConfig } from './validator.js';

export interface ProxyCheckerOptions {
  timeoutMs?: number;
  /** HTTP(S) JSON endpoint returning { ip, country? }. False performs connectivity only. */
  ipCheckServiceUrl?: string | false;
}

/** Checks the proxy handshake and verifies the actual egress IP through it. */
export async function checkProxy(rawConfig: ProxyConfig | string, options: ProxyCheckerOptions = {}): Promise<ProxyCheckResult> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  let normalized;
  try {
    normalized = normalizeProxyConfig(rawConfig);
  } catch (error: unknown) {
    return { success: false, verified: false, checkLevel: 'none', server: typeof rawConfig === 'string' ? rawConfig : (rawConfig.server || 'unknown'), proxyType: 'http', error: `Invalid proxy config: ${messageOf(error)}` };
  }

  const startedAt = Date.now();
  let socket: Socket | TLSSocket | undefined;
  let connectivityConfirmed = false;
  try {
    const service = options.ipCheckServiceUrl === undefined ? 'https://api.ipify.org?format=json' : options.ipCheckServiceUrl;
    if (service === false) {
      socket = await connectTcp(normalized.host, normalized.port, timeoutMs);
      connectivityConfirmed = true;
      return { success: true, verified: false, checkLevel: 'connectivity', server: normalized.server, proxyType: normalized.type, latencyMs: Date.now() - startedAt };
    }
    const target = new URL(service);
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('IP check service must use HTTP or HTTPS');
    const targetPort = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
    socket = await openProxyTunnel(normalized, target.hostname, targetPort, timeoutMs, (connected) => { socket = connected; connectivityConfirmed = true; });
    if (target.protocol === 'https:') socket = await upgradeTls(socket, target.hostname, timeoutMs);
    const requestTarget = `${target.pathname}${target.search}`;
    socket.write(`GET ${requestTarget} HTTP/1.1\r\nHost: ${target.host}\r\nAccept: application/json\r\nConnection: close\r\n\r\n`);
    const raw = await readToEnd(socket, timeoutMs, 256 * 1024);
    const split = raw.indexOf('\r\n\r\n');
    if (split < 0) throw new Error('Invalid HTTP response from egress service');
    const head = raw.slice(0, split);
    const status = Number(head.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/i)?.[1] ?? 0);
    if (status < 200 || status >= 300) throw new Error(`Egress service returned HTTP ${status || 'unknown'}`);
    const payload = JSON.parse(decodeHttpBody(head, raw.slice(split + 4))) as { ip?: unknown; country?: unknown; country_code?: unknown };
    const outboundIp = typeof payload.ip === 'string' ? payload.ip.trim() : '';
    if (!outboundIp) throw new Error('Egress service returned no IP address');
    const country = typeof payload.country === 'string' ? payload.country : typeof payload.country_code === 'string' ? payload.country_code : undefined;
    return { success: true, verified: true, checkLevel: 'egress', server: normalized.server, proxyType: normalized.type, latencyMs: Date.now() - startedAt, outboundIp, ...(country ? { country } : {}) };
  } catch (error: unknown) {
    if (connectivityConfirmed) {
      return { success: true, verified: false, checkLevel: 'connectivity', server: normalized.server, proxyType: normalized.type, latencyMs: Date.now() - startedAt, probeError: `Egress verification failed: ${messageOf(error)}` };
    }
    return { success: false, verified: false, checkLevel: 'none', server: normalized.server, proxyType: normalized.type, latencyMs: Date.now() - startedAt, error: `Proxy verification failed: ${messageOf(error)}` };
  } finally {
    closeSocket(socket);
  }
}

type NormalizedProxy = ReturnType<typeof normalizeProxyConfig>;

async function openProxyTunnel(proxy: NormalizedProxy, host: string, port: number, timeoutMs: number, onConnected: (socket: Socket) => void): Promise<Socket> {
  const socket = await connectTcp(proxy.host, proxy.port, timeoutMs);
  onConnected(socket);
  try {
  await assertPeerOpen(socket);
  if (proxy.type === 'http' || proxy.type === 'https') {
    socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${proxyAuthorization(proxy.username, proxy.password)}Connection: keep-alive\r\n\r\n`);
    const response = (await readUntil(socket, '\r\n\r\n', timeoutMs, 64 * 1024)).toString('latin1');
    const status = Number(response.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/i)?.[1] ?? 0);
    if (status < 200 || status >= 300) throw new Error(`HTTP CONNECT failed with ${status || 'unknown status'}`);
    return socket;
  }
  if (proxy.type === 'socks5') {
    const hasCredentials = Boolean(proxy.username || proxy.password);
    socket.write(Buffer.from([5, hasCredentials ? 2 : 1, 0, ...(hasCredentials ? [2] : [])]));
    const hello = await readAtLeast(socket, 2, timeoutMs);
    if (hello[0] !== 5 || hello[1] === 0xff) throw new Error('SOCKS5 authentication negotiation failed');
    if (hello[1] === 2) {
      const user = Buffer.from(proxy.username ?? '', 'utf8'); const pass = Buffer.from(proxy.password ?? '', 'utf8');
      if (user.length > 255 || pass.length > 255) throw new Error('SOCKS5 credentials are too long');
      socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
      const authenticated = await readAtLeast(socket, 2, timeoutMs);
      if (authenticated[1] !== 0) throw new Error('SOCKS5 credentials were rejected');
    }
    const hostBytes = Buffer.from(host, 'utf8');
    socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, hostBytes.length]), hostBytes, Buffer.from([port >> 8, port & 255])]));
    const connected = await readAtLeast(socket, 5, timeoutMs);
    if (connected[1] !== 0) throw new Error(`SOCKS5 connect failed (${connected[1]})`);
    return socket;
  }
  const hostBytes = Buffer.from(host, 'utf8');
  socket.write(Buffer.concat([Buffer.from([4, 1, port >> 8, port & 255, 0, 0, 0, 1]), Buffer.from(proxy.username ?? ''), Buffer.from([0]), hostBytes, Buffer.from([0])]));
  const connected = await readAtLeast(socket, 8, timeoutMs);
  if (connected[1] !== 90) throw new Error(`SOCKS4 connect failed (${connected[1]})`);
  return socket;
  } catch (error) {
    closeSocket(socket);
    throw error;
  }
}

function connectTcp(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => finish(new Error(`Connection timed out after ${timeoutMs}ms`)), timeoutMs);
    const onError = (error: Error) => finish(error);
    const finish = (error?: Error) => { clearTimeout(timer); socket.removeListener('error', onError); if (error) { socket.destroy(); reject(error); } else resolve(socket); };
    socket.once('connect', () => finish()); socket.once('error', onError);
  });
}

function upgradeTls(socket: Socket, servername: string, timeoutMs: number): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const secure = connectTls({ socket, servername });
    const timer = setTimeout(() => finish(new Error(`TLS handshake timed out after ${timeoutMs}ms`)), timeoutMs);
    const onError = (error: Error) => finish(error);
    const finish = (error?: Error) => { clearTimeout(timer); secure.removeListener('error', onError); if (error) { secure.destroy(); reject(error); } else resolve(secure); };
    secure.once('secureConnect', () => finish()); secure.once('error', onError);
  });
}

function readAtLeast(socket: Socket, minimum: number, timeoutMs: number): Promise<Buffer> { return readBuffer(socket, timeoutMs, (buffer) => buffer.length >= minimum); }
function readUntil(socket: Socket, marker: string, timeoutMs: number, maximum: number): Promise<Buffer> { return readBuffer(socket, timeoutMs, (buffer) => buffer.includes(marker), maximum); }

function readBuffer(socket: Socket, timeoutMs: number, complete: (buffer: Buffer) => boolean, maximum = 64 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error(`Proxy response timed out after ${timeoutMs}ms`)), timeoutMs);
    const onData = (chunk: Buffer) => { buffer = Buffer.concat([buffer, chunk]); if (buffer.length > maximum) finish(new Error('Proxy response exceeded size limit')); else if (complete(buffer)) finish(); };
    const onError = (error: Error) => finish(error); const onEnd = () => { closeSocket(socket); finish(new Error('Proxy closed the connection unexpectedly')); };
    const finish = (error?: Error) => { clearTimeout(timer); socket.off('data', onData); socket.off('error', onError); socket.off('end', onEnd); if (error) reject(error); else resolve(buffer); };
    socket.on('data', onData); socket.once('error', onError); socket.once('end', onEnd);
  });
}

function readToEnd(socket: Socket, timeoutMs: number, maximum: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    const timer = setTimeout(() => finish(new Error(`HTTP response timed out after ${timeoutMs}ms`)), timeoutMs);
    const onData = (chunk: Buffer) => { data += chunk.toString('utf8'); if (data.length > maximum) finish(new Error('HTTP response exceeded size limit')); };
    const onEnd = () => { closeSocket(socket); finish(); }; const onError = (error: Error) => finish(error);
    const finish = (error?: Error) => { clearTimeout(timer); socket.off('data', onData); socket.off('end', onEnd); socket.off('error', onError); if (error) reject(error); else resolve(data); };
    socket.on('data', onData); socket.once('end', onEnd); socket.once('error', onError);
  });
}

function proxyAuthorization(username?: string, password?: string): string { return username || password ? `Proxy-Authorization: Basic ${Buffer.from(`${username ?? ''}:${password ?? ''}`).toString('base64')}\r\n` : ''; }
function decodeHttpBody(head: string, body: string): string {
  if (!/transfer-encoding:\s*chunked/i.test(head)) return body;
  let output = ''; let offset = 0;
  while (offset < body.length) { const end = body.indexOf('\r\n', offset); if (end < 0) break; const size = Number.parseInt(body.slice(offset, end), 16); if (!size) break; output += body.slice(end + 2, end + 2 + size); offset = end + 4 + size; }
  return output;
}
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function closeSocket(socket?: Socket | TLSSocket): void {
  if (!socket) return;
  socket.end(); socket.destroy();
}

function assertPeerOpen(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(), 10);
    const onEnd = () => finish(new Error('Proxy closed the connection before handshake'));
    const onError = (error: Error) => finish(error);
    const finish = (error?: Error) => { clearTimeout(timer); socket.off('end', onEnd); socket.off('error', onError); if (error) { socket.end(); reject(error); } else resolve(); };
    socket.once('end', onEnd); socket.once('error', onError); socket.resume();
  });
}
