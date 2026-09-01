import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';

import { handleToolCall } from '../mcp/server.js';
import type { McpRuntimeGuard } from '../mcp/runtime-guard.js';
import type { TenantAuthenticator } from '../auth/tenant-auth.js';
import type { SessionManager } from '../browser/session-manager.js';
import { BrowserPool } from './browser-pool.js';
import { ACTION_PACKS, PLATFORM_ADAPTERS } from './catalog.js';

export interface ControlPlaneOptions {
  host?: string;
  port?: number;
  token?: string;
  statePath?: string;
  runtimeGuard?: McpRuntimeGuard;
  audit?: { record(event: Record<string, unknown>): Promise<void> | void };
  tenantAuthenticator?: TenantAuthenticator;
}

export interface ControlPlane {
  readonly pool: BrowserPool;
  readonly server: ReturnType<typeof createServer>;
  start(): Promise<void>;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 128 * 1024;

export function createControlPlane(manager: SessionManager, options: ControlPlaneOptions = {}): ControlPlane {
  const pool = new BrowserPool(manager, { ...(options.statePath ? { statePath: options.statePath } : {}) });
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8081;
  const agentWss = new WebSocketServer({ noServer: true });
  const bridgeWss = new WebSocketServer({ noServer: true });

  const server = createServer(async (request, response) => {
    try {
      if (!authorized(request, options.token)) return send(response, 401, { error: 'UNAUTHORIZED' });
      await route(request, response, pool, manager, options);
    } catch (error) {
      send(response, 400, { error: error instanceof Error ? error.message : 'BAD_REQUEST' });
    }
  });

  server.on('upgrade', (request, socket, head) => {
    if (!authorized(request, options.token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const pathname = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`).pathname;
    const bridgeMatch = pathname.match(/^\/ws\/bridge\/([^/]+)$/);
    if (pathname !== '/ws/agents' && !bridgeMatch) {
      socket.destroy();
      return;
    }
    if (bridgeMatch) {
      bridgeWss.handleUpgrade(request, socket, head, (client) => {
        try { pool.attachBridge(decodeURIComponent(bridgeMatch[1]!), client); }
        catch { client.close(1008, 'invalid bridge'); }
      });
      return;
    }
    agentWss.handleUpgrade(request, socket, head, (client) => agentWss.emit('connection', client, request));
  });

  agentWss.on('connection', (socket: WebSocket) => {
    socket.send(JSON.stringify({ type: 'hello', protocol: 'control-plane.v1' }));
    socket.on('message', async (raw) => {
      let message: Record<string, unknown> = {};
      try {
        message = JSON.parse(raw.toString()) as Record<string, unknown>;
        const result = await dispatchAgentMessage(message, pool, manager, options);
        socket.send(JSON.stringify({ id: message.id, ok: true, result }));
      } catch (error) {
        socket.send(JSON.stringify({ id: message.id, ok: false, error: error instanceof Error ? error.message : 'BAD_REQUEST' }));
      }
    });
  });

  return {
    pool,
    server,
    start: () => new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    }),
    close: async () => {
      for (const client of agentWss.clients) client.terminate();
      for (const client of bridgeWss.clients) client.terminate();
      agentWss.close();
      bridgeWss.close();
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function route(request: IncomingMessage, response: ServerResponse, pool: BrowserPool, manager: SessionManager, options: ControlPlaneOptions): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (request.method === 'GET' && url.pathname === '/health') return send(response, 200, { ok: true, service: 'browser-control-plane' });
  if (request.method === 'GET' && url.pathname === '/') return sendHtml(response);
  if (request.method === 'GET' && url.pathname === '/api/browsers') return send(response, 200, { items: pool.list() });
  if (request.method === 'GET' && url.pathname === '/api/bindings') return send(response, 200, { items: pool.bindingsList() });
  if (request.method === 'GET' && url.pathname === '/api/capabilities') {
    return send(response, 200, { engine: 'firefox+chromium', bridge: 'ws-rpc', bridgeOperations: ['navigate', 'click', 'input', 'select', 'scroll', 'snapshot', 'screenshot', 'tabs.list', 'tabs.create', 'tabs.switch', 'tabs.close', 'bind.current'], cdp: true, noVnc: 'container', remoteAgent: true });
  }
  if (request.method === 'GET' && url.pathname === '/api/platforms') return send(response, 200, { items: PLATFORM_ADAPTERS });
  if (request.method === 'GET' && url.pathname === '/api/skills') return send(response, 200, { items: ACTION_PACKS });
  if (request.method === 'POST' && url.pathname === '/api/browsers') {
    const input = await body(request) as { name?: string; engine?: 'firefox' | 'chromium'; mode?: 'managed' | 'cdp' | 'bridge'; profileName?: string; cdpEndpoint?: string; noVncPort?: number; start?: boolean };
    if (!input.name) throw new Error('NAME_REQUIRED');
    return send(response, 201, await pool.add({ ...input, name: input.name }));
  }
  const browserMatch = url.pathname.match(/^\/api\/browsers\/([^/]+)\/(start|stop)$/);
  if (request.method === 'POST' && browserMatch) {
    const instance = browserMatch[2] === 'start' ? await pool.start(browserMatch[1]!) : await pool.stop(browserMatch[1]!);
    return send(response, 200, instance);
  }
  const configureMatch = url.pathname.match(/^\/api\/browsers\/([^/]+)$/);
  if (request.method === 'PATCH' && configureMatch) {
    return send(response, 200, pool.configure(configureMatch[1]!, await body(request) as { name?: string; engine?: 'firefox' | 'chromium'; mode?: 'managed' | 'cdp' | 'bridge'; profileName?: string | null; cdpEndpoint?: string | null; noVncPort?: number | null }));
  }
  const deleteMatch = url.pathname.match(/^\/api\/browsers\/([^/]+)$/);
  if (request.method === 'DELETE' && deleteMatch) { await pool.remove(deleteMatch[1]!); return send(response, 204, undefined); }
  if (request.method === 'POST' && url.pathname === '/api/bindings') {
    const input = await body(request) as { host?: string; browserId?: string };
    if (!input.host || !input.browserId) throw new Error('HOST_AND_BROWSER_ID_REQUIRED');
    return send(response, 201, pool.bind(input.host, input.browserId));
  }
  const bindingMatch = url.pathname.match(/^\/api\/bindings\/(.+)$/);
  if (request.method === 'DELETE' && bindingMatch) { pool.unbind(decodeURIComponent(bindingMatch[1]!)); return send(response, 204, undefined); }
  if (request.method === 'POST' && url.pathname === '/api/agent/call') {
    const input = await body(request) as { tool?: string; input?: unknown };
    if (!input.tool) throw new Error('TOOL_REQUIRED');
    return send(response, 200, await handleToolCall(manager, input.tool, input.input ?? {}, {
      ...(options.runtimeGuard ? { runtimeGuard: options.runtimeGuard } : {}),
      ...(options.audit ? { audit: options.audit } : {}),
      ...(options.tenantAuthenticator ? { tenantAuthenticator: options.tenantAuthenticator } : {}),
    }));
  }
  send(response, 404, { error: 'NOT_FOUND' });
}

async function dispatchAgentMessage(message: Record<string, unknown>, pool: BrowserPool, manager: SessionManager, options?: ControlPlaneOptions): Promise<unknown> {
  switch (message.type) {
    case 'list_browsers': return pool.list();
    case 'list_bindings': return pool.bindingsList();
    case 'start_browser': return pool.start(String(message.browserId));
    case 'stop_browser': return pool.stop(String(message.browserId));
    case 'bind_site': return pool.bind(String(message.host), String(message.browserId));
    case 'mcp_call': return handleToolCall(manager, String(message.tool), message.input ?? {}, {
      ...(options?.runtimeGuard ? { runtimeGuard: options.runtimeGuard } : {}),
      ...(options?.audit ? { audit: options.audit } : {}),
      ...(options?.tenantAuthenticator ? { tenantAuthenticator: options.tenantAuthenticator } : {}),
    });
    case 'bridge_call': {
      const payload = message.input;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('BRIDGE_INPUT_REQUIRED');
      return pool.bridgeCall(String(message.browserId), payload as Record<string, unknown>);
    }
    default: throw new Error('UNKNOWN_AGENT_MESSAGE');
  }
}

function authorized(request: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const header = request.headers.authorization;
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  return header === `Bearer ${token}` || url.searchParams.get('token') === token;
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error('REQUEST_TOO_LARGE');
    chunks.push(value);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON_OBJECT_REQUIRED');
  return parsed as Record<string, unknown>;
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  if (status === 204) { response.end(); return; }
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(value));
}

function sendHtml(response: ServerResponse): void {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><meta charset="utf-8"><title>Browser Control Plane</title><style>body{font:14px system-ui;margin:2rem;background:#f6f7f9;color:#17202a}main{max-width:960px;margin:auto}form,section{background:white;padding:1rem;border-radius:8px;margin:1rem 0;box-shadow:0 1px 4px #0001}input,select,button{padding:.45rem;margin:.2rem}button{cursor:pointer}table{width:100%;border-collapse:collapse}td,th{padding:.5rem;text-align:left;border-bottom:1px solid #eee}.state{font-weight:600}</style><main><h1>Browser Control Plane</h1><p>管理 Chromium/Firefox、Bridge/CDP 连接与站点绑定。远程 Agent WebSocket：<code>/ws/agents</code>。</p><form id="add"><input name="name" placeholder="实例名" required pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}"><select name="engine"><option value="chromium">Chromium</option><option value="firefox">Firefox</option></select><select name="mode"><option value="managed">managed</option><option value="cdp">cdp</option><option value="bridge">bridge</option></select><input name="cdpEndpoint" placeholder="CDP endpoint（cdp 模式）"><button>添加实例</button></form><section><table><thead><tr><th>名称</th><th>模式</th><th>引擎</th><th>状态</th><th>操作</th></tr></thead><tbody id="rows"></tbody></table></section></main><script>const rows=document.querySelector('#rows');const form=document.querySelector('#add');const q=location.search;async function load(){const x=await fetch('/api/browsers'+q).then(r=>r.json());rows.replaceChildren(...x.items.map(i=>{const tr=document.createElement('tr');for(const k of ['name','mode','engine','state']){const td=document.createElement('td');td.textContent=i[k];if(k==='state')td.className='state';tr.append(td)}const td=document.createElement('td');const b=document.createElement('button');b.textContent=i.state==='READY'?'停止':'启动';b.onclick=async()=>{await fetch('/api/browsers/'+encodeURIComponent(i.id)+'/'+(i.state==='READY'?'stop':'start')+q,{method:'POST'});load()};td.append(b);tr.append(td);return tr}))}form.onsubmit=async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(form));if(!data.cdpEndpoint)delete data.cdpEndpoint;await fetch('/api/browsers'+q,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...data,start:true})});form.reset();load()};load();setInterval(load,5000)</script>`);
}
