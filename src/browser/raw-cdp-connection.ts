import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocket } from 'ws';

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

/** Minimal loopback-only CDP transport used for non-page Chromium targets. */
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
    const socket = new WebSocket(endpoint, { handshakeTimeout: timeoutMs, maxPayload: 1_048_576 });
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
