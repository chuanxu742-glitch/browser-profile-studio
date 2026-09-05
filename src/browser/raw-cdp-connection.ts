import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';

export interface RawCdpEvent {
  readonly method: string;
  readonly params?: Record<string, unknown>;
  readonly sessionId?: string;
}

type PendingCommand = {
  readonly resolve: (value: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
};

export interface ManagedCdpGateway {
  readonly endpoint: string;
  close(): Promise<void>;
}

/** Loopback-only CDP transport; one owner must configure and resume each target. */
export class RawCdpConnection {
  private nextId = 0;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly listeners = new Set<(event: RawCdpEvent) => void>();
  private closed = false;

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) => this.handleMessage(data.toString()));
    socket.on('close', () => this.handleClose(new Error('RAW_CDP_CONNECTION_CLOSED')));
    socket.on('error', (error) => this.handleClose(error));
  }

  public static async connect(profileDirectory: string, timeoutMs = 5_000): Promise<RawCdpConnection> {
    const endpoint = await readEndpoint(profileDirectory, timeoutMs);
    const socket = new WebSocket(endpoint, { handshakeTimeout: timeoutMs, maxPayload: 67_108_864 });
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); socket.off('open', onOpen); socket.off('error', onError); };
      const onOpen = () => { cleanup(); resolve(); };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const timer = setTimeout(() => { cleanup(); socket.terminate(); reject(new Error('RAW_CDP_CONNECT_TIMEOUT')); }, timeoutMs);
      timer.unref?.();
      socket.once('open', onOpen);
      socket.once('error', onError);
    });
    return new RawCdpConnection(socket);
  }

  public onEvent(listener: (event: RawCdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 5_000,
  ): Promise<Record<string, unknown>> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) throw new Error('RAW_CDP_CONNECTION_CLOSED');
    const id = ++this.nextId;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RAW_CDP_COMMAND_TIMEOUT:${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), (error) => {
        if (!error) return;
        const command = this.pending.get(id);
        if (!command) return;
        clearTimeout(command.timer);
        this.pending.delete(id);
        command.reject(error);
      });
    });
  }

  /**
   * Gate the driver's own resume command. A second CDP client cannot provide
   * this barrier: either client can resume a target paused at startup.
   */
  public async openGateway(
    beforeResume: (sessionId: string, type: string) => Promise<void>,
    onFailure: (error: Error) => void,
    proxyCredentials?: { username: string; password: string },
  ): Promise<ManagedCdpGateway> {
    const path = `/managed/${randomUUID()}`;
    const server = new WebSocketServer({
      host: '127.0.0.1', port: 0, path, maxPayload: 67_108_864,
      verifyClient: (info: { origin: string }) => !info.origin,
    });
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('MANAGED_CDP_GATEWAY_UNAVAILABLE');
    const targets = new Map<string, { targetId: string; type: string; waiting: boolean }>();
    const initialized = new Map<string, Promise<void>>();
    const proxyAuthentication = new Map<string, Set<string>>();
    const driverInterception = new Set<string>();
    let client: WebSocket | undefined;
    const handleProxyContinuationError = (error: unknown, sessionId?: string): void => {
      const failure = error instanceof Error ? error : new Error(String(error));
      // Aborting a request removes its native interception job before a queued
      // continuation can arrive. That terminal request state is not a browser failure.
      if (failure.message === 'Invalid InterceptionId.' || this.closed || (sessionId && !targets.has(sessionId))) return;
      onFailure(failure);
    };
    const stopEvents = this.onEvent((event) => {
      if (event.method === 'Target.attachedToTarget') {
        const info = event.params?.targetInfo as { targetId?: string; type?: string; url?: string } | undefined;
        const id = event.params?.sessionId;
        if (typeof id === 'string' && typeof info?.type === 'string' && typeof info.targetId === 'string'
          && !/^(?:chrome|devtools):|^chrome-extension:/.test(info.url ?? '')) {
          targets.set(id, { targetId: info.targetId, type: info.type, waiting: event.params?.waitingForDebugger === true });
        }
      } else if (event.method === 'Target.detachedFromTarget') {
        const id = event.params?.sessionId;
        if (typeof id === 'string') {
          const target = targets.get(id);
          targets.delete(id);
          proxyAuthentication.delete(id);
          driverInterception.delete(id);
          if (target) {
            let attached = false;
            for (const other of targets.values()) if (other.targetId === target.targetId) { attached = true; break; }
            if (!attached) initialized.delete(target.targetId);
          }
        }
      } else if (event.method === 'Inspector.targetReloadedAfterCrash' && event.sessionId) {
        const target = targets.get(event.sessionId);
        if (target) { initialized.delete(target.targetId); target.waiting = true; }
      }
      if (proxyCredentials && event.method === 'Fetch.requestPaused' && !driverInterception.has(event.sessionId ?? '')) {
        void this.send('Fetch.continueRequest', { requestId: event.params?.requestId }, event.sessionId)
          .catch((error: unknown) => handleProxyContinuationError(error, event.sessionId));
        return;
      }
      if (proxyCredentials && event.method === 'Fetch.authRequired'
        && (event.params?.authChallenge as { source?: string } | undefined)?.source === 'Proxy') {
        const session = event.sessionId ?? '';
        let attempts = proxyAuthentication.get(session);
        if (!attempts) { attempts = new Set(); proxyAuthentication.set(session, attempts); }
        const requestId = String(event.params?.requestId);
        const attempted = attempts.has(requestId);
        attempts.add(requestId);
        void this.send('Fetch.continueWithAuth', {
          requestId: event.params?.requestId,
          authChallengeResponse: attempted ? { response: 'CancelAuth' } : { response: 'ProvideCredentials', ...proxyCredentials },
        }, event.sessionId).catch((error: unknown) => handleProxyContinuationError(error, event.sessionId));
        return;
      }
      if (client?.readyState === WebSocket.OPEN) client.send(JSON.stringify(event));
    });
    server.on('connection', (socket) => {
      if (client) { socket.close(1008, 'Single driver only'); return; }
      client = socket;
      socket.on('error', (error) => onFailure(error));
      socket.on('message', (data) => {
        const dispatch = async (): Promise<void> => {
          const message = JSON.parse(data.toString()) as {
            id: number; method: string; params?: Record<string, unknown>; sessionId?: string;
          };
          if (!Number.isInteger(message.id) || typeof message.method !== 'string') throw new Error('MANAGED_CDP_COMMAND_INVALID');
          const { id, method, sessionId } = message;
          const reply = (payload: Record<string, unknown>) => {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id, ...payload, ...(sessionId ? { sessionId } : {}) }));
          };
          try {
            const target = sessionId ? targets.get(sessionId) : undefined;
            if (method === 'Runtime.runIfWaitingForDebugger' && sessionId && target) {
              // A service worker attaches both to the browser and to each page.
              // Initialize the target once, not once per observing session.
              let initialization = initialized.get(target.targetId);
              const ownsInitialization = !initialization;
              if (!initialization) {
                initialization = !target.waiting && target.type.endsWith('worker')
                  ? Promise.reject(new Error(`MANAGED_TARGET_ALREADY_RUNNING:${target.type}`))
                  : beforeResume(sessionId, target.type);
                initialized.set(target.targetId, initialization);
              }
              // Other observing sessions must release their startup barrier too.
              // The owner's first-script breakpoint still prevents execution.
              try { if (ownsInitialization || !target.type.endsWith('worker')) await initialization; } catch (error) {
                if (targets.has(sessionId)) onFailure(error instanceof Error ? error : new Error(String(error)));
                throw error;
              }
            }
            const params = { ...message.params };
            if (proxyCredentials && method === 'Fetch.enable') {
              params.handleAuthRequests = true;
              if (Array.isArray(params.patterns) && params.patterns.length === 0) {
                driverInterception.delete(sessionId ?? '');
                params.patterns = [{}];
              } else driverInterception.add(sessionId ?? '');
            }
            if (proxyCredentials && method === 'Fetch.disable') driverInterception.delete(sessionId ?? '');
            const result = proxyCredentials && method === 'Fetch.disable'
              ? await this.send('Fetch.enable', { patterns: [{}], handleAuthRequests: true }, sessionId)
              : await this.send(method, params, sessionId, 180_000);
            reply({ result });
          } catch (error) {
            reply({ error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
          }
        };
        void dispatch().catch((error: unknown) => onFailure(error instanceof Error ? error : new Error(String(error))));
      });
    });
    const disconnect = () => { client?.terminate(); };
    this.socket.once('close', disconnect);
    let closePromise: Promise<void> | undefined;
    return {
      endpoint: `ws://127.0.0.1:${address.port}${path}`,
      close: () => closePromise ??= (async () => {
        stopEvents();
        this.socket.off('close', disconnect);
        for (const socket of server.clients) socket.terminate();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        this.close();
      })(),
    };
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.handleClose(new Error('RAW_CDP_CONNECTION_CLOSED'));
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) this.socket.close();
  }

  private handleMessage(raw: string): void {
    let message: unknown;
    try { message = JSON.parse(raw); } catch { return; }
    if (!message || typeof message !== 'object') return;
    const record = message as Record<string, unknown>;
    if (typeof record.id === 'number') {
      const command = this.pending.get(record.id);
      if (!command) return;
      clearTimeout(command.timer);
      this.pending.delete(record.id);
      const protocolError = record.error as { message?: unknown } | undefined;
      if (protocolError) command.reject(new Error(String(protocolError.message ?? 'RAW_CDP_PROTOCOL_ERROR')));
      else command.resolve((record.result && typeof record.result === 'object' ? record.result : {}) as Record<string, unknown>);
      return;
    }
    if (typeof record.method !== 'string') return;
    const event: RawCdpEvent = {
      method: record.method,
      ...(record.params && typeof record.params === 'object' ? { params: record.params as Record<string, unknown> } : {}),
      ...(typeof record.sessionId === 'string' ? { sessionId: record.sessionId } : {}),
    };
    for (const listener of this.listeners) listener(event);
  }

  private handleClose(error: Error): void {
    this.closed = true;
    for (const command of this.pending.values()) {
      clearTimeout(command.timer);
      command.reject(error);
    }
    this.pending.clear();
  }
}

async function readEndpoint(profileDirectory: string, timeoutMs: number): Promise<string> {
  const path = join(profileDirectory, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const [portText, browserPath] = (await readFile(path, 'utf8')).trim().split(/\r?\n/);
      const port = Number(portText);
      if (!Number.isInteger(port) || port < 1 || port > 65_535 || !browserPath?.startsWith('/devtools/browser/')) {
        throw new Error('RAW_CDP_ENDPOINT_INVALID');
      }
      return `ws://127.0.0.1:${port}${browserPath}`;
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`RAW_CDP_ENDPOINT_UNAVAILABLE:${lastError instanceof Error ? lastError.message : 'unknown'}`);
}
