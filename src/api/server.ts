import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { URL } from 'node:url';
import type { SessionManager } from '../browser/session-manager.js';
import type { DistributedTaskDefinition, DistributedTaskRecord, TaskExecutionMode, TaskPriority, TaskState } from '../distributed/types.js';
import type { ApiResponse } from './types.js';
import { SERVER_VERSION } from '../capabilities.js';
import { generateTotp } from '../auth/totp.js';
import { WindowSynchronizer } from '../synchronizer/index.js';
import type { AuditLogger } from '../audit.js';
import type { ProxyPoolStore } from '../proxy/pool-store.js';
import type { RpaService } from '../rpa/service.js';
import type { TeamAccessStore, TeamIdentity } from '../team/access-store.js';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ExternalRuntimeRegistry } from '../platform/provider-registry.js';
import type { ManagedExtensionStore } from '../extension/managed-extension-store.js';
import { managedBrowserIdentity } from '../fingerprint/runtime-identity.js';
import { LocalBrowserImporter } from '../migration/local-browser-importer.js';
import { BrowserPool } from '../control-plane/browser-pool.js';

export type StudioRole = 'viewer' | 'operator' | 'manager' | 'owner';
export interface StudioCredential { readonly token: string; readonly role: StudioRole; readonly label?: string; readonly workspaceId?: string; readonly grants?: TeamIdentity['grants']; }
type StudioIdentity = { role: StudioRole; label?: string; workspaceId?: string; memberId?: string; grants?: TeamIdentity['grants'] };

export interface RestApiServerOptions {
  readonly port?: number;
  readonly host?: string;
  readonly publicDir?: string;
  readonly credentials?: readonly StudioCredential[];
  readonly bootstrapToken?: string;
  readonly allowedOrigins?: readonly string[];
  readonly audit?: AuditLogger;
  readonly proxyPool?: ProxyPoolStore;
  readonly rpa?: RpaService;
  readonly teamAccess?: TeamAccessStore;
  readonly externalRuntimes?: ExternalRuntimeRegistry;
  readonly extensionStore?: ManagedExtensionStore;
  readonly localBrowserImporter?: Pick<LocalBrowserImporter, 'scan' | 'importProfile'>;
  readonly browserPool?: BrowserPool;
}

export class RestApiServer {
  private server: Server | null = null;
  private readonly publicDir: string;
  private readonly profileSessionMap = new Map<string, string>(); // profileId -> sessionId
  private actualPort = 3000;
  private actualHost = '127.0.0.1';
  private bootstrapUsed = false;
  private readonly synchronizer: WindowSynchronizer;
  private readonly localBrowserImporter: Pick<LocalBrowserImporter, 'scan' | 'importProfile'>;
  public readonly browserPool: BrowserPool;
  private webSockets: WebSocketServer | undefined;
  private bridgeWebSockets: WebSocketServer | undefined;

  constructor(
    private readonly manager: SessionManager,
    private readonly options: RestApiServerOptions = {},
  ) {
    this.publicDir = options.publicDir || resolve(process.cwd(), 'public');
    this.synchronizer = new WindowSynchronizer(manager);
    this.localBrowserImporter = options.localBrowserImporter ?? new LocalBrowserImporter(manager.getStore());
    this.browserPool = options.browserPool ?? new BrowserPool(manager);
  }

  public async start(): Promise<{ port: number; host: string }> {
    const port = this.options.port ?? 3000;
    const host = this.options.host ?? '127.0.0.1';

    return new Promise((resolvePromise, reject) => {
      const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        await this.handleRequest(req, res);
      });
      const webSockets = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
      const bridgeWebSockets = new WebSocketServer({ noServer: true, maxPayload: 9 * 1024 * 1024 });
      this.webSockets = webSockets;
      this.bridgeWebSockets = bridgeWebSockets;
      server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
        const bridgeMatch = url.pathname.match(/^\/ws\/bridge(?:\/([^/]+))?$/);
        if (bridgeMatch) {
          bridgeWebSockets.handleUpgrade(req, socket, head, (client) => {
            try {
              const specifiedId = bridgeMatch[1] ? decodeURIComponent(bridgeMatch[1]) : undefined;
              this.browserPool.attachOrAutoRegisterBridge(client, specifiedId);
            } catch {
              client.close(1008, 'invalid bridge');
            }
          });
          return;
        }

        const match = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/ws$/);
        const identity = this.authenticate(req);
        if (!match || !identity || !roleAllows(identity.role, 'operator') || !this.canAccessResource(identity, 'profile', this.profileForSession(decodeURIComponent(match[1]!)) ?? '*')) {
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
        }
        const sessionId = decodeURIComponent(match[1]!);
        try { this.manager.status(sessionId); } catch { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
        webSockets.handleUpgrade(req, socket, head, (ws) => { this.attachAutomationSocket(ws, sessionId); });
      });

      server.on('error', (err: Error) => {
        reject(err);
      });

      server.listen(port, host, () => {
        this.server = server;
        const addr = server.address();
        const actualPort = addr && typeof addr === 'object' ? addr.port : port;
        this.actualPort = actualPort;
        this.actualHost = host;
        resolvePromise({ port: actualPort, host });
      });
    });
  }

  public async stop(): Promise<void> {
    this.synchronizer.shutdown();
    for (const client of this.webSockets?.clients ?? []) client.close(1001, 'server shutdown');
    this.webSockets?.close();
    this.webSockets = undefined;
    for (const client of this.bridgeWebSockets?.clients ?? []) client.close(1001, 'server shutdown');
    this.bridgeWebSockets?.close();
    this.bridgeWebSockets = undefined;
    if (!this.server) return;
    return new Promise((resolvePromise, reject) => {
      this.server?.close((err?: Error) => {
        if (err) reject(err);
        else {
          this.server = null;
          resolvePromise();
        }
      });
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Same-origin UI needs no CORS. Explicit origins are opt-in for trusted local clients.
    const origin = req.headers.origin;
    if (origin && this.options.allowedOrigins?.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'OPTIONS') {
      res.statusCode = !origin || this.options.allowedOrigins?.includes(origin) ? 204 : 403;
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = parsedUrl.pathname;
    const method = req.method?.toUpperCase();
    if (method === 'GET' && pathname === '/' && parsedUrl.searchParams.has('bootstrap')) {
      const supplied = parsedUrl.searchParams.get('bootstrap');
      if (!this.bootstrapUsed && this.options.bootstrapToken && supplied === this.options.bootstrapToken) {
        this.bootstrapUsed = true;
        const owner = this.options.credentials?.find((credential) => credential.role === 'owner');
        if (owner) res.setHeader('Set-Cookie', `studio_token=${encodeURIComponent(owner.token)}; HttpOnly; SameSite=Strict; Path=/`);
        res.statusCode = 303;
        res.setHeader('Location', '/');
        res.end();
        void this.options.audit?.record({ action: 'studio_bootstrap', route: '/', outcome: 'success', statusCode: 303 }).catch(() => undefined);
        return;
      }
      this.sendJson(res, 403, { success: false, code: 'BOOTSTRAP_DENIED', message: 'Bootstrap token is invalid or already used', timestamp: Date.now() });
      void this.options.audit?.record({ action: 'studio_bootstrap', route: '/', outcome: 'error', statusCode: 403 }).catch(() => undefined);
      return;
    }

    // 轻量静默探活端点（参考 OpenCLI，供 Bridge 扩展和桌面工具秒级发现服务）
    if (method === 'GET' && (pathname === '/ping' || pathname === '/api/v1/ping')) {
      this.sendJson(res, 200, { success: true, code: 'OK', data: { service: 'antigravity-studio-bridge', port: this.actualPort }, timestamp: Date.now() });
      return;
    }

    const identity = this.authenticate(req);
    res.once('finish', () => {
      void this.options.audit?.record({
        action: 'studio_http',
        method,
        route: routeTemplate(pathname),
        outcome: res.statusCode < 400 ? 'success' : 'error',
        statusCode: res.statusCode,
        ...(identity ? { actor: identity.label ?? identity.role, role: identity.role } : {}),
      }).catch(() => undefined);
    });
    if (pathname.startsWith('/api/') && pathname !== '/api/v1/health' && pathname !== '/api/v1/ping') {
      if (!identity) {
        this.sendJson(res, 401, { success: false, code: 'UNAUTHENTICATED', message: 'Studio authentication is required', timestamp: Date.now() });
        return;
      }
      if (!roleAllows(identity.role, requiredRole(method, pathname))) {
        this.sendJson(res, 403, { success: false, code: 'PERMISSION_DENIED', message: 'This role cannot perform the requested operation', timestamp: Date.now() });
        return;
      }
      const resource = resourceFromPath(pathname);
      if (resource && !this.canAccessResource(identity, resource.kind, resource.id)) {
        this.sendJson(res, 403, { success: false, code: 'RESOURCE_ACCESS_DENIED', message: 'This API key has no grant for the requested resource', timestamp: Date.now() });
        return;
      }
    }
    try {
      // 0. Static Frontend Files
      if (method === 'GET' && !pathname.startsWith('/api/')) {
        const handled = await this.serveStatic(pathname, res);
        if (handled) return;
      }

      // 1. Health & Version
      if (pathname === '/api/v1/health' && method === 'GET') {
        this.sendJson(res, 200, {
          success: true,
          code: 'OK',
          data: {
            name: 'Browser Profile Isolation Studio API',
            version: SERVER_VERSION,
            status: 'healthy',
            activeSessions: this.profileSessionMap.size,
            timestamp: Date.now(),
          },
          timestamp: Date.now(),
        });
        return;
      }

      if (pathname === '/api/v1/auth/me' && method === 'GET') {
        this.sendJson(res, 200, { success: true, code: 'OK', data: identity, timestamp: Date.now() });
        return;
      }

      if (pathname === '/api/v1/openapi.json' && method === 'GET') {
        this.sendJson(res, 200, { success: true, code: 'OK', data: studioOpenApiDocument(this.actualHost, this.actualPort), timestamp: Date.now() });
        return;
      }
      if (pathname === '/api/v1/product/capabilities' && method === 'GET') {
        this.sendJson(res, 200, { success: true, code: 'OK', data: {
          localBrowser: true, persistentProfiles: true, encryptedSecrets: true, trashRestore: true,
          proxyEgressVerification: true, rpaControlFlow: true, liveSynchronizer: true, websocketAutomation: true,
          managedExtensionLoading: Boolean(this.options.extensionStore), unmanagedExtensionLoading: false,
          extensionPolicy: 'Only owner-imported, reviewed and hash-pinned packages assigned by managed extension ID are accepted',
          managedBrowserVersions: {
            chromium: managedBrowserIdentity('chromium').fullVersion,
            firefox: managedBrowserIdentity('firefox').fullVersion,
          },
          serviceWorkerFingerprintInjection: true,
          serviceWorkerFingerprintInjectionByEngine: { chromium: true, firefox: true },
          firefoxNativeServiceWorkerIdentity: true,
          serviceWorkerReason: 'Chromium aligns via CDP background target injection; Firefox aligns via native user preferences and cross-channel shadow proxy alignment (MessagePort, BroadcastChannel, ServiceWorkerContainer)',
          externalRuntimes: this.options.externalRuntimes?.list() ?? [],
        }, timestamp: Date.now() }); return;
      }
      const sessionDiagnosticsMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/diagnostics$/);
      if (sessionDiagnosticsMatch && method === 'GET') {
        const sessionId = decodeURIComponent(sessionDiagnosticsMatch[1]!);
        const profileId = this.profileForSession(sessionId);
        if (profileId && !this.canAccessResource(identity!, 'profile', profileId)) {
          this.sendJson(res, 403, { success: false, code: 'RESOURCE_ACCESS_DENIED', message: 'This API key has no grant for the requested profile', timestamp: Date.now() });
          return;
        }
        const diagnostics = await this.manager.environmentDiagnostics(sessionId);
        this.sendJson(res, 200, { success: true, code: 'OK', data: diagnostics, timestamp: Date.now() });
        return;
      }
      if (pathname === '/api/v1/product/runtime-health' && method === 'GET') {
        this.sendJson(res, 200, { success: true, code: 'OK', data: await this.options.externalRuntimes?.health() ?? [], timestamp: Date.now() }); return;
      }
      const runtimeCreateMatch = pathname.match(/^\/api\/v1\/external-runtimes\/([^/]+)\/create$/);
      if (runtimeCreateMatch && method === 'POST') {
        if (!this.options.externalRuntimes) { this.sendJson(res, 503, { success: false, code: 'RUNTIME_PROVIDER_UNAVAILABLE', message: 'No external runtime registry is configured', timestamp: Date.now() }); return; }
        const providerId = decodeURIComponent(runtimeCreateMatch[1]!);
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(providerId)) throw new Error('PROVIDER_ID_INVALID');
        const body = await this.readJsonBody(req, 256 * 1024);
        const runtimeOptions = body.options && typeof body.options === 'object' && !Array.isArray(body.options) ? body.options : {};
        const created = await this.options.externalRuntimes.create(providerId, runtimeOptions);
        this.sendJson(res, 201, { success: true, code: 'CREATED', data: created, timestamp: Date.now() }); return;
      }
      const runtimeStopMatch = pathname.match(/^\/api\/v1\/external-runtimes\/([^/]+)\/([^/]+)\/stop$/);
      if (runtimeStopMatch && method === 'POST') {
        if (!this.options.externalRuntimes) { this.sendJson(res, 503, { success: false, code: 'RUNTIME_PROVIDER_UNAVAILABLE', message: 'No external runtime registry is configured', timestamp: Date.now() }); return; }
        const providerId = decodeURIComponent(runtimeStopMatch[1]!);
        const runtimeId = decodeURIComponent(runtimeStopMatch[2]!);
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(providerId)) throw new Error('PROVIDER_ID_INVALID');
        await this.options.externalRuntimes.stop(providerId, runtimeId);
        this.sendJson(res, 200, { success: true, code: 'OK', data: { providerId, runtimeId, stopped: true }, timestamp: Date.now() }); return;
      }
      if (pathname === '/api/v1/metrics' && method === 'GET') {
        const memory = process.memoryUsage();
        this.sendJson(res, 200, { success: true, code: 'OK', data: { uptimeSeconds: Math.floor(process.uptime()), activeSessions: this.profileSessionMap.size, synchronizers: this.synchronizer.listCaptures().length, heapUsedBytes: memory.heapUsed, rssBytes: memory.rss, profiles: (await this.manager.listProfiles()).length, proxies: (await this.options.proxyPool?.list() ?? []).length, rpaTasks: (await this.options.rpa?.listTasks() ?? []).length }, timestamp: Date.now() }); return;
      }

      // Managed extension center: package review, integrity and Profile assignment.
      if (pathname === '/api/v1/extensions' && method === 'GET' && this.options.extensionStore) {
        const records = (await this.options.extensionStore.list()).filter((record) => this.canAccessResource(identity!, 'extension', record.extensionId));
        this.sendJson(res, 200, { success: true, code: 'OK', data: records, timestamp: Date.now() }); return;
      }
      if (pathname === '/api/v1/extensions/import' && method === 'POST' && this.options.extensionStore) {
        const record = await this.options.extensionStore.importPackage(await this.readJsonBody(req, 18 * 1024 * 1024) as any);
        this.sendJson(res, 201, { success: true, code: 'CREATED', data: record, timestamp: Date.now() }); return;
      }
      const extensionMatch = pathname.match(/^\/api\/v1\/extensions\/([^/]+)$/);
      if (extensionMatch && this.options.extensionStore) {
        const extensionId = decodeURIComponent(extensionMatch[1]!);
        if (method === 'PUT') { const record = await this.options.extensionStore.update(extensionId, await this.readJsonBody(req)); this.sendJson(res, 200, { success: true, code: 'OK', data: record, timestamp: Date.now() }); return; }
        if (method === 'DELETE') {
          const assigned = (await this.manager.listProfiles()).filter((profile) => profile.extensionIds?.includes(extensionId)).map((profile) => profile.profileId);
          if (assigned.length) { this.sendJson(res, 409, { success: false, code: 'EXTENSION_IN_USE', message: `Extension is assigned to ${assigned.length} profile(s)`, data: { profileIds: assigned }, timestamp: Date.now() }); return; }
          this.sendJson(res, 200, { success: true, code: 'OK', data: { deleted: await this.options.extensionStore.delete(extensionId) }, timestamp: Date.now() }); return;
        }
      }

      // Team workspaces, members, resource grants and revocable hashed API keys.
      if (pathname === '/api/v1/team/workspaces' && this.options.teamAccess) {
        if (method === 'GET') { this.sendJson(res, 200, { success: true, code: 'OK', data: this.options.teamAccess.listWorkspaces(), timestamp: Date.now() }); return; }
        if (method === 'POST') { const value = await this.options.teamAccess.createWorkspace(String((await this.readJsonBody(req)).name ?? '')); this.sendJson(res, 201, { success: true, code: 'CREATED', data: value, timestamp: Date.now() }); return; }
      }
      if (pathname === '/api/v1/team/members' && this.options.teamAccess) {
        if (method === 'GET') { this.sendJson(res, 200, { success: true, code: 'OK', data: this.options.teamAccess.listMembers(parsedUrl.searchParams.get('workspaceId') ?? undefined), timestamp: Date.now() }); return; }
        if (method === 'POST') { const value = await this.options.teamAccess.createMember(await this.readJsonBody(req) as any); this.sendJson(res, 201, { success: true, code: 'CREATED', data: value, timestamp: Date.now() }); return; }
      }
      const memberMatch = pathname.match(/^\/api\/v1\/team\/members\/([^/]+)$/);
      if (memberMatch && method === 'PUT' && this.options.teamAccess) { const value = await this.options.teamAccess.updateMember(decodeURIComponent(memberMatch[1]!), await this.readJsonBody(req) as any); this.sendJson(res, 200, { success: true, code: 'OK', data: value, timestamp: Date.now() }); return; }
      const memberKeysMatch = pathname.match(/^\/api\/v1\/team\/members\/([^/]+)\/api-keys$/);
      if (memberKeysMatch && this.options.teamAccess) {
        const memberId = decodeURIComponent(memberKeysMatch[1]!);
        if (method === 'GET') { this.sendJson(res, 200, { success: true, code: 'OK', data: this.options.teamAccess.listApiKeys(memberId), timestamp: Date.now() }); return; }
        if (method === 'POST') { const body = await this.readJsonBody(req); const key = await this.options.teamAccess.issueApiKey(memberId, body.label); this.sendJson(res, 201, { success: true, code: 'CREATED', data: key, timestamp: Date.now() }); return; }
      }
      const revokeKeyMatch = pathname.match(/^\/api\/v1\/team\/api-keys\/([^/]+)\/revoke$/);
      if (revokeKeyMatch && method === 'POST' && this.options.teamAccess) { this.sendJson(res, 200, { success: true, code: 'OK', data: { revoked: await this.options.teamAccess.revokeApiKey(decodeURIComponent(revokeKeyMatch[1]!)) }, timestamp: Date.now() }); return; }

      // 2. Active Sessions List
      if (pathname === '/api/v1/sessions' && method === 'GET') {
        const list = [];
        for (const [profileId, sid] of this.profileSessionMap.entries()) {
          try {
            const status = this.manager.status(sid);
            list.push({ profileId, ...status });
          } catch {
            this.profileSessionMap.delete(profileId);
          }
        }
        this.sendJson(res, 200, {
          success: true,
          code: 'OK',
          data: list,
          timestamp: Date.now(),
        });
        return;
      }

      // 3. Profiles Management
      if (pathname === '/api/v1/profiles' && method === 'GET') {
        const allProfiles = await this.manager.listProfiles();
        const query = (parsedUrl.searchParams.get('q') ?? '').trim().toLowerCase();
        const accessible = allProfiles.filter((profile) => this.canAccessResource(identity!, 'profile', profile.profileId));
        const filtered = query ? accessible.filter((profile) => profile.name.toLowerCase().includes(query) || profile.profileId.toLowerCase().includes(query) || profile.tags?.some((tag) => tag.toLowerCase().includes(query))) : accessible;
        const offset = boundedQueryInteger(parsedUrl.searchParams.get('offset'), 0, 100_000, 0);
        const limit = boundedQueryInteger(parsedUrl.searchParams.get('limit'), 1, 500, 100);
        const profiles = filtered.slice(offset, offset + limit);
        res.setHeader('X-Total-Count', String(filtered.length));
        res.setHeader('X-Offset', String(offset));
        res.setHeader('X-Limit', String(limit));
        this.sendJson(res, 200, {
          success: true,
          code: 'OK',
          data: profiles,
          timestamp: Date.now(),
        });
        return;
      }

      if (pathname === '/api/v1/profiles/trash' && method === 'GET') {
        this.sendJson(res, 200, { success: true, code: 'OK', data: await this.manager.listDeletedProfiles(), timestamp: Date.now() });
        return;
      }
      const restoreProfileMatch = pathname.match(/^\/api\/v1\/profiles\/([^/]+)\/restore$/);
      if (restoreProfileMatch && method === 'POST') { const restored = await this.manager.restoreProfile(decodeURIComponent(restoreProfileMatch[1]!)); this.sendJson(res, 200, { success: true, code: 'OK', data: publicProfile(restored), timestamp: Date.now() }); return; }
      const purgeProfileMatch = pathname.match(/^\/api\/v1\/profiles\/([^/]+)\/purge$/);
      if (purgeProfileMatch && method === 'DELETE') { this.sendJson(res, 200, { success: true, code: 'OK', data: { purged: await this.manager.purgeDeletedProfile(decodeURIComponent(purgeProfileMatch[1]!)) }, timestamp: Date.now() }); return; }

      if (pathname === '/api/v1/profiles' && method === 'POST') {
        const body = await this.readJsonBody(req);
        if (!body.name || typeof body.name !== 'string') {
          this.sendJson(res, 400, {
            success: false,
            code: 'INVALID_INPUT',
            message: 'Field "name" is required for creating a profile',
            timestamp: Date.now(),
          });
          return;
        }
        await this.validateExtensionIds(body.extensionIds, body.engine === 'chromium' ? 'chromium' : 'firefox', identity!);
        const created = await this.manager.createProfile(body as any);
        this.sendJson(res, 201, {
          success: true,
          code: 'CREATED',
          data: publicProfile(created),
          timestamp: Date.now(),
        });
        return;
      }

      // Profile Detail / Delete / Start / Stop / Cookies
      const profileExtensionsMatch = pathname.match(/^\/api\/v1\/profiles\/([^/]+)\/extensions$/);
      if (profileExtensionsMatch && method === 'PUT' && this.options.extensionStore) {
        const profileId = decodeURIComponent(profileExtensionsMatch[1]!);
        const profile = await this.manager.getProfile(profileId);
        if (!profile) { this.sendJson(res, 404, { success: false, code: 'PROFILE_NOT_FOUND', message: 'Profile was not found', timestamp: Date.now() }); return; }
        const body = await this.readJsonBody(req);
        await this.validateExtensionIds(body.extensionIds, profile.engine ?? 'firefox', identity!);
        const ids = [...new Set(body.extensionIds as string[])];
        const updated = await this.manager.updateProfile(profileId, { extensionIds: ids as string[] });
        this.sendJson(res, 200, { success: true, code: 'OK', data: publicProfile(updated), timestamp: Date.now() }); return;
      }
      const profileStartMatch = pathname.match(/^\/api\/v1\/profiles\/([^/]+)\/start$/);
      if (profileStartMatch && method === 'POST') {
        const profileId = decodeURIComponent(profileStartMatch[1]!);
        const body = await this.readJsonBody(req);
        
        // 检查是否已有活跃会话
        const existingSessionId = this.profileSessionMap.get(profileId);
        if (existingSessionId) {
          try {
            const currentStatus = this.manager.status(existingSessionId);
            this.sendJson(res, 200, {
              success: true,
              code: 'ALREADY_RUNNING',
              data: { sessionId: existingSessionId, state: currentStatus.state },
              timestamp: Date.now(),
            });
            return;
          } catch {
            this.profileSessionMap.delete(profileId);
          }
        }

        const profileMeta = await this.manager.getProfile(profileId).catch(() => null);
        const session = await this.manager.start({
          profileId,
          headless: body.headless ?? false, // 默认拉起真实窗口
          fingerprint: true,
          inputProfile: 'paced',
        });

        this.profileSessionMap.set(profileId, session.sessionId);

        // 如果是非无头真实桌面窗口，自动导航到欢迎与指纹就绪检测页
        if (body.headless !== true) {
          const welcomeUrl = `http://${this.actualHost}:${this.actualPort}/welcome.html?profileId=${encodeURIComponent(profileId)}&name=${encodeURIComponent(profileMeta?.name || '指纹环境')}`;
          this.manager.open(session.sessionId, welcomeUrl, { waitUntil: 'domcontentloaded', timeoutMs: 10000 }).catch(() => {});
        }

        const status = session.status();

        this.sendJson(res, 200, {
          success: true,
          code: 'OK',
          data: {
            profileId,
            sessionId: session.sessionId,
            state: status.state,
            headless: status.headless,
          },
          timestamp: Date.now(),
        });
        return;
      }

      // 快速直达沙箱启动
      if (pathname === '/api/v1/browser/start' && method === 'POST') {
        const body = await this.readJsonBody(req);
        const session = await this.manager.start({
          headless: body.headless ?? false,
          fingerprint: true,
          inputProfile: body.inputProfile || 'paced',
          countryCode: body.countryCode || 'CN',
        });
        if (body.url) {
          this.manager.open(session.sessionId, body.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
        }
        this.sendJson(res, 200, {
          success: true,
          code: 'OK',
          data: { sessionId: session.sessionId, state: 'ready' },
          timestamp: Date.now(),
        });
        return;
      }

      // 会话窗口网址导航与置顶
      const sessionNavMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/(?:open|navigate)$/);
      if (sessionNavMatch && method === 'POST') {
        const sessionId = decodeURIComponent(sessionNavMatch[1]!);
        const body = await this.readJsonBody(req);
        if (!body.url) {
          this.sendJson(res, 400, { success: false, code: 'INVALID_INPUT', message: 'url is required', timestamp: Date.now() });
          return;
        }
        const openResult = await this.manager.open(sessionId, body.url, { waitUntil: 'domcontentloaded', timeoutMs: 15000 });
        this.sendJson(res, 200, { success: true, code: 'OK', data: openResult, timestamp: Date.now() });
        return;
      }

      // 会话实时画面获取（Live View / Screencast Snapshot）
      const sessionLiveViewMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/live-view$/);
      if (sessionLiveViewMatch && method === 'GET') {
        const sessionId = decodeURIComponent(sessionLiveViewMatch[1]!);
        try {
          const status = this.manager.status(sessionId);
          const shot = await this.manager.screenshot(sessionId);
          this.sendJson(res, 200, {
            success: true,
            code: 'OK',
            data: {
              sessionId,
              state: status.state,
              url: status.url,
              image: shot.image.data,
              timestamp: Date.now(),
            },
            timestamp: Date.now(),
          });
        } catch (err) {
          this.sendJson(res, 500, {
            success: false,
            code: 'SCREENSHOT_FAILED',
            message: err instanceof Error ? err.message : String(err),
            timestamp: Date.now(),
          });
        }
        return;
      }

      // 会话直接交互（Direct Interaction Takeover: Mouse / Keyboard / Scroll）
      const sessionInteractMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/interact$/);
      if (sessionInteractMatch && method === 'POST') {
        const sessionId = decodeURIComponent(sessionInteractMatch[1]!);
        const body = await this.readJsonBody(req);
        const actionType = body.type || 'mouse';
        try {
          let result: unknown;
          if (actionType === 'mouse') {
            result = await this.manager.dispatchDirectMouse(
              sessionId,
              body.action || 'click',
              Number(body.x) || 0,
              Number(body.y) || 0,
              { button: body.button || 'left', clickCount: body.clickCount || 1 },
            );
          } else if (actionType === 'keyboard') {
            result = await this.manager.dispatchDirectKeyboard(
              sessionId,
              body.action || 'type',
              String(body.text || body.key || ''),
            );
          } else if (actionType === 'scroll') {
            result = await this.manager.dispatchDirectScroll(
              sessionId,
              Number(body.deltaX) || 0,
              Number(body.deltaY) || 0,
            );
          } else {
            this.sendJson(res, 400, { success: false, code: 'INVALID_ACTION_TYPE', message: 'Supported types: mouse, keyboard, scroll', timestamp: Date.now() });
            return;
          }
          this.sendJson(res, 200, { success: true, code: 'OK', data: result, timestamp: Date.now() });
        } catch (err) {
          this.sendJson(res, 500, { success: false, code: 'INTERACTION_FAILED', message: err instanceof Error ? err.message : String(err), timestamp: Date.now() });
        }
        return;
      }

      // 挑战接管完成并恢复会话（Resume Session）
      const sessionResumeMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/resume$/);
      if (sessionResumeMatch && method === 'POST') {
        const sessionId = decodeURIComponent(sessionResumeMatch[1]!);
        const body = await this.readJsonBody(req);
        try {
          const status = await this.manager.resume(sessionId, Boolean(body.humanConfirmed ?? true));
          this.sendJson(res, 200, { success: true, code: 'OK', data: status, timestamp: Date.now() });
        } catch (err) {
          this.sendJson(res, 400, { success: false, code: 'RESUME_FAILED', message: err instanceof Error ? err.message : String(err), timestamp: Date.now() });
        }
        return;
      }

      const profileStopMatch = pathname.match(/^\/api\/v1\/profiles\/([^/]+)\/stop$/);
      if (profileStopMatch && method === 'POST') {
        const profileId = decodeURIComponent(profileStopMatch[1]!);
        const sessionId = this.profileSessionMap.get(profileId);
        if (sessionId) {
          try {
            await this.manager.stop(sessionId, 'user_requested');
          } catch {
            // ignore
          }
          this.profileSessionMap.delete(profileId);
        }
        this.sendJson(res, 200, {
          success: true,
          code: 'OK',
          data: { stopped: true, profileId },
          timestamp: Date.now(),
        });
        return;
      }

      const profileCookiesMatch = pathname.match(/^\/api\/v1\/profiles\/([^/]+)\/cookies$/);
      if (profileCookiesMatch) {
        const profileId = decodeURIComponent(profileCookiesMatch[1]!);
        if (method === 'GET') {
          const format = parsedUrl.searchParams.get('format') === 'netscape' ? 'netscape' : 'json';
          const exported = await this.manager.exportCookies(profileId, format);
          this.sendJson(res, 200, {
            success: true,
            code: 'OK',
            data: format === 'json' ? JSON.parse(exported) : exported,
            timestamp: Date.now(),
          });
          return;
        }

        if (method === 'POST') {
          const body = await this.readJsonBody(req);
          if (body.cookies) {
            await this.manager.importCookies(profileId, body.cookies, body.format || 'json');
            this.sendJson(res, 200, { success: true, code: 'OK', data: { updated: true }, timestamp: Date.now() });
            return;
          }
        }
      }

      const profileMatch = pathname.match(/^\/api\/v1\/profiles\/([^/]+)$/);
      if (profileMatch && profileMatch[1]) {
        const profileId = decodeURIComponent(profileMatch[1]);
        if (method === 'GET') {
          const profile = await this.manager.getProfile(profileId);
          if (!profile) {
            this.sendJson(res, 404, {
              success: false,
              code: 'PROFILE_NOT_FOUND',
              message: `Profile ${profileId} not found`,
              timestamp: Date.now(),
            });
            return;
          }
          this.sendJson(res, 200, {
            success: true,
            code: 'OK',
            data: publicProfile(profile),
            timestamp: Date.now(),
          });
          return;
        }

        if (method === 'PUT') {
          const body = await this.readJsonBody(req);
          const existing = await this.manager.getProfile(profileId);
          if (body.extensionIds !== undefined || body.engine !== undefined) await this.validateExtensionIds(body.extensionIds ?? existing?.extensionIds ?? [], body.engine ?? existing?.engine ?? 'firefox', identity!);
          const updated = await this.manager.updateProfile(profileId, body);
          this.sendJson(res, 200, { success: true, code: 'OK', data: publicProfile(updated), timestamp: Date.now() });
          return;
        }

        if (method === 'DELETE') {
          // 停止可能的活动会话
          const activeSession = this.profileSessionMap.get(profileId);
          if (activeSession) {
            try { await this.manager.stop(activeSession, 'profile_deleted'); } catch { /* ignore */ }
            this.profileSessionMap.delete(profileId);
          }
          const deleted = await this.manager.deleteProfile(profileId);
          this.sendJson(res, 200, {
            success: true,
            code: 'OK',
            data: { deleted },
            timestamp: Date.now(),
          });
          return;
        }
      }

      const profileCloneMatch = pathname.match(/^\/api\/v1\/profiles\/([^/]+)\/clone$/);
      if (profileCloneMatch && method === 'POST') {
        const sourceId = decodeURIComponent(profileCloneMatch[1]!);
        const source = await this.manager.getProfile(sourceId);
        if (!source) {
          this.sendJson(res, 404, { success: false, code: 'PROFILE_NOT_FOUND', message: 'Source profile was not found', timestamp: Date.now() });
          return;
        }
        const body = await this.readJsonBody(req);
        await this.validateExtensionIds(source.extensionIds ?? [], source.engine ?? 'firefox', identity!);
        const cookies = body.includeCookies === false ? [] : await this.manager.getStore().getCookies(sourceId);
        const created = await this.manager.createProfile({
          name: body.name?.trim() || `${source.name} - Copy`,
          ...(source.description !== undefined ? { description: source.description } : {}),
          ...(source.tags !== undefined ? { tags: source.tags } : {}),
          ...(source.proxy !== undefined ? { proxy: source.proxy } : {}),
          ...(source.proxyId !== undefined ? { proxyId: source.proxyId } : {}),
          ...(source.extensionIds !== undefined ? { extensionIds: source.extensionIds } : {}),
          ...(source.geo !== undefined ? { geo: source.geo } : {}),
          engine: source.engine ?? 'firefox',
          ...(source.userAgent !== undefined ? { userAgent: source.userAgent } : {}),
          ...(source.customHeaders !== undefined ? { customHeaders: source.customHeaders } : {}),
          ...(source.twoFactorSecret !== undefined ? { twoFactorSecret: source.twoFactorSecret } : {}),
          ...(source.fingerprint !== undefined ? {
            fingerprint: { ...source.fingerprint, seed: ((Date.now() ^ Math.floor(Math.random() * 0xffff_ffff)) >>> 0) || 1 },
          } : {}),
          ...(cookies.length ? { initialCookies: cookies } : {}),
        });
        this.sendJson(res, 201, { success: true, code: 'CREATED', data: publicProfile(created), timestamp: Date.now() });
        return;
      }

      if (pathname === '/api/v1/profiles/batch' && method === 'POST') {
        const body = await this.readJsonBody(req);
        const ids = Array.isArray(body.profileIds) ? [...new Set(body.profileIds.filter((id: unknown) => typeof id === 'string'))].slice(0, 100) : [];
        if (!ids.length || !['start', 'stop', 'delete'].includes(body.action)) {
          this.sendJson(res, 400, { success: false, code: 'INVALID_INPUT', message: 'profileIds and a supported action are required', timestamp: Date.now() });
          return;
        }
        const results: Array<{ profileId: string; success: boolean; sessionId?: string; code?: unknown }> = [];
        for (const id of ids) {
          try {
            if (!this.canAccessResource(identity!, 'profile', id)) {
              results.push({ profileId: id, success: false, code: 'RESOURCE_ACCESS_DENIED' });
              continue;
            }
            if (body.action === 'delete') results.push({ profileId: id, success: await this.manager.deleteProfile(id) });
            else if (body.action === 'start') {
              const session = await this.manager.start({ profileId: id, headless: body.headless ?? false, fingerprint: true });
              this.profileSessionMap.set(id, session.sessionId);
              results.push({ profileId: id, success: true, sessionId: session.sessionId });
            } else {
              const sessionId = this.profileSessionMap.get(id);
              if (sessionId) await this.manager.stop(sessionId, 'batch_stop');
              this.profileSessionMap.delete(id);
              results.push({ profileId: id, success: true });
            }
          } catch (error) {
            results.push({ profileId: id, success: false, code: typeof error === 'object' && error && 'code' in error ? error.code : 'FAILED' });
          }
        }
        this.sendJson(res, 200, { success: true, code: 'OK', data: results, timestamp: Date.now() });
        return;
      }

      // Persistent proxy pool
      if (pathname === '/api/v1/proxies' && method === 'GET' && this.options.proxyPool) {
        const proxies = await this.options.proxyPool.list();
        this.sendJson(res, 200, { success: true, code: 'OK', data: proxies.map(publicProxy), timestamp: Date.now() });
        return;
      }
      if (pathname === '/api/v1/proxies' && method === 'POST' && this.options.proxyPool) {
        const created = await this.options.proxyPool.create(await this.readJsonBody(req) as any);
        this.sendJson(res, 201, { success: true, code: 'CREATED', data: publicProxy(created), timestamp: Date.now() });
        return;
      }
      const proxyPoolMatch = pathname.match(/^\/api\/v1\/proxies\/([^/]+)$/);
      if (proxyPoolMatch && this.options.proxyPool) {
        const proxyId = decodeURIComponent(proxyPoolMatch[1]!);
        if (method === 'PUT') {
          const updated = await this.options.proxyPool.update(proxyId, await this.readJsonBody(req) as any);
          this.sendJson(res, 200, { success: true, code: 'OK', data: publicProxy(updated), timestamp: Date.now() });
          return;
        }
        if (method === 'DELETE') {
          this.sendJson(res, 200, { success: true, code: 'OK', data: { deleted: await this.options.proxyPool.delete(proxyId) }, timestamp: Date.now() });
          return;
        }
      }
      const proxyCheckMatch = pathname.match(/^\/api\/v1\/proxies\/([^/]+)\/check$/);
      if (proxyCheckMatch && method === 'POST' && this.options.proxyPool) {
        const checked = await this.options.proxyPool.check(decodeURIComponent(proxyCheckMatch[1]!));
        this.sendJson(res, 200, { success: true, code: 'OK', data: publicProxy(checked), timestamp: Date.now() });
        return;
      }
      const rotateProxyMatch = pathname.match(/^\/api\/v1\/profiles\/([^/]+)\/rotate-proxy$/);
      if (rotateProxyMatch && method === 'POST' && this.options.proxyPool) {
        const body = await this.readJsonBody(req);
        const selected = await this.options.proxyPool.next(Array.isArray(body.tags) ? body.tags : []);
        if (!selected) {
          this.sendJson(res, 409, { success: false, code: 'NO_PROXY_AVAILABLE', message: 'No healthy enabled proxy matched', timestamp: Date.now() });
          return;
        }
        const updated = await this.manager.updateProfile(decodeURIComponent(rotateProxyMatch[1]!), {
          proxyId: selected.proxyId,
          proxy: selected,
        });
        this.sendJson(res, 200, { success: true, code: 'OK', data: { profile: publicProfile(updated), proxy: publicProxy(selected) }, timestamp: Date.now() });
        return;
      }

      // Declarative RPA workflows, schedules and task logs
      if (pathname === '/api/v1/rpa/workflows' && method === 'GET' && this.options.rpa) {
        this.sendJson(res, 200, { success: true, code: 'OK', data: await this.options.rpa.listWorkflows(), timestamp: Date.now() });
        return;
      }
      if (pathname === '/api/v1/rpa/workflows' && method === 'POST' && this.options.rpa) {
        const created = await this.options.rpa.createWorkflow(await this.readJsonBody(req) as any);
        this.sendJson(res, 201, { success: true, code: 'CREATED', data: created, timestamp: Date.now() });
        return;
      }
      // Distributed crawl task workspace: enqueue, filter and inspect task runs.
      if (pathname === '/api/v1/cluster/tasks' && method === 'GET') {
        const projectId = parsedUrl.searchParams.get('projectId')?.trim() || undefined;
        const runId = parsedUrl.searchParams.get('runId')?.trim() || undefined;
        const stateValue = parsedUrl.searchParams.get('state')?.trim() || undefined;
        const modeValue = parsedUrl.searchParams.get('mode')?.trim() || undefined;
        const priorityValue = parsedUrl.searchParams.get('priority')?.trim() || undefined;
        const states = ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'RETRYING', 'CANCELLED'] as const;
        if (stateValue && !states.includes(stateValue as TaskState)) {
          this.sendJson(res, 400, { success: false, code: 'INVALID_INPUT', message: 'state is invalid', timestamp: Date.now() });
          return;
        }
        if (modeValue && modeValue !== 'fetch' && modeValue !== 'browser') {
          this.sendJson(res, 400, { success: false, code: 'INVALID_INPUT', message: 'mode is invalid', timestamp: Date.now() });
          return;
        }
        if (priorityValue && !['LOW', 'NORMAL', 'HIGH', 'CRITICAL'].includes(priorityValue)) {
          this.sendJson(res, 400, { success: false, code: 'INVALID_INPUT', message: 'priority is invalid', timestamp: Date.now() });
          return;
        }
        const limit = boundedQueryInteger(parsedUrl.searchParams.get('limit'), 1, 100, 100);
        const offset = boundedQueryInteger(parsedUrl.searchParams.get('offset'), 0, 100_000, 0);
        const createdAfter = optionalQueryTimestamp(parsedUrl.searchParams.get('createdAfter'));
        const createdBefore = optionalQueryTimestamp(parsedUrl.searchParams.get('createdBefore'));
        const rawTasks = await this.manager.listClusterTasks({
          ...(projectId ? { projectId } : {}),
          ...(runId ? { runId } : {}),
          ...(stateValue ? { state: stateValue as TaskState } : {}),
          ...(modeValue ? { mode: modeValue as TaskExecutionMode } : {}),
          ...(priorityValue ? { priority: priorityValue as TaskPriority } : {}),
          ...(createdAfter !== undefined ? { createdAfter } : {}),
          ...(createdBefore !== undefined ? { createdBefore } : {}),
        }, Math.min(500, offset + limit + 1));
        const tasks = rawTasks.slice(offset, offset + limit).map(publicTask);
        res.setHeader('X-Offset', String(offset));
        res.setHeader('X-Limit', String(limit));
        res.setHeader('X-Has-More', String(rawTasks.length > offset + limit));
        this.sendJson(res, 200, { success: true, code: 'OK', data: tasks, timestamp: Date.now() });
        return;
      }
      if (pathname === '/api/v1/cluster/tasks/preflight' && method === 'POST') {
        const body = await this.readJsonBody(req);
        if (typeof body.url !== 'string' || !body.url.trim()) {
          this.sendJson(res, 400, { success: false, code: 'INVALID_INPUT', message: 'A URL is required', timestamp: Date.now() });
          return;
        }
        this.sendJson(res, 200, { success: true, code: 'OK', data: await this.manager.preflightClusterTaskUrl(body.url.trim()), timestamp: Date.now() });
        return;
      }
      if (pathname === '/api/v1/cluster/tasks/actions' && method === 'POST') {
        const body = await this.readJsonBody(req);
        const ids = Array.isArray(body.ids) ? [...new Set(body.ids.filter((id: unknown): id is string => typeof id === 'string'))] : [];
        if (ids.length < 1 || ids.length > 100 || (body.action !== 'cancel' && body.action !== 'retry')) {
          this.sendJson(res, 400, { success: false, code: 'INVALID_INPUT', message: 'ids and action are required', timestamp: Date.now() });
          return;
        }
        const results = await Promise.all(ids.map(async (id) => {
          try {
            const task = body.action === 'cancel'
              ? await this.manager.cancelClusterTask(id)
              : await this.manager.retryClusterTask(id);
            return { id, success: true, task: publicTask(task) };
          } catch (error: unknown) {
            return { id, success: false, code: error instanceof Error ? error.message : 'TASK_ACTION_FAILED' };
          }
        }));
        this.sendJson(res, 200, { success: true, code: 'OK', data: results, timestamp: Date.now() });
        return;
      }
      if (pathname === '/api/v1/cluster/tasks' && method === 'POST') {
        const body = await this.readJsonBody(req);
        if (typeof body.url !== 'string' || !/^https?:\/\//i.test(body.url)) {
          this.sendJson(res, 400, { success: false, code: 'INVALID_INPUT', message: 'A http(s) url is required', timestamp: Date.now() });
          return;
        }
        const mode = body.mode === undefined ? undefined : body.mode;
        const priority = body.priority === undefined ? undefined : body.priority;
        if (mode !== undefined && mode !== 'fetch' && mode !== 'browser') {
          this.sendJson(res, 400, { success: false, code: 'INVALID_INPUT', message: 'mode is invalid', timestamp: Date.now() });
          return;
        }
        if (priority !== undefined && !['LOW', 'NORMAL', 'HIGH', 'CRITICAL'].includes(priority)) {
          this.sendJson(res, 400, { success: false, code: 'INVALID_INPUT', message: 'priority is invalid', timestamp: Date.now() });
          return;
        }
        const definition: DistributedTaskDefinition = {
          url: body.url,
          ...(typeof body.projectId === 'string' ? { projectId: body.projectId } : {}),
          ...(typeof body.runId === 'string' ? { runId: body.runId } : {}),
          ...(mode !== undefined ? { mode: mode as TaskExecutionMode } : {}),
          ...(priority !== undefined ? { priority: priority as TaskPriority } : {}),
          ...(typeof body.maxRetries === 'number' ? { maxRetries: body.maxRetries } : {}),
          ...(typeof body.timeoutMs === 'number' ? { timeoutMs: body.timeoutMs } : {}),
        };
        const task = await this.manager.submitClusterTask(definition);
        this.sendJson(res, 202, { success: true, code: 'ACCEPTED', data: publicTask(task), timestamp: Date.now() });
        return;
      }
      const clusterTaskMatch = pathname.match(/^\/api\/v1\/cluster\/tasks\/([^/]+)$/);
      if (clusterTaskMatch && method === 'GET') {
        const task = await this.manager.getClusterTask(decodeURIComponent(clusterTaskMatch[1]!));
        this.sendJson(res, task ? 200 : 404, {
          success: Boolean(task),
          code: task ? 'OK' : 'TASK_NOT_FOUND',
          ...(task ? { data: publicTask(task) } : { message: 'Task was not found' }),
          timestamp: Date.now(),
        });
        return;
      }
      if (pathname === '/api/v1/cluster/status' && method === 'GET') {
        this.sendJson(res, 200, { success: true, code: 'OK', data: await this.manager.getClusterStatus(), timestamp: Date.now() });
        return;
      }
      const rpaWorkflowMatch = pathname.match(/^\/api\/v1\/rpa\/workflows\/([^/]+)$/);
      if (rpaWorkflowMatch && this.options.rpa) {
        const workflowId = decodeURIComponent(rpaWorkflowMatch[1]!);
        if (method === 'PUT') {
          this.sendJson(res, 200, { success: true, code: 'OK', data: await this.options.rpa.updateWorkflow(workflowId, await this.readJsonBody(req) as any), timestamp: Date.now() });
          return;
        }
        if (method === 'DELETE') {
          this.sendJson(res, 200, { success: true, code: 'OK', data: { deleted: await this.options.rpa.deleteWorkflow(workflowId) }, timestamp: Date.now() });
          return;
        }
      }
      if (pathname === '/api/v1/rpa/tasks' && method === 'GET' && this.options.rpa) {
        this.sendJson(res, 200, { success: true, code: 'OK', data: await this.options.rpa.listTasks(), timestamp: Date.now() });
        return;
      }
      if (pathname === '/api/v1/rpa/tasks' && method === 'POST' && this.options.rpa) {
        const task = await this.options.rpa.run(await this.readJsonBody(req) as any);
        this.sendJson(res, 202, { success: true, code: 'ACCEPTED', data: task, timestamp: Date.now() });
        return;
      }
      const rpaTaskMatch = pathname.match(/^\/api\/v1\/rpa\/tasks\/([^/]+)$/);
      if (rpaTaskMatch && method === 'GET' && this.options.rpa) {
        const task = await this.options.rpa.getTask(decodeURIComponent(rpaTaskMatch[1]!));
        this.sendJson(res, task ? 200 : 404, { success: Boolean(task), code: task ? 'OK' : 'TASK_NOT_FOUND', ...(task ? { data: task } : { message: 'Task was not found' }), timestamp: Date.now() });
        return;
      }
      const rpaCancelMatch = pathname.match(/^\/api\/v1\/rpa\/tasks\/([^/]+)\/cancel$/);
      if (rpaCancelMatch && method === 'POST' && this.options.rpa) {
        const task = await this.options.rpa.cancel(decodeURIComponent(rpaCancelMatch[1]!));
        this.sendJson(res, 200, { success: true, code: 'OK', data: task, timestamp: Date.now() });
        return;
      }

      // 4. Tasks & Automation (Scraper with Smart Warmup & Resilience)
      if (pathname === '/api/v1/tasks/scrape' && method === 'POST') {
        const body = await this.readJsonBody(req);
        if (!body.url) {
          this.sendJson(res, 400, { success: false, code: 'INVALID_INPUT', message: 'url is required', timestamp: Date.now() });
          return;
        }

        const startTs = Date.now();
        const session = await this.manager.start({
          headless: true,
          fingerprint: true,
          countryCode: 'CN',
          locale: 'zh-CN',
          timezone: 'Asia/Shanghai',
        });

        try {
          // 优化导航超时与容错
          let navResult: { url?: string; title?: string } = {};
          try {
            navResult = await this.manager.open(session.sessionId, body.url, {
              waitUntil: 'domcontentloaded',
              timeoutMs: 30000,
            });
          } catch (navErr: any) {
            // 若遇慢速资源超时，尝试降级读取当前已渲染的 DOM
            console.warn(`Navigation warning for ${body.url}: ${navErr.message}`);
          }

          // 智能预热等待（为前端 JS 签名计算与 Token 交换预留 2.5 秒）
          await new Promise((r) => setTimeout(r, 2500));

          const snapshot = await this.manager.snapshot(session.sessionId, { includeText: true, maxNodes: 80 });
          const elapsedMs = Date.now() - startTs;

          await this.manager.stop(session.sessionId, 'scrape_done');

          const rawText = snapshot.text || '';
          const cleanSnippet = rawText.replace(/\s+/g, ' ').trim().slice(0, 400);

          this.sendJson(res, 200, {
            success: true,
            code: 'OK',
            data: {
              url: navResult.url || body.url,
              title: navResult.title || '已提取页面内容',
              nodesCount: snapshot.targets?.length || 0,
              snippet: cleanSnippet || '(已成功抓取 DOM，内容受动态图表渲染)',
              elapsedMs,
            },
            timestamp: Date.now(),
          });
          return;
        } catch (err: any) {
          await this.manager.stop(session.sessionId, 'scrape_error').catch(() => {});
          throw err;
        }
      }

      // 5. AI Intelligent Analysis (DeepSeek / Qwen / Doubao)
      if (pathname === '/api/v1/ai/analyze' && method === 'POST') {
        const body = await this.readJsonBody(req);
        const { provider = 'deepseek', model, apiKey, prompt, content } = body;

        if (!content || !prompt) {
          this.sendJson(res, 400, {
            success: false,
            code: 'INVALID_INPUT',
            message: 'prompt and content are required',
            timestamp: Date.now(),
          });
          return;
        }
        if (!['deepseek', 'qwen', 'doubao'].includes(provider)) {
          this.sendJson(res, 400, { success: false, code: 'INVALID_INPUT', message: 'provider must be deepseek, qwen, or doubao', timestamp: Date.now() });
          return;
        }

        // 预设国内三大主流大模型服务端点
        let endpoint = 'https://api.deepseek.com/chat/completions';
        let defaultModel = 'deepseek-chat';

        if (provider === 'qwen') {
          endpoint = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
          defaultModel = 'qwen-plus';
        } else if (provider === 'doubao') {
          endpoint = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
          defaultModel = 'doubao-pro-32k';
        } else if (provider === 'deepseek') {
          endpoint = 'https://api.deepseek.com/chat/completions';
          defaultModel = model === 'r1' ? 'deepseek-reasoner' : 'deepseek-chat';
        }

        const configuredProviderKey = provider === 'qwen'
          ? process.env.DASHSCOPE_API_KEY
          : provider === 'doubao'
            ? process.env.ARK_API_KEY
            : process.env.DEEPSEEK_API_KEY;
        const effectiveKey = apiKey || configuredProviderKey;

        if (!effectiveKey) {
          this.sendJson(res, 400, { success: false, code: 'API_KEY_REQUIRED', message: 'Configure a provider API key; demo responses are not fabricated', timestamp: Date.now() });
          return;
        }

        try {
          const aiResp = await fetch(endpoint, {
            method: 'POST',
            signal: AbortSignal.timeout(60_000),
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${effectiveKey}`,
            },
            body: JSON.stringify({
              model: model || defaultModel,
              messages: [
                { role: 'system', content: '你是一位资深的 A 股与全球资产配置首席量化投研专家，请根据提供的一手财经数据，进行深度逻辑拆解、题材受益链条梳理与严格的排雷风控分析。' },
                { role: 'user', content: `【投研任务】：${prompt}\n\n【第一手采集数据】：\n${content}` },
              ],
              temperature: 0.3,
            }),
          });

          const aiJson: any = await aiResp.json();
          const reply = aiJson?.choices?.[0]?.message?.content || aiJson?.error?.message || '模型未返回有效文本';

          this.sendJson(res, 200, {
            success: true,
            code: 'OK',
            data: {
              provider,
              model: model || defaultModel,
              analysis: reply,
            },
            timestamp: Date.now(),
          });
          return;
        } catch (aiErr: any) {
          this.sendJson(res, 500, {
            success: false,
            code: 'AI_CALL_FAILED',
            message: `调用 ${provider} 失败: ${aiErr.message}`,
            timestamp: Date.now(),
          });
          return;
        }
      }

      // 6. Local Browsers Scan & Migration (Chrome / Edge / Firefox)
      if (pathname === '/api/v1/migration/local-browsers' && method === 'GET') {
        const detected = await this.localBrowserImporter.scan();
        this.sendJson(res, 200, { success: true, code: 'OK', data: detected, timestamp: Date.now() });
        return;
      }

      if (pathname === '/api/v1/migration/import-local' && method === 'POST') {
        const body = await this.readJsonBody(req);
        if (typeof body.sourceId !== 'string') {
          this.sendJson(res, 400, { success: false, code: 'INVALID_INPUT', message: 'sourceId is required', timestamp: Date.now() });
          return;
        }
        const imported = await this.localBrowserImporter.importProfile({
          sourceId: body.sourceId,
          confirmBrowserClosed: body.confirmBrowserClosed === true,
        });
        this.sendJson(res, 200, { success: true, code: 'OK', data: imported, timestamp: Date.now() });
        return;
      }

      // 7. Proxy check
      if (pathname === '/api/v1/proxy/check' && method === 'POST') {
        const body = await this.readJsonBody(req);
        if (!body.proxy) {
          this.sendJson(res, 400, {
            success: false,
            code: 'INVALID_INPUT',
            message: 'proxy configuration is required',
            timestamp: Date.now(),
          });
          return;
        }
        const result = await this.manager.checkProxy(body.proxy);
        this.sendJson(res, 200, {
          success: true,
          code: 'OK',
          data: result,
          timestamp: Date.now(),
        });
        return;
      }

      // 9. 2FA (TOTP) 谷歌身份验证器动态计算
      if (pathname === '/api/v1/2fa/generate' && method === 'GET') {
        const profileId = parsedUrl.searchParams.get('profileId') || '';
        if (!profileId) {
          this.sendJson(res, 400, { success: false, code: 'INVALID_INPUT', message: 'profileId parameter is required', timestamp: Date.now() });
          return;
        }
        const profile = await this.manager.getProfile(profileId);
        if (!profile) {
          this.sendJson(res, 404, { success: false, code: 'PROFILE_NOT_FOUND', message: 'Profile was not found', timestamp: Date.now() });
          return;
        }
        if (!profile.twoFactorSecret) {
          this.sendJson(res, 409, { success: false, code: 'TWO_FACTOR_NOT_CONFIGURED', message: 'This profile has no 2FA secret', timestamp: Date.now() });
          return;
        }
        const totp = generateTotp(profile.twoFactorSecret);
        this.sendJson(res, 200, {
          success: true,
          code: 'OK',
          data: totp,
          timestamp: Date.now(),
        });
        return;
      }

      // 10. CSV 批量导入环境
      if (pathname === '/api/v1/profiles/batch-import-csv' && method === 'POST') {
        const body = await this.readJsonBody(req);
        const csvContent = body.csv || '';
        if (!csvContent.trim()) {
          this.sendJson(res, 400, { success: false, code: 'INVALID_INPUT', message: 'csv content is required', timestamp: Date.now() });
          return;
        }

        const lines = csvContent.split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean);
        const importedProfiles: any[] = [];
        let startIndex = 0;

        // 若第一行为表头则跳过
        if (lines[0]?.toLowerCase().includes('name') || lines[0]?.includes('环境名称')) {
          startIndex = 1;
        }

        for (let i = startIndex; i < lines.length; i++) {
          const cols = parseCsvLine(lines[i]!);
          if (cols.length === 0 || !cols[0]) continue;

          const name = cols[0];
          const tags = cols[1] ? cols[1].split(/[/|]/) : ['CSV导入'];
          const engine = cols[2] === 'chromium' || cols[2] === 'chrome' ? 'chromium' : 'firefox';
          const proxyType = cols[3] || 'direct';
          const proxyServer = cols[4] || '';
          const proxyUser = cols[5] || '';
          const proxyPass = cols[6] || '';
          const twoFactorSecret = cols[7] || '';
          const initialCookies = cols[8] || '';

          const created = await this.manager.createProfile({
            name,
            tags,
            engine,
            ...(proxyType !== 'direct' && proxyServer ? {
              proxy: {
                server: proxyServer.includes('://') ? proxyServer : `${proxyType}://${proxyServer}`,
                ...(proxyUser ? { username: proxyUser } : {}),
                ...(proxyPass ? { password: proxyPass } : {}),
              },
            } : {}),
            ...(initialCookies ? { initialCookies } : {}),
            ...(twoFactorSecret ? { twoFactorSecret } : {}),
          });

          importedProfiles.push(publicProfile(created));
        }

        this.sendJson(res, 200, {
          success: true,
          code: 'OK',
          data: {
            totalImported: importedProfiles.length,
            profiles: importedProfiles,
          },
          timestamp: Date.now(),
        });
        return;
      }

      // 11. CSV 批量导出环境
      if (pathname === '/api/v1/profiles/batch-export-csv' && method === 'GET') {
        const summaries = await this.manager.listProfiles();
        const profiles = (await Promise.all(summaries.map((profile) => this.manager.getProfile(profile.profileId))))
          .filter((profile): profile is NonNullable<typeof profile> => profile !== null);
        const header = '环境名称,分组标签,内核类型,代理类型,代理服务器,代理账号,代理密码,2FA秘钥,Cookie\n';
        const rows = profiles.map((p) => {
          const tags = (p.tags || []).join('/');
          const proxyServer = p.proxy?.server || '';
          const proxyType = proxyServer.match(/^([a-z0-9]+):\/\//i)?.[1] || (proxyServer ? 'http' : 'direct');
          return [p.name, tags, p.engine || 'firefox', proxyType, proxyServer, '', '', '', ''].map(csvCell).join(',');
        }).join('\n');

        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="profiles_export.csv"');
        res.end('\uFEFF' + header + rows); // UTF-8 BOM
        return;
      }

      // 12. 多窗口主从群控同步广播
      if (pathname === '/api/v1/synchronizer/captures' && method === 'GET') {
        this.sendJson(res, 200, { success: true, code: 'OK', data: this.synchronizer.listCaptures(), timestamp: Date.now() }); return;
      }
      if (pathname === '/api/v1/synchronizer/captures' && method === 'POST') {
        const body = await this.readJsonBody(req);
        const capture = await this.synchronizer.startCapture(body.masterSessionId, Array.isArray(body.targetSessionIds) ? body.targetSessionIds : [], { jitterMs: body.jitterMs });
        this.sendJson(res, 201, { success: true, code: 'CREATED', data: capture, timestamp: Date.now() }); return;
      }
      const captureMatch = pathname.match(/^\/api\/v1\/synchronizer\/captures\/([^/]+)$/);
      if (captureMatch && method === 'DELETE') { this.sendJson(res, 200, { success: true, code: 'OK', data: { stopped: this.synchronizer.stopCapture(decodeURIComponent(captureMatch[1]!)) }, timestamp: Date.now() }); return; }

      if (pathname === '/api/v1/synchronizer/broadcast' && method === 'POST') {
        const body = await this.readJsonBody(req);
        const { targetSessionIds = [], action, jitterMs = 40 } = body;
        if (!Array.isArray(targetSessionIds) || targetSessionIds.length === 0 || !action) {
          this.sendJson(res, 400, { success: false, code: 'INVALID_INPUT', message: 'targetSessionIds and action are required', timestamp: Date.now() });
        }

        const syncResults = await this.synchronizer.broadcast(targetSessionIds, action, { jitterMs });

        this.sendJson(res, 200, {
          success: true,
          code: 'OK',
          data: syncResults,
          timestamp: Date.now(),
        });
        return;
      }

      // 13. 多窗口九宫格布局网格计算
      if (pathname === '/api/v1/synchronizer/tile-layout' && method === 'POST') {
        const body = await this.readJsonBody(req);
        const { windowCount = 4, screenWidth = 1920, screenHeight = 1080 } = body;
        const layout = this.synchronizer.calculateGridLayout(windowCount, screenWidth, screenHeight);

        this.sendJson(res, 200, {
          success: true,
          code: 'OK',
          data: layout,
          timestamp: Date.now(),
        });
        return;
      }

      // 14. Bridge 浏览器实时拉取与控制 (OpenCLI 模式 / 免关浏览器 / 免解密)
      if (pathname === '/api/v1/bridge/browsers' && method === 'GET') {
        const browsers = this.browserPool.list().filter((b) => b.mode === 'bridge');
        this.sendJson(res, 200, { success: true, code: 'OK', data: { items: browsers }, timestamp: Date.now() });
        return;
      }

      const bridgeTabsMatch = pathname.match(/^\/api\/v1\/bridge\/browsers\/([^/]+)\/tabs$/);
      if (bridgeTabsMatch && method === 'GET') {
        const tabs = await this.browserPool.pullTabs(bridgeTabsMatch[1]!);
        this.sendJson(res, 200, { success: true, code: 'OK', data: { browserId: bridgeTabsMatch[1]!, tabs }, timestamp: Date.now() });
        return;
      }

      const bridgeBindMatch = pathname.match(/^\/api\/v1\/bridge\/browsers\/([^/]+)\/tabs\/bind$/);
      if (bridgeBindMatch && method === 'POST') {
        const body = (await this.readJsonBody(req).catch(() => ({}))) as { tabId?: number };
        const result = typeof body.tabId === 'number'
          ? await this.browserPool.switchTab(bridgeBindMatch[1]!, body.tabId)
          : await this.browserPool.bindCurrentTab(bridgeBindMatch[1]!);
        this.sendJson(res, 200, { success: true, code: 'OK', data: result, timestamp: Date.now() });
        return;
      }

      const bridgeOpenMatch = pathname.match(/^\/api\/v1\/bridge\/browsers\/([^/]+)\/tabs\/open$/);
      if (bridgeOpenMatch && method === 'POST') {
        const body = await this.readJsonBody(req);
        const result = await this.browserPool.createTab(bridgeOpenMatch[1]!, body.url, body.active !== false);
        this.sendJson(res, 200, { success: true, code: 'OK', data: result, timestamp: Date.now() });
        return;
      }

      const bridgeCloseMatch = pathname.match(/^\/api\/v1\/bridge\/browsers\/([^/]+)\/tabs\/close$/);
      if (bridgeCloseMatch && method === 'POST') {
        const body = await this.readJsonBody(req);
        if (typeof body.tabId !== 'number') throw new Error('tabId is required');
        const result = await this.browserPool.closeTab(bridgeCloseMatch[1]!, body.tabId);
        this.sendJson(res, 200, { success: true, code: 'OK', data: result, timestamp: Date.now() });
        return;
      }

      const bridgeSnapshotMatch = pathname.match(/^\/api\/v1\/bridge\/browsers\/([^/]+)\/snapshot$/);
      if (bridgeSnapshotMatch && method === 'GET') {
        const result = await this.browserPool.bridgeCall(bridgeSnapshotMatch[1]!, { op: 'snapshot' });
        this.sendJson(res, 200, { success: true, code: 'OK', data: result, timestamp: Date.now() });
        return;
      }

      const bridgeCallMatch = pathname.match(/^\/api\/v1\/bridge\/browsers\/([^/]+)\/call$/);
      if (bridgeCallMatch && method === 'POST') {
        const body = await this.readJsonBody(req);
        const result = await this.browserPool.bridgeCall(bridgeCallMatch[1]!, body);
        this.sendJson(res, 200, { success: true, code: 'OK', data: result, timestamp: Date.now() });
        return;
      }

      // 404 Fallthrough
      this.sendJson(res, 404, {
        success: false,
        code: 'ROUTE_NOT_FOUND',
        message: `Endpoint ${method} ${pathname} not found`,
        timestamp: Date.now(),
      });
    } catch (err: unknown) {
      const error = err as { code?: string; message?: string; details?: unknown };
      const messageCode = error.message && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : undefined;
      const code = error.code || messageCode || 'INTERNAL_ERROR';
      let statusCode = 500;
      if (code === 'INVALID_INPUT' || code === 'INVALID_ARGUMENT' || code.endsWith('_REQUIRED') || code.endsWith('_INVALID')) statusCode = 400;
      else if (code === 'PAYLOAD_TOO_LARGE') statusCode = 413;
      else if (code === 'UNAUTHENTICATED' || code === 'PERMISSION_DENIED' || code.endsWith('_ACCESS_DENIED')) statusCode = 403;
      else if (code.endsWith('_NOT_FOUND')) statusCode = 404;
      else if (code === 'SESSION_BUSY' || code === 'ACTION_ID_CONFLICT' || code === 'TWO_FACTOR_NOT_CONFIGURED' || code === 'EXTENSION_INTEGRITY_FAILED') statusCode = 409;
      else if (['TASK_RUNNING', 'TASK_NOT_RETRYABLE', 'TASK_LEASE_LOST'].includes(code)) statusCode = 409;
      else if (code.startsWith('EXTENSION_') && code !== 'EXTENSION_STORE_UNAVAILABLE') statusCode = 400;
      else if (code === 'EXTENSION_STORE_UNAVAILABLE') statusCode = 503;

      this.sendJson(res, statusCode, {
        success: false,
        code,
        message: error.message || 'Internal Server Error',
        error: {
          code,
          message: error.message || 'Internal Server Error',
          details: error.details,
        },
        timestamp: Date.now(),
      });
    }
  }

  private async serveStatic(pathname: string, res: ServerResponse): Promise<boolean> {
    const safePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const resolvedPublicDir = resolve(this.publicDir);
    const filePath = resolve(resolvedPublicDir, safePath);

    // 严格路径沙箱检查，防止目录遍历攻击 (Path Traversal Arbitrary File Read)
    if (!filePath.startsWith(resolvedPublicDir) || !existsSync(filePath)) {
      return false;
    }

    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) return false;
      const content = await readFile(filePath);
      const ext = extname(filePath).toLowerCase();
      const contentTypes: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
      };
      res.statusCode = 200;
      res.setHeader('Content-Type', contentTypes[ext] || 'application/octet-stream');
      res.end(content);
      return true;
    } catch {
      return false;
    }
  }

  private sendJson(res: ServerResponse, status: number, data: ApiResponse): void {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(data, null, 2));
  }

  private authenticate(req: IncomingMessage): StudioIdentity | undefined {
    const credentials = this.options.credentials;
    if (!credentials?.length && !this.options.teamAccess) return { role: 'owner', label: 'local-legacy' };
    const authorization = req.headers.authorization;
    const bearer = typeof authorization === 'string' && authorization.startsWith('Bearer ')
      ? authorization.slice(7)
      : undefined;
    const cookieHeader = req.headers.cookie ?? '';
    const cookieToken = cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith('studio_token='))?.slice('studio_token='.length);
    const supplied = bearer ?? (cookieToken ? decodeURIComponent(cookieToken) : undefined);
    if (!supplied) return undefined;
    const match = credentials?.find((credential) => safeTokenEqual(credential.token, supplied));
    if (match) return { role: match.role, ...(match.label ? { label: match.label } : {}), ...(match.workspaceId ? { workspaceId: match.workspaceId } : {}), ...(match.grants ? { grants: match.grants } : {}) };
    return this.options.teamAccess?.authenticate(supplied);
  }

  private canAccessResource(identity: StudioIdentity, kind: 'profile' | 'proxy' | 'workflow' | 'extension', id: string): boolean {
    if (identity.role === 'owner') return true;
    if (identity.memberId && identity.workspaceId && identity.grants) return this.options.teamAccess?.canAccess(identity as TeamIdentity, kind, id) ?? false;
    const grants = identity.grants?.[kind];
    return !grants || grants.includes('*') || grants.includes(id);
  }

  private async readJsonBody(req: IncomingMessage, maximumBytes = 2 * 1024 * 1024): Promise<Record<string, any>> {
    return new Promise((resolvePromise, reject) => {
      const chunks: Buffer[] = []; let receivedBytes = 0; let tooLarge = false;
      req.on('data', (chunk) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        receivedBytes += bytes.byteLength;
        if (receivedBytes > maximumBytes) {
          chunks.length = 0; tooLarge = true;
          reject(Object.assign(new Error('Payload too large'), { code: 'PAYLOAD_TOO_LARGE' }));
          return;
        }
        if (!tooLarge) chunks.push(bytes);
      });
      req.on('end', () => {
        if (tooLarge) return;
        const body = Buffer.concat(chunks).toString('utf8');
        if (!body.trim()) {
          resolvePromise({});
          return;
        }
        try {
          resolvePromise(JSON.parse(body));
        } catch {
          reject(Object.assign(new Error('Invalid JSON body'), { code: 'INVALID_JSON' }));
        }
      });
      req.on('error', (err) => reject(err));
    });
  }

  private profileForSession(sessionId: string): string | undefined { return [...this.profileSessionMap.entries()].find(([, value]) => value === sessionId)?.[0]; }

  private async validateExtensionIds(value: unknown, engine: 'firefox' | 'chromium', identity?: StudioIdentity): Promise<void> {
    if (value === undefined) return;
    if (!Array.isArray(value) || value.length > 32 || value.some((id) => typeof id !== 'string')) throw new Error('EXTENSION_IDS_INVALID');
    if (value.length && !this.options.extensionStore) throw new Error('EXTENSION_STORE_UNAVAILABLE');
    const geckoIds = new Set<string>();
    for (const id of [...new Set(value)] as string[]) {
      if (identity && !this.canAccessResource(identity, 'extension', id)) throw new Error('EXTENSION_ACCESS_DENIED');
      const record = await this.options.extensionStore!.get(id);
      if (!record) throw new Error('EXTENSION_NOT_FOUND');
      if (!record.engines.includes(engine)) throw new Error('EXTENSION_ENGINE_UNSUPPORTED');
      if (engine === 'firefox' && record.geckoId) {
        if (geckoIds.has(record.geckoId)) throw new Error('EXTENSION_GECKO_ID_CONFLICT');
        geckoIds.add(record.geckoId);
      }
    }
  }

  private attachAutomationSocket(socket: WebSocket, sessionId: string): void {
    socket.send(JSON.stringify({ type: 'ready', sessionId, protocol: 'abs-rpc/1' }));
    let tail = Promise.resolve();
    let screencastTimer: NodeJS.Timeout | null = null;

    const stopScreencast = () => {
      if (screencastTimer) {
        clearInterval(screencastTimer);
        screencastTimer = null;
      }
    };

    socket.on('close', () => stopScreencast());

    socket.on('message', (bytes) => {
      tail = tail.then(async () => {
        let request: any;
        try { request = JSON.parse(bytes.toString()); } catch { socket.send(JSON.stringify({ success: false, code: 'INVALID_JSON' })); return; }
        const id = request.id ?? null;
        try {
          let data: unknown;
          if (request.op === 'status') data = this.manager.status(sessionId);
          else if (request.op === 'open') data = await this.manager.open(sessionId, request.url, request.options);
          else if (request.op === 'click') data = await this.manager.click(sessionId, request.target, request.options);
          else if (request.op === 'type') data = await this.manager.type(sessionId, request.target, request.text, request.options);
          else if (request.op === 'select') data = await this.manager.select(sessionId, request.target, request.choice, request.options);
          else if (request.op === 'scroll') data = await this.manager.scroll(sessionId, request.direction, request.amount);
          else if (request.op === 'snapshot') data = await this.manager.snapshot(sessionId, request.options);
          else if (request.op === 'screenshot') data = await this.manager.screenshot(sessionId, request.options);
          else if (request.op === 'interact_mouse') {
            data = await this.manager.dispatchDirectMouse(
              sessionId,
              request.action || 'click',
              Number(request.x) || 0,
              Number(request.y) || 0,
              request.options,
            );
          } else if (request.op === 'interact_keyboard') {
            data = await this.manager.dispatchDirectKeyboard(
              sessionId,
              request.action || 'type',
              String(request.text || request.key || ''),
            );
          } else if (request.op === 'interact_scroll') {
            data = await this.manager.dispatchDirectScroll(
              sessionId,
              Number(request.deltaX) || 0,
              Number(request.deltaY) || 0,
            );
          } else if (request.op === 'resume') {
            data = await this.manager.resume(sessionId, Boolean(request.humanConfirmed ?? true));
          } else if (request.op === 'start_screencast') {
            stopScreencast();
            const interval = Math.max(100, Math.min(2000, Number(request.intervalMs) || 250));
            let inFlight = false;
            screencastTimer = setInterval(async () => {
              if (inFlight || socket.readyState !== 1) return;
              inFlight = true;
              try {
                const shot = await this.manager.screenshot(sessionId);
                const stat = this.manager.status(sessionId);
                if (socket.readyState === 1) {
                  socket.send(JSON.stringify({
                    type: 'screencast_frame',
                    sessionId,
                    timestamp: Date.now(),
                    state: stat.state,
                    url: stat.url,
                    image: shot.image.data,
                  }));
                }
              } catch (_) {}
              finally { inFlight = false; }
            }, interval);
            data = { streaming: true, intervalMs: interval };
          } else if (request.op === 'stop_screencast') {
            stopScreencast();
            data = { streaming: false };
          } else {
            throw Object.assign(new Error('Unsupported WebSocket operation'), { code: 'OPERATION_UNSUPPORTED' });
          }
          socket.send(JSON.stringify({ id, success: true, data }));
        } catch (error) { socket.send(JSON.stringify({ id, success: false, code: typeof error === 'object' && error && 'code' in error ? String(error.code) : 'OPERATION_FAILED', message: error instanceof Error ? error.message : String(error) })); }
      }).catch(() => undefined);
    });
  }
}

function safeTokenEqual(expected: string, supplied: string): boolean {
  if (expected.length !== supplied.length) return false;
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) mismatch |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
  return mismatch === 0;
}

function roleAllows(actual: StudioRole, required: StudioRole): boolean {
  const rank: Record<StudioRole, number> = { viewer: 0, operator: 1, manager: 2, owner: 3 };
  return rank[actual] >= rank[required];
}

function requiredRole(method: string | undefined, pathname: string): StudioRole {
  if (pathname.startsWith('/api/v1/bridge/')) return method === 'GET' ? 'viewer' : 'operator';
  if (pathname.startsWith('/api/v1/team/') || pathname.startsWith('/api/v1/migration/') || pathname.includes('/purge') || pathname.includes('/extensions/import') || (pathname.startsWith('/api/v1/extensions/') && method === 'DELETE')) return 'owner';
  if (pathname.includes('/cookies') || pathname.includes('/2fa/') || method === 'DELETE') return 'owner';
  if (method === 'GET') return 'viewer';
  if (pathname.includes('/start') || pathname.includes('/stop') || pathname.includes('/navigate') || pathname.includes('/interact') || pathname.includes('/resume') || pathname.includes('/rpa/tasks') || pathname.includes('/external-runtimes/') || pathname === '/api/v1/cluster/tasks/actions') return 'operator';
  return 'manager';
}

function resourceFromPath(pathname: string): { kind: 'profile' | 'proxy' | 'workflow' | 'extension'; id: string } | undefined {
  const profile = pathname.match(/^\/api\/v1\/profiles\/(?!batch(?:\/|$)|trash(?:\/|$))([^/]+)/); if (profile) return { kind: 'profile', id: decodeURIComponent(profile[1]!) };
  const proxy = pathname.match(/^\/api\/v1\/proxies\/([^/]+)/); if (proxy) return { kind: 'proxy', id: decodeURIComponent(proxy[1]!) };
  const workflow = pathname.match(/^\/api\/v1\/rpa\/workflows\/([^/]+)/); if (workflow) return { kind: 'workflow', id: decodeURIComponent(workflow[1]!) };
  const extension = pathname.match(/^\/api\/v1\/extensions\/(?!import$)([^/]+)/); if (extension) return { kind: 'extension', id: decodeURIComponent(extension[1]!) };
  return undefined;
}

function boundedQueryInteger(raw: string | null, minimum: number, maximum: number, fallback: number): number { const value = Number(raw); return Number.isInteger(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback; }

function studioOpenApiDocument(host: string, port: number): Record<string, unknown> {
  const paths = ['/health', '/auth/me', '/profiles', '/profiles/batch', '/profiles/batch-import-csv', '/profiles/batch-export-csv', '/profiles/trash', '/profiles/{id}/extensions', '/extensions', '/extensions/import', '/extensions/{id}', '/migration/local-browsers', '/migration/import-local', '/proxies', '/rpa/workflows', '/rpa/tasks', '/sessions/{sessionId}/diagnostics', '/cluster/tasks', '/cluster/tasks/preflight', '/cluster/tasks/actions', '/cluster/tasks/{id}', '/cluster/status', '/external-runtimes/{provider}/create', '/external-runtimes/{provider}/{runtime}/stop', '/team/workspaces', '/team/members', '/synchronizer/broadcast', '/bridge/browsers', '/bridge/browsers/{id}/tabs'];
  return { openapi: '3.1.0', info: { title: 'Antigravity Browser Studio API', version: SERVER_VERSION }, servers: [{ url: `http://${host}:${port}/api/v1` }], security: [{ bearerAuth: [] }], paths: Object.fromEntries(paths.map((path) => [path, { get: { summary: path }, post: { summary: path } }])), components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } } };
}

function routeTemplate(pathname: string): string {
  return pathname
    .replace(/\/(?:prf|ses|pxy|rpa|tsk|ext)_[A-Za-z0-9_-]+/g, '/:id')
    .replace(/\/profiles\/[A-Za-z0-9_-]+/g, '/profiles/:id');
}

function publicProfile(profile: any): Record<string, unknown> {
  const result = { ...profile };
  if (result.proxy) result.proxy = { ...result.proxy, password: undefined, hasPassword: Boolean(result.proxy.password) };
  if (result.twoFactorSecret) {
    result.hasTwoFactorSecret = true;
    delete result.twoFactorSecret;
  }
  return result;
}

function publicProxy(proxy: any): Record<string, unknown> {
  const health = proxy.lastCheck ? (proxy.lastCheck.verified ? 'verified' : proxy.lastCheck.success ? 'reachable' : 'unhealthy') : 'unknown';
  return { ...proxy, password: undefined, hasPassword: Boolean(proxy.password), health };
}
function optionalQueryTimestamp(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (character === '"') {
      if (quoted && line[index + 1] === '"') { current += '"'; index += 1; }
      else quoted = !quoted;
    } else if (!quoted && (character === ',' || character === '，' || character === '\t')) {
      fields.push(current.trim()); current = '';
    } else current += character;
  }
  fields.push(current.trim());
  return fields;
}

function csvCell(value: unknown): string {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

function publicTask(task: DistributedTaskRecord): Record<string, unknown> {
  const { leaseId: _leaseId, ...safeTask } = task;
  return safeTask;
}
