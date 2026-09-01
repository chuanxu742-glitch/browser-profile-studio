import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { WebSocket } from 'ws';

import type { SessionManager, SessionStartOptions } from '../browser/session-manager.js';

export type BrowserInstanceMode = 'managed' | 'cdp' | 'bridge';
export type BrowserInstanceState = 'STOPPED' | 'STARTING' | 'READY' | 'AWAITING_BRIDGE' | 'ERROR';

export interface BrowserInstance {
  id: string;
  name: string;
  engine: 'firefox' | 'chromium';
  mode: BrowserInstanceMode;
  state: BrowserInstanceState;
  profileName?: string;
  cdpEndpoint?: string;
  noVncPort?: number;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SiteBinding {
  host: string;
  browserId: string;
  createdAt: string;
}

interface PersistedState {
  instances: BrowserInstance[];
  bindings: SiteBinding[];
}

interface BridgePending {
  browserId: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BrowserPool {
  private readonly manager: SessionManager;
  private readonly instances = new Map<string, BrowserInstance>();
  private readonly bindings = new Map<string, SiteBinding>();
  private readonly statePath: string | undefined;
  private readonly bridgeSockets = new Map<string, WebSocket>();
  private readonly bridgePending = new Map<string, BridgePending>();

  public constructor(manager: SessionManager, options: { statePath?: string } = {}) {
    this.manager = manager;
    this.statePath = options.statePath ? resolve(options.statePath) : undefined;
    this.load();
  }

  public list(): BrowserInstance[] {
    return [...this.instances.values()].map((item) => ({ ...item }));
  }

  public bindingsList(): SiteBinding[] {
    return [...this.bindings.values()].map((item) => ({ ...item }));
  }

  public async add(input: {
    name: string;
    engine?: 'firefox' | 'chromium';
    mode?: BrowserInstanceMode;
    profileName?: string;
    cdpEndpoint?: string;
    noVncPort?: number;
    start?: boolean;
  }): Promise<BrowserInstance> {
    const name = safeName(input.name);
    if ([...this.instances.values()].some((item) => item.name === name)) throw new Error('BROWSER_INSTANCE_EXISTS');
    const engine = input.engine ?? 'chromium';
    const mode = input.mode ?? 'managed';
    if (mode === 'cdp' && !input.cdpEndpoint) throw new Error('CDP_ENDPOINT_REQUIRED');
    if (mode === 'cdp' && engine !== 'chromium') throw new Error('CDP_REQUIRES_CHROMIUM');
    const now = new Date().toISOString();
    const instance: BrowserInstance = {
      id: `brw_${randomUUID().replace(/-/g, '')}`,
      name,
      engine,
      mode,
      state: mode === 'bridge' ? 'AWAITING_BRIDGE' : 'STOPPED',
      ...(input.profileName ? { profileName: safeName(input.profileName) } : {}),
      ...(input.cdpEndpoint ? { cdpEndpoint: safeEndpoint(input.cdpEndpoint) } : {}),
      ...(input.noVncPort !== undefined ? { noVncPort: boundedPort(input.noVncPort) } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.instances.set(instance.id, instance);
    this.persist();
    if (input.start !== false && mode !== 'bridge') await this.start(instance.id);
    return { ...this.require(instance.id) };
  }

  public async start(id: string): Promise<BrowserInstance> {
    const instance = this.require(id);
    if (instance.mode === 'bridge') {
      this.update(instance, { state: 'AWAITING_BRIDGE' });
      return { ...instance };
    }
    this.update(instance, { state: 'STARTING' });
    try {
      const options: SessionStartOptions = {
        engine: instance.engine,
        headless: false,
        ...(instance.profileName ? { profileName: instance.profileName } : {}),
        ...(instance.mode === 'cdp' && instance.cdpEndpoint ? { cdpEndpoint: instance.cdpEndpoint } : {}),
      };
      const session = await this.manager.start(options);
      this.update(instance, { state: 'READY', sessionId: session.sessionId });
    } catch (error) {
      this.update(instance, { state: 'ERROR' });
      throw error;
    }
    return { ...this.require(id) };
  }

  /** Update an instance definition without starting it. */
  public configure(id: string, input: {
    name?: string;
    engine?: 'firefox' | 'chromium';
    mode?: BrowserInstanceMode;
    profileName?: string | null;
    cdpEndpoint?: string | null;
    noVncPort?: number | null;
  }): BrowserInstance {
    const instance = this.require(id);
    if (instance.state === 'STARTING' || instance.state === 'READY') throw new Error('BROWSER_INSTANCE_BUSY');
    const mode = input.mode ?? instance.mode;
    const engine = input.engine ?? instance.engine;
    const cdpEndpoint = input.cdpEndpoint === null ? undefined : (input.cdpEndpoint ? safeEndpoint(input.cdpEndpoint) : instance.cdpEndpoint);
    if (mode === 'cdp' && !cdpEndpoint) throw new Error('CDP_ENDPOINT_REQUIRED');
    if (mode === 'cdp' && engine !== 'chromium') throw new Error('CDP_REQUIRES_CHROMIUM');
    if (input.name !== undefined) {
      const name = safeName(input.name);
      if ([...this.instances.values()].some((item) => item.id !== id && item.name === name)) throw new Error('BROWSER_INSTANCE_EXISTS');
      instance.name = name;
    }
    instance.engine = engine;
    instance.mode = mode;
    if (input.profileName === null) delete instance.profileName;
    else if (input.profileName !== undefined) instance.profileName = safeName(input.profileName);
    if (cdpEndpoint) instance.cdpEndpoint = cdpEndpoint;
    else delete instance.cdpEndpoint;
    if (input.noVncPort === null) delete instance.noVncPort;
    else if (input.noVncPort !== undefined) instance.noVncPort = boundedPort(input.noVncPort);
    instance.state = mode === 'bridge' ? 'AWAITING_BRIDGE' : 'STOPPED';
    delete instance.sessionId;
    this.persist();
    return { ...instance };
  }

  public async stop(id: string): Promise<BrowserInstance> {
    const instance = this.require(id);
    if (instance.sessionId) await this.manager.stop(instance.sessionId);
    this.bridgeSockets.get(id)?.close();
    this.bridgeSockets.delete(id);
    this.rejectBridgeCalls(id, 'BRIDGE_STOPPED');
    delete instance.sessionId;
    this.update(instance, { state: instance.mode === 'bridge' ? 'AWAITING_BRIDGE' : 'STOPPED' });
    return { ...instance };
  }

  public async remove(id: string): Promise<void> {
    const instance = this.require(id);
    await this.stop(id).catch(() => undefined);
    for (const [host, binding] of this.bindings) if (binding.browserId === id) this.bindings.delete(host);
    this.instances.delete(instance.id);
    this.persist();
  }

  /** Attach an OpenCLI browser extension connection to a Bridge instance. */
  public attachBridge(id: string, socket: WebSocket): void {
    const instance = this.require(id);
    if (instance.mode !== 'bridge') throw new Error('BROWSER_NOT_IN_BRIDGE_MODE');
    this.bridgeSockets.get(id)?.close();
    this.bridgeSockets.set(id, socket);
    this.update(instance, { state: 'READY' });
    socket.on('message', (raw) => this.handleBridgeMessage(id, raw.toString()));
    socket.on('close', () => {
      if (this.bridgeSockets.get(id) !== socket) return;
      this.bridgeSockets.delete(id);
      const current = this.instances.get(id);
      if (current) this.update(current, { state: 'AWAITING_BRIDGE' });
      for (const [requestId, pending] of this.bridgePending) {
        if (pending.browserId !== id) continue;
        clearTimeout(pending.timer);
        pending.reject(new Error('BRIDGE_DISCONNECTED'));
        this.bridgePending.delete(requestId);
      }
    });
    socket.send(JSON.stringify({ type: 'hello', protocol: 'opencli-bridge.v1', browserId: id }));
  }

  public bridgeCall(id: string, payload: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    try { validateBridgePayload(payload); }
    catch (error) { return Promise.reject(error instanceof Error ? error : new Error('BRIDGE_OPERATION_DENIED')); }
    const socket = this.bridgeSockets.get(id);
    if (!socket || socket.readyState !== 1) return Promise.reject(new Error('BRIDGE_NOT_CONNECTED'));
    const requestId = `bridge_${randomUUID().replace(/-/g, '')}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.bridgePending.delete(requestId);
        reject(new Error('BRIDGE_TIMEOUT'));
      }, Math.max(100, Math.min(timeoutMs, 120_000)));
      this.bridgePending.set(requestId, { browserId: id, resolve, reject, timer });
      try { socket.send(JSON.stringify({ type: 'command', requestId, ...payload })); }
      catch (error) {
        clearTimeout(timer);
        this.bridgePending.delete(requestId);
        reject(error instanceof Error ? error : new Error('BRIDGE_SEND_FAILED'));
      }
    });
  }

  public bind(host: string, browserId: string): SiteBinding {
    const normalizedHost = normalizeHost(host);
    this.require(browserId);
    const binding = { host: normalizedHost, browserId, createdAt: new Date().toISOString() };
    this.bindings.set(normalizedHost, binding);
    this.persist();
    return { ...binding };
  }

  public unbind(host: string): void {
    this.bindings.delete(normalizeHost(host));
    this.persist();
  }

  public resolveBinding(host: string): BrowserInstance | undefined {
    const binding = this.bindings.get(normalizeHost(host));
    return binding ? { ...this.require(binding.browserId) } : undefined;
  }

  private require(id: string): BrowserInstance {
    const instance = this.instances.get(id);
    if (!instance) throw new Error('BROWSER_INSTANCE_NOT_FOUND');
    return instance;
  }

  private update(instance: BrowserInstance, patch: Partial<BrowserInstance>): void {
    Object.assign(instance, patch, { updatedAt: new Date().toISOString() });
    this.persist();
  }

  private handleBridgeMessage(id: string, raw: string): void {
    let message: Record<string, unknown>;
    try { message = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
    const current = this.instances.get(id);
    if (message.type === 'ready' && current) this.update(current, { state: 'READY' });
    const requestId = typeof message.requestId === 'string' ? message.requestId : undefined;
    if (!requestId) return;
    const pending = this.bridgePending.get(requestId);
    if (!pending || pending.browserId !== id) return;
    clearTimeout(pending.timer);
    this.bridgePending.delete(requestId);
    if (message.ok === false || typeof message.error === 'string') pending.reject(new Error(String(message.error ?? 'BRIDGE_ERROR')));
    else pending.resolve(message.result ?? message.payload ?? message);
  }

  private rejectBridgeCalls(id: string, code: string): void {
    for (const [requestId, pending] of this.bridgePending) {
      if (pending.browserId !== id) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error(code));
      this.bridgePending.delete(requestId);
    }
  }

  private load(): void {
    if (!this.statePath) return;
    try {
      const state = JSON.parse(readFileSync(this.statePath, 'utf8')) as PersistedState;
      for (const instance of state.instances ?? []) {
        const restored: BrowserInstance = { ...instance, state: instance.mode === 'bridge' ? 'AWAITING_BRIDGE' : 'STOPPED' };
        delete restored.sessionId;
        this.instances.set(instance.id, restored);
      }
      for (const binding of state.bindings ?? []) this.bindings.set(binding.host, binding);
    } catch {
      // A missing or corrupt metadata file must not prevent the control plane
      // from starting; the next write replaces it with bounded state.
    }
  }

  private persist(): void {
    if (!this.statePath) return;
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      const state: PersistedState = { instances: this.list(), bindings: this.bindingsList() };
      writeFileSync(this.statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
    } catch {
      // Runtime state remains authoritative; persistence failure is surfaced by
      // the next health read in a future revision.
    }
  }
}

const BRIDGE_OPERATIONS = new Set([
  'navigate', 'click', 'input', 'select', 'scroll', 'snapshot', 'screenshot',
  'tabs.list', 'tabs.create', 'tabs.switch', 'tabs.close', 'bind.current',
]);

function validateBridgePayload(payload: Record<string, unknown>): void {
  const operation = payload.op;
  if (typeof operation !== 'string' || !BRIDGE_OPERATIONS.has(operation)) throw new Error('BRIDGE_OPERATION_DENIED');
  if (Object.keys(payload).length > 16 || JSON.stringify(payload).length > 64 * 1024) throw new Error('BRIDGE_PAYLOAD_TOO_LARGE');
  for (const key of Object.keys(payload)) {
    if (/script|evaluate|cookie|credential|token|raw|protocol|header|upload|download|request/i.test(key)) throw new Error('BRIDGE_FIELD_DENIED');
  }
}

function safeName(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(normalized)) throw new Error('INVALID_NAME');
  return normalized;
}

function safeEndpoint(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password) throw new Error('INVALID_CDP_ENDPOINT');
  return url.toString();
}

function normalizeHost(value: string): string {
  const host = value.trim().toLowerCase().replace(/\.$/, '');
  if (!/^(?:[a-z0-9-]+\.)*[a-z0-9-]+$/.test(host) || host.length > 253) throw new Error('INVALID_HOST');
  return host;
}

function boundedPort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error('INVALID_PORT');
  return value;
}
