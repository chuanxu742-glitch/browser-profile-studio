import { BrowserSession, BrowserSessionError } from './browser-session.js';
import type { BrowserSessionOptions, BrowserSessionStatus, BrowserTabStatus } from './browser-session.js';
import type { EnvironmentDiagnostics } from './environment-diagnostics.js';
import type { ChallengePolicy } from '../challenge/policy.js';
import { BrowserToolError } from '../domain.js';
import type { Workspace, WorkspaceRetention } from '../domain.js';
import { createWorkspaceId, cloneWorkspace, digestWorkspaceLease, normalizeWorkspaceName } from './workspace.js';
import { CONFIG_LIMITS } from '../config.js';
import type { SemanticTarget } from './semantic-snapshot.js';
import type { ExtractionSchema } from '../extractor/types.js';
import { fetchPage } from '../fetcher/http-client.js';
import type { FetchOptions, FetchResult, FetchUrlPolicy } from '../fetcher/types.js';
import { DistributedMasterScheduler } from '../distributed/scheduler.js';
import type { MasterSchedulerOptions } from '../distributed/scheduler.js';
import type { DistributedTaskDefinition, DistributedTaskRecord, ClusterStatus, TaskListFilter, TaskUrlPreflight } from '../distributed/types.js';
import { DEFAULT_TENANT_ID, normalizeTenantId } from '../distributed/tenant.js';
import { SERVER_VERSION, FORBIDDEN_CAPABILITIES } from '../capabilities.js';
import {
  DEFAULT_AUTOMATION_POLICY,
  getAutomationPolicy,
  type AutomationPolicy,
  type AutomationPolicyName,
} from './automation-policy.js';


import {
  ProfileStore,
  type ProfileMetadata,
  type ProfileCreateOptions,
  type ProfileSummary,
  type CookieRecord,
  type CookieFormat,
} from '../profile/index.js';
import { normalizeProxyConfig, checkProxy, type ProxyConfig, type ProxyCheckResult } from '../proxy/index.js';
import { alignGeoEnvironment, type GeoAlignmentOptions } from '../geoip/index.js';
import { generateFingerprint, managedBrowserIdentity, type FingerprintConfig, type UnifiedFingerprintProfile } from '../fingerprint/index.js';
import type { ManagedExtensionStore } from '../extension/managed-extension-store.js';

export interface SessionManagerOptions extends Omit<BrowserSessionOptions, 'sessionId' | 'automationPolicy'> {
  maxSessions?: number;
  /** Administrator-selected resource policy profile. */
  policyProfile?: AutomationPolicyName;
  /** Absolute wall-clock lifetime for each session; callers cannot exceed the server hard cap. */
  sessionTtlMs?: number;
  /** Workspace handoff lease lifetime. */
  handoffTtlMs?: number;
  /** Absolute retention lifetime for inactive retained workspaces. */
  workspaceTtlMs?: number;

  /** Whether the configured URL policy permits private-network access. */
  privateNetworkEnabled?: boolean;
  /** Injectable wall clock and timer primitives for deterministic lifecycle tests. */
  clock?: SessionManagerClock;
  sessionFactory?: (options: BrowserSessionOptions) => BrowserSession;
  profileStore?: ProfileStore;
  extensionStore?: ManagedExtensionStore;
  /**
   * Cluster control-plane configuration. Browser-only worker processes set
   * this to false so they do not create a second, unused queue connection.
   */
  cluster?: false | Pick<MasterSchedulerOptions, 'redisUrl' | 'redisMode' | 'redisClusterNodes' | 'redisShardCount'>;
}

export interface SessionManagerClock {
  now?: () => number;
  setTimeout?: (handler: () => void, timeoutMs: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export type SessionStartOptions = Pick<
  BrowserSessionOptions,
  'headless' | 'runtimeMode' | 'viewport' | 'profileName' | 'inputProfile' | 'seed' | 'engine' | 'cdpEndpoint'
> & {
  workspaceName?: string;
  workspaceRetention?: WorkspaceRetention;
  /** Authenticated tenant assigned by the MCP gateway. */
  tenantId?: string;
  /** ID of saved persistent profile */
  profileId?: string;
  /** Proxy configuration (HTTP/SOCKS5) */
  proxy?: ProxyConfig | string;
  /** GeoIP country code, e.g. "US", "CN", "JP" */
  countryCode?: string;
  /** Timezone override, e.g. "America/New_York" */
  timezone?: string;
  /** Locale override, e.g. "en-US" */
  locale?: string;
  /** Geolocation override */
  geolocation?: { latitude: number; longitude: number; accuracy?: number };
  /** Custom User-Agent */
  userAgent?: string;
  /** Fingerprint spoofing config or auto-generation boolean */
  fingerprint?: FingerprintConfig | boolean;
  /** Seed for deterministic fingerprint generation */
  fingerprintSeed?: number;
  /** Challenge pause & handling policy */
  challengePolicy?: ChallengePolicy;
};


export interface WorkspaceHandoffResult {
  workspace: Workspace;
  leaseId: string;
  expiresAt: number;
  status: BrowserSessionStatus;
}

export interface WorkspaceResumeResult {
  workspace: Workspace;
  status: BrowserSessionStatus;
}

export interface BrowserCapabilities {
  serverVersion: string;
  policy: AutomationPolicyName;
  limits: AutomationPolicy['limits'];
  supportedTools: readonly string[];
  maxConcurrentSessions: number;
  maxTabsPerSession: number;
  sessionDefaultTtlMs: number;
  workspaceDefaultTtlMs: number;
  privateNetworkEnabled: boolean;
  forbiddenCapabilities: readonly string[];
  managedBrowserVersions: Readonly<Record<'firefox' | 'chromium', string>>;
  serviceWorkerFingerprintInjectionByEngine: Readonly<Record<'firefox' | 'chromium', boolean>>;
}

export const DEFAULT_HANDOFF_TTL_MS = 5 * 60_000;
export const DEFAULT_AUTOMATION_POLICY_NAME = DEFAULT_AUTOMATION_POLICY;
export const DEFAULT_WORKSPACE_TTL_MS = getAutomationPolicy(DEFAULT_AUTOMATION_POLICY).limits.workspaceTtlMs;
export const MIN_WORKSPACE_TTL_MS = 60_000;
export const MAX_WORKSPACE_TTL_MS = 7 * 24 * 60 * 60_000;

export const DEFAULT_MAX_TABS_PER_SESSION = getAutomationPolicy(DEFAULT_AUTOMATION_POLICY).limits.maxTabs;

/**
 * Owns the small set of isolated BrowserSession instances exposed by the
 * service.  It never accepts a caller-owned profile path and always delegates
 * page actions to a session's serial queue.
 */
export class SessionManager {
  private readonly options: SessionManagerOptions;
  private readonly sessions = new Map<string, BrowserSession>();
  /** Prevent two live Firefox processes from opening the same persistent profile. */
  private readonly persistentProfileOwners = new Map<string, string>();
  private readonly workspaces = new Map<string, Workspace>();
  private readonly workspaceBySession = new Map<string, string>();
  /** Only a digest and expiry are retained; the raw handoff token stays with the caller. */
  private readonly workspaceLeases = new Map<string, { tokenDigest: string; expiresAt: number }>();
  private readonly closedStatuses = new Map<string, BrowserSessionStatus>();
  private readonly automationPolicy: AutomationPolicy;
  private readonly maxSessions: number;
  private readonly maxClosedStatuses: number;
  private readonly sessionTtlMs: number;
  private readonly handoffTtlMs: number;
  private readonly workspaceTtlMs: number;
  private readonly privateNetworkEnabled: boolean;
  private readonly now: () => number;
  private readonly scheduleTimer: (handler: () => void, timeoutMs: number) => unknown;
  private readonly cancelTimer: (handle: unknown) => void;
  private readonly expiryTimers = new Map<string, { handle: unknown; generation: number; expiresAt?: number }>();
  private readonly workspaceExpiryTimers = new Map<string, unknown>();
  private readonly expiredSessionIds = new Set<string>();
  private nextExpiryGeneration = 0;
  private readonly clusterScheduler?: DistributedMasterScheduler;
  private readonly profileStore: ProfileStore;
  private readonly extensionStore: ManagedExtensionStore | undefined;

  public constructor(options: SessionManagerOptions = {}) {
    this.options = options;
    this.automationPolicy = getAutomationPolicy(options.policyProfile ?? DEFAULT_AUTOMATION_POLICY);
    this.maxSessions = boundedInteger(options.maxSessions ?? 2, 1, 32, 2);
    this.maxClosedStatuses = Math.max(32, Math.min(512, this.maxSessions * 32));
    this.sessionTtlMs = boundedInteger(
      options.sessionTtlMs ?? this.automationPolicy.limits.sessionTtlMs,
      1_000,
      Math.min(CONFIG_LIMITS.sessionTtlMs.max, this.automationPolicy.limits.sessionTtlMs),
      this.automationPolicy.limits.sessionTtlMs,
    );
    this.handoffTtlMs = boundedInteger(options.handoffTtlMs ?? DEFAULT_HANDOFF_TTL_MS, 30_000, 3_600_000, DEFAULT_HANDOFF_TTL_MS);
    this.workspaceTtlMs = boundedInteger(
      options.workspaceTtlMs ?? this.automationPolicy.limits.workspaceTtlMs,
      MIN_WORKSPACE_TTL_MS,
      Math.min(MAX_WORKSPACE_TTL_MS, this.automationPolicy.limits.workspaceTtlMs),
      this.automationPolicy.limits.workspaceTtlMs,
    );
    this.privateNetworkEnabled = options.privateNetworkEnabled ?? false;
    this.now = options.clock?.now ?? (() => Date.now());
    this.scheduleTimer = options.clock?.setTimeout ?? ((handler, timeoutMs) => setTimeout(handler, timeoutMs));
    this.cancelTimer = options.clock?.clearTimeout ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    this.profileStore = options.profileStore ?? new ProfileStore(options.profileRoot ?? '.browser-data/profiles');
    this.extensionStore = options.extensionStore;
    if (options.cluster !== false) {
      this.clusterScheduler = new DistributedMasterScheduler({
        maxConcurrency: this.maxSessions,
        sessionManager: this,
        ...(options.urlPolicy?.assertAllowed ? { urlPolicy: options.urlPolicy as FetchUrlPolicy } : {}),
        startLocalWorker: false,
        ...(options.cluster ?? {}),
      });
    }
  }

  public get size(): number {
    return this.sessions.size;
  }

  public get sessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  public getStore(): ProfileStore {
    return this.profileStore;
  }

  /** Profile Management API */
  public async createProfile(options: ProfileCreateOptions): Promise<ProfileMetadata> {
    return this.profileStore.createProfile(options);
  }

  public async listProfiles(): Promise<ProfileSummary[]> {
    return this.profileStore.listProfiles();
  }

  public async getProfile(profileId: string): Promise<ProfileMetadata | null> {
    return this.profileStore.getProfile(profileId);
  }

  public async updateProfile(profileId: string, updates: Partial<ProfileMetadata>): Promise<ProfileMetadata> {
    return this.profileStore.updateProfile(profileId, updates);
  }

  public async deleteProfile(profileId: string): Promise<boolean> {
    return this.profileStore.deleteProfile(profileId);
  }

  public async listDeletedProfiles() { return this.profileStore.listDeletedProfiles(); }
  public async restoreProfile(profileId: string) { return this.profileStore.restoreProfile(profileId); }
  public async purgeDeletedProfile(profileId: string) { return this.profileStore.purgeDeletedProfile(profileId); }

  public async exportCookies(profileId: string, format: CookieFormat = 'json'): Promise<string> {
    return this.profileStore.exportCookies(profileId, format);
  }

  public async importCookies(profileId: string, raw: string | readonly CookieRecord[], format: CookieFormat = 'json'): Promise<number> {
    return this.profileStore.importCookies(profileId, raw, format);
  }

  public async checkProxy(config: ProxyConfig | string): Promise<ProxyCheckResult> {
    return checkProxy(config);
  }

  /** Create and launch one isolated persistent Firefox context and workspace. */
  public async start(options: SessionStartOptions = {}): Promise<BrowserSession> {
    if (this.sessions.size >= this.maxSessions) {
      throw new BrowserSessionError('RESOURCE_EXHAUSTED', 'Maximum concurrent browser sessions reached', { retryable: true });
    }
    const requestedWorkspaceName = normalizeWorkspaceName(options.workspaceName);
    const retention = options.workspaceRetention ?? 'destroy';
    const tenantId = normalizeTenantId(options.tenantId ?? DEFAULT_TENANT_ID);

    let effectiveProxy = options.proxy ?? this.options.proxy;
    let geoCountry = options.countryCode ?? this.options.countryCode;
    let geoTimezone = options.timezone ?? this.options.timezoneId;
    let geoLocale = options.locale ?? this.options.locale;
    let geoLoc = options.geolocation ?? this.options.geolocation;
    let effectiveEngine = options.engine ?? this.options.engine;
    let effectiveUserAgent = options.userAgent ?? this.options.userAgent;
    let effectiveFingerprint: FingerprintConfig | boolean | undefined = options.fingerprint ?? this.options.fingerprint;
    let effectiveFingerprintSeed = options.fingerprintSeed ?? this.options.fingerprintSeed;
    let initialCookies: CookieRecord[] | undefined;
    let managedExtensions: BrowserSessionOptions['managedExtensions'];
    let savedProfile: ProfileMetadata | undefined;
    if (options.profileId) {
      const profileMeta = await this.profileStore.getProfile(options.profileId);
      if (!profileMeta) {
        throw new BrowserSessionError('SESSION_NOT_FOUND', `Profile with ID "${options.profileId}" not found.`);
      }
      if (!effectiveProxy && profileMeta.proxy) {
        effectiveProxy = profileMeta.proxy;
      }
      if (profileMeta.geo) {
        if (!geoCountry && profileMeta.geo.countryCode) geoCountry = profileMeta.geo.countryCode;
        if (!geoTimezone && profileMeta.geo.timezone) geoTimezone = profileMeta.geo.timezone;
        if (!geoLocale && profileMeta.geo.locale) geoLocale = profileMeta.geo.locale;
        if (!geoLoc && profileMeta.geo.geolocation) geoLoc = profileMeta.geo.geolocation;
      }
      if (!effectiveEngine && profileMeta.engine) {
        effectiveEngine = profileMeta.engine;
      }
      if (!effectiveUserAgent && profileMeta.userAgent) {
        effectiveUserAgent = profileMeta.userAgent;
      }
      savedProfile = profileMeta;
      effectiveFingerprintSeed ??= profileMeta.fingerprint?.seed ?? stableProfileSeed(profileMeta.profileId);
      initialCookies = await this.profileStore.getCookies(profileMeta.profileId);
    }

    if (effectiveFingerprint === true && savedProfile) {
      effectiveFingerprint = fingerprintForSavedProfile(
        savedProfile,
        effectiveFingerprintSeed ?? stableProfileSeed(savedProfile.profileId),
        effectiveEngine ?? savedProfile.engine ?? 'firefox',
        geoCountry ?? savedProfile.geo?.countryCode,
      );
    }

    if (savedProfile) {
      const extensionIds = savedProfile.extensionIds ?? [];
      if (extensionIds.length && !this.extensionStore) throw new BrowserSessionError('BROWSER_LAUNCH_FAILED', 'Managed extension store is not configured');
      managedExtensions = this.extensionStore
        ? await this.extensionStore.resolveForLaunch(extensionIds, effectiveEngine ?? savedProfile.engine ?? 'firefox')
        : [];
    }

    let normalizedProxy;
    if (effectiveProxy) {
      normalizedProxy = normalizeProxyConfig(effectiveProxy);
    }

    let geoAlignment;
    if (effectiveProxy || geoCountry || geoTimezone || geoLocale || geoLoc) {
      const geoOptions: GeoAlignmentOptions = {
        ...(geoCountry !== undefined ? { countryCode: geoCountry } : {}),
        ...(geoTimezone !== undefined ? { timezone: geoTimezone } : {}),
        ...(geoLocale !== undefined ? { locale: geoLocale } : {}),
        ...(geoLoc !== undefined ? { geolocation: geoLoc } : {}),
      };
      geoAlignment = alignGeoEnvironment(geoOptions);
    }

    const effectiveProfileName = options.profileId ?? options.profileName ?? this.options.profileName;
    const persistBrowserProfile = options.profileId !== undefined || this.options.persistentProfile === true;
    const profileKey = persistBrowserProfile
      ? persistentProfileKey(effectiveProfileName)
      : undefined;
    if (profileKey !== undefined && this.persistentProfileOwners.has(profileKey)) {
      throw new BrowserSessionError('RESOURCE_EXHAUSTED', 'The requested persistent profile is already in use', { retryable: true });
    }
    // Construct an explicit allowlist of per-session fields. Policy, audit,
    // launcher, detector, scheduler and server-owned roots always come from
    // the manager and cannot be replaced by a session caller.
    const merged: BrowserSessionOptions = {
      ...this.options,
      automationPolicy: this.automationPolicy,
      ...(options.headless !== undefined ? { headless: options.headless } : {}),
      ...(options.runtimeMode !== undefined ? { runtimeMode: options.runtimeMode } : {}),
      ...(options.viewport !== undefined ? { viewport: options.viewport } : {}),
      ...(effectiveProfileName !== undefined ? { profileName: effectiveProfileName } : {}),
      persistentProfile: persistBrowserProfile,
      ...(effectiveEngine !== undefined ? { engine: effectiveEngine } : {}),
      ...(options.cdpEndpoint !== undefined ? { cdpEndpoint: options.cdpEndpoint } : {}),
      ...(options.inputProfile !== undefined ? { inputProfile: options.inputProfile } : {}),
      ...(options.seed !== undefined ? { seed: options.seed } : {}),
      ...(normalizedProxy ? {
        proxy: {
          server: normalizedProxy.server,
          ...(normalizedProxy.username !== undefined ? { username: normalizedProxy.username } : {}),
          ...(normalizedProxy.password !== undefined ? { password: normalizedProxy.password } : {}),
          ...(normalizedProxy.bypass !== undefined ? { bypass: normalizedProxy.bypass } : {}),
        },
      } : {}),
      ...(geoCountry !== undefined ? { countryCode: geoCountry } : {}),
      ...(geoAlignment ? {
        timezoneId: geoAlignment.timezoneId,
        locale: geoAlignment.locale,
        geolocation: geoAlignment.geolocation,
        permissions: ['geolocation'],
        extraHTTPHeaders: geoAlignment.extraHeaders,
      } : {}),
      ...(effectiveUserAgent !== undefined ? { userAgent: effectiveUserAgent } : {}),
      ...(effectiveFingerprint !== undefined ? { fingerprint: effectiveFingerprint } : {}),
      ...(effectiveFingerprintSeed !== undefined ? { fingerprintSeed: effectiveFingerprintSeed } : {}),
      ...(initialCookies !== undefined ? { initialCookies } : {}),
      ...(managedExtensions !== undefined ? { managedExtensions } : {}),
      ...(options.profileId !== undefined ? {
        onCookiesPersist: (cookies: readonly CookieRecord[]) => this.profileStore.saveCookies(options.profileId!, cookies),
      } : {}),
      ...(options.challengePolicy !== undefined ? { challengePolicy: options.challengePolicy } : {}),
    };
    delete (merged as { maxSessions?: number }).maxSessions;
    delete (merged as { policyProfile?: unknown }).policyProfile;
    delete (merged as { sessionFactory?: unknown }).sessionFactory;
    delete (merged as { cluster?: unknown }).cluster;
    delete (merged as { sessionTtlMs?: unknown }).sessionTtlMs;
    delete (merged as { handoffTtlMs?: unknown }).handoffTtlMs;
    delete (merged as { workspaceTtlMs?: unknown }).workspaceTtlMs;
    delete (merged as { privateNetworkEnabled?: unknown }).privateNetworkEnabled;
    delete (merged as { clock?: unknown }).clock;
    delete (merged as { extensionStore?: unknown }).extensionStore;
    const session = this.options.sessionFactory
      ? this.options.sessionFactory(merged)
      : new BrowserSession(merged);
    if (profileKey !== undefined) this.persistentProfileOwners.set(profileKey, session.sessionId);
    this.expiredSessionIds.delete(session.sessionId);
    this.sessions.set(session.sessionId, session);
    try {
      await session.start();
      this.scheduleExpiry(session.sessionId);
      const now = this.readNow();
      const expiresAt = retention === 'destroy' ? undefined : now + this.workspaceTtlMs;
      const workspace: Workspace = {
        workspaceId: createWorkspaceId(),
        tenantId,
        name: requestedWorkspaceName ?? `workspace-${session.sessionId.slice(4, 12)}`,
        owner: 'agent',
        controlState: 'AGENT_CONTROLLED',
        retention,
        sessionId: session.sessionId,
        createdAt: now,
        updatedAt: now,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      };
      this.workspaces.set(workspace.workspaceId, workspace);
      this.workspaceBySession.set(session.sessionId, workspace.workspaceId);
      if (expiresAt !== undefined) this.scheduleWorkspaceExpiry(workspace.workspaceId, expiresAt);
      return session;
    } catch (error) {
      this.clearExpiryTimer(session.sessionId);
      this.sessions.delete(session.sessionId);
      if (profileKey !== undefined && this.persistentProfileOwners.get(profileKey) === session.sessionId) {
        this.persistentProfileOwners.delete(profileKey);
      }
      throw error;
    }
  }

  public createSession = this.start.bind(this);
  public startSession = this.start.bind(this);

  public get(sessionId: string, tenantId?: string): BrowserSession {
    const expiry = this.expiryTimers.get(sessionId);
    if (this.expiredSessionIds.has(sessionId) || (expiry?.expiresAt !== undefined && this.readNow() >= expiry.expiresAt)) {
      if (expiry?.expiresAt !== undefined && this.readNow() >= expiry.expiresAt) {
        this.clearExpiryTimer(sessionId);
        this.rememberExpired(sessionId);
        void this.expireSession(sessionId).catch(() => undefined);
      }
      throw sessionExpiredError(sessionId);
    }
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('SESSION_NOT_FOUND');
    if (tenantId !== undefined) this.assertSessionTenant(sessionId, tenantId);
    return session;
  }

  public status(sessionId: string, tenantId?: string): BrowserSessionStatus & { workspace?: Workspace } {
    const status = this.get(sessionId, tenantId).status();
    const workspaceId = this.workspaceBySession.get(sessionId);
    const workspace = workspaceId ? this.workspaces.get(workspaceId) : undefined;
    return workspace ? { ...status, workspace: cloneWorkspace(workspace) } : status;
  }

  public async environmentDiagnostics(sessionId: string, tenantId?: string): Promise<EnvironmentDiagnostics> {
    return this.get(sessionId, tenantId).environmentDiagnostics();
  }

  public getSessionState(sessionId: string, tenantId?: string): BrowserSessionStatus['state'] {
    return this.get(sessionId, tenantId).state;
  }

  public listWorkspaces(tenantId?: string): Workspace[] {
    this.pruneWorkspaces();
    return [...this.workspaces.values()]
      .filter((workspace) => tenantId === undefined || workspace.tenantId === normalizeTenantId(tenantId))
      .map((workspace) => cloneWorkspace(workspace));
  }

  public getWorkspace(workspaceId: string, tenantId?: string): Workspace {
    this.pruneWorkspaces();
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new BrowserToolError('WORKSPACE_NOT_FOUND', { details: { workspaceId } });
    if (tenantId !== undefined) this.assertWorkspaceTenant(workspace, tenantId);
    return cloneWorkspace(workspace);
  }

  /** Safe lookup used by the MCP hard-stop gate; never returns a live object. */
  public getWorkspaceForSession(sessionId: string, tenantId?: string): Workspace | undefined {
    this.pruneWorkspaces();
    const workspaceId = this.workspaceBySession.get(sessionId);
    const workspace = workspaceId ? this.workspaces.get(workspaceId) : undefined;
    if (workspace && tenantId !== undefined) this.assertWorkspaceTenant(workspace, tenantId);
    return workspace ? cloneWorkspace(workspace) : undefined;
  }
  public async listTabs(sessionId: string, tenantId?: string): Promise<BrowserTabStatus[]> {
    return this.get(sessionId, tenantId).listTabs();
  }

  public async switchTab(sessionId: string, tabId: string, tenantId?: string): Promise<BrowserTabStatus> {
    this.assertWriteAllowed(sessionId, 'page_switch_tab', tenantId);
    return this.get(sessionId, tenantId).switchTab(tabId);
  }

  public async closeTab(sessionId: string, tabId: string, tenantId?: string): Promise<{ closedTabId: string; tabs: BrowserTabStatus[] }> {
    this.assertWriteAllowed(sessionId, 'page_close_tab', tenantId);
    return this.get(sessionId, tenantId).closeTab(tabId);
  }

  public capabilities(supportedTools: readonly string[] = []): BrowserCapabilities {
    return {
      serverVersion: SERVER_VERSION,
      policy: this.automationPolicy.name,
      limits: this.automationPolicy.limits,
      supportedTools: [...supportedTools],
      maxConcurrentSessions: this.maxSessions,
      maxTabsPerSession: this.automationPolicy.limits.maxTabs,
      sessionDefaultTtlMs: this.sessionTtlMs,
      workspaceDefaultTtlMs: this.workspaceTtlMs,
      privateNetworkEnabled: this.privateNetworkEnabled,
      forbiddenCapabilities: FORBIDDEN_CAPABILITIES,
      managedBrowserVersions: {
        firefox: managedBrowserIdentity('firefox').fullVersion,
        chromium: managedBrowserIdentity('chromium').fullVersion,
      },
      serviceWorkerFingerprintInjectionByEngine: { firefox: true, chromium: true },
    };
  }

  /**
   * Fail closed before any agent-controlled page mutation. The browser layer
   * repeats this gate after its serial queue acquires the action slot.
   */
  public assertWriteAllowed(sessionId: string, action = 'page_action', tenantId?: string): void {
    const session = this.get(sessionId, tenantId);
    const workspace = this.getWorkspaceForSession(sessionId, tenantId);
    if (workspace?.controlState === 'USER_CONTROLLED' || session.state === 'USER_CONTROLLED') {
      throw new BrowserToolError('USER_CONTROL_HARD_STOP', {
        details: { action, ...(workspace ? { workspaceId: workspace.workspaceId } : {}) },
        sessionId,
        sessionState: session.state,
        retryable: false,
      });
    }
    if (session.state === 'PAUSED_CHALLENGE') {
      throw new BrowserToolError('SESSION_PAUSED_CHALLENGE', {
        details: { action },
        sessionId,
        sessionState: session.state,
        retryable: false,
      });
    }
  }

  public async workspaceHandoff(workspaceId: string, reason?: string, tenantId?: string): Promise<WorkspaceHandoffResult> {
    const workspace = this.requireWorkspace(workspaceId, tenantId);
    if (workspace.controlState === 'USER_CONTROLLED') {
      throw new BrowserToolError('MANUAL_TAKEOVER_ACTIVE', {
        details: { workspaceId },
        sessionId: workspace.sessionId,
        sessionState: 'USER_CONTROLLED',
      });
    }
    const handedOff = await this.handoff(workspace.sessionId, {
      ttlMs: this.handoffTtlMs,
      ...(reason !== undefined ? { reason } : {}),
    }, tenantId);
    const leaseId = handedOff.leaseToken;
    const expiresAt = handedOff.control.expiresAt ?? (this.readNow() + this.handoffTtlMs);
    this.workspaceLeases.set(workspaceId, { tokenDigest: digestWorkspaceLease(leaseId), expiresAt });
    const updated = this.requireWorkspace(workspaceId, tenantId);
    return {
      workspace: cloneWorkspace(updated),
      leaseId,
      expiresAt,
      status: handedOff,
    };
  }

  public async workspaceResume(workspaceId: string, leaseId: string, humanConfirmed: boolean, tenantId?: string): Promise<WorkspaceResumeResult> {
    const workspace = this.requireWorkspace(workspaceId, tenantId);
    const lease = this.workspaceLeases.get(workspaceId);
    if (workspace.controlState !== 'USER_CONTROLLED' || !lease) {
      throw new BrowserToolError('HUMAN_HANDOFF_EXPIRED', { details: { workspaceId } });
    }
    if (lease.expiresAt <= this.readNow()) {
      this.workspaceLeases.delete(workspaceId);
      throw new BrowserToolError('HUMAN_HANDOFF_EXPIRED', { details: { workspaceId } });
    }
    if (lease.tokenDigest !== digestWorkspaceLease(leaseId)) {
      throw new BrowserToolError('HUMAN_HANDOFF_EXPIRED', { details: { workspaceId } });
    }
    const status = await this.takeover(workspace.sessionId, leaseId, humanConfirmed, tenantId);
    return {
      workspace: cloneWorkspace(this.requireWorkspace(workspaceId, tenantId)),
      status,
    };
  }

  public async stop(sessionId: string, reason?: string, tenantId?: string): Promise<BrowserSessionStatus> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      const closed = this.closedStatuses.get(sessionId);
      if (closed) {
        if (tenantId !== undefined) this.assertSessionTenant(sessionId, tenantId);
        return closed;
      }
      throw new Error('SESSION_NOT_FOUND');
    }
    if (tenantId !== undefined) this.assertSessionTenant(sessionId, tenantId);
    this.clearExpiryTimer(sessionId);
    try {
      const status = await session.stop(reason);
      this.sessions.delete(sessionId);
      this.releasePersistentProfile(sessionId);
      this.deactivateWorkspace(sessionId);
      this.rememberClosed(status);
      return status;
    } catch (error) {
      // 无论何种原因导致的 stop 失败（如底层进程卡死、I/O 超时或审计落盘异常），
      // 只要该会话已不可用，强制清理槽位与释放 Profile 锁，防止并发资源永久泄漏
      this.sessions.delete(sessionId);
      this.releasePersistentProfile(sessionId);
      this.deactivateWorkspace(sessionId);
      try {
        this.rememberClosed(session.status());
      } catch (_) {}
      throw error;
    }
  }

  public async reopenHeaded(sessionId: string, tenantId?: string): Promise<BrowserSessionStatus> {
    return this.get(sessionId, tenantId).reopenHeaded();
  }

  public async resume(sessionId: string, humanConfirmed: boolean, tenantId?: string): Promise<BrowserSessionStatus> {
    return this.get(sessionId, tenantId).resume(humanConfirmed);
  }

  public async dispatchDirectMouse(
    sessionId: string,
    action: 'click' | 'move' | 'down' | 'up',
    x: number,
    y: number,
    options?: { button?: 'left' | 'right' | 'middle'; clickCount?: number },
    tenantId?: string,
  ) {
    return this.get(sessionId, tenantId).dispatchDirectMouse(action, x, y, options);
  }

  public async dispatchDirectKeyboard(
    sessionId: string,
    action: 'type' | 'press' | 'down' | 'up',
    keyOrText: string,
    tenantId?: string,
  ) {
    return this.get(sessionId, tenantId).dispatchDirectKeyboard(action, keyOrText);
  }

  public async dispatchDirectScroll(
    sessionId: string,
    deltaX: number,
    deltaY: number,
    tenantId?: string,
  ) {
    return this.get(sessionId, tenantId).dispatchDirectScroll(deltaX, deltaY);
  }
  public async handoff(sessionId: string, options?: Parameters<BrowserSession['handoff']>[0], tenantId?: string): Promise<Awaited<ReturnType<BrowserSession['handoff']>>> {
    const result = await this.get(sessionId, tenantId).handoff(options);
    this.updateWorkspaceControl(sessionId, 'user', 'USER_CONTROLLED', {
      leaseToken: result.leaseToken,
      ...(result.control.expiresAt !== undefined ? { expiresAt: result.control.expiresAt } : {}),
    });
    return result;
  }

  public async takeover(sessionId: string, leaseToken: string, humanConfirmed: boolean, tenantId?: string): Promise<BrowserSessionStatus> {
    const result = await this.get(sessionId, tenantId).takeover(leaseToken, humanConfirmed);
    this.updateWorkspaceControl(sessionId, 'agent', 'AGENT_CONTROLLED');
    return result;
  }

  public async open(sessionId: string, url: string, options?: Parameters<BrowserSession['open']>[1], tenantId?: string): Promise<ReturnType<BrowserSession['open']> extends Promise<infer T> ? T : never> {
    this.assertWriteAllowed(sessionId, 'page_open', tenantId);
    return this.get(sessionId, tenantId).open(url, options);
  }

  public async snapshot(sessionId: string, options?: Parameters<BrowserSession['snapshot']>[0], tenantId?: string): Promise<ReturnType<BrowserSession['snapshot']> extends Promise<infer T> ? T : never> {
    return this.get(sessionId, tenantId).snapshot(options);
  }

  public async screenshot(sessionId: string, options?: Parameters<BrowserSession['screenshot']>[0], tenantId?: string): Promise<ReturnType<BrowserSession['screenshot']> extends Promise<infer T> ? T : never> {
    return this.get(sessionId, tenantId).screenshot(options);
  }

  public async observeSyncEvents(sessionId: string, handler: Parameters<BrowserSession['observeSyncEvents']>[0], tenantId?: string): Promise<() => void> {
    return this.get(sessionId, tenantId).observeSyncEvents(handler);
  }

  public async click(sessionId: string, target: string | SemanticTarget, options?: Parameters<BrowserSession['click']>[1], tenantId?: string): Promise<ReturnType<BrowserSession['click']> extends Promise<infer T> ? T : never> {
    this.assertWriteAllowed(sessionId, 'page_click', tenantId);
    return this.get(sessionId, tenantId).click(target, options);
  }

  public async type(sessionId: string, target: string | SemanticTarget, text: string, options?: Parameters<BrowserSession['type']>[2], tenantId?: string): Promise<ReturnType<BrowserSession['type']> extends Promise<infer T> ? T : never> {
    this.assertWriteAllowed(sessionId, 'page_type', tenantId);
    return this.get(sessionId, tenantId).type(target, text, options);
  }

  public async select(sessionId: string, target: string | SemanticTarget, choice: Parameters<BrowserSession['select']>[1], options?: Parameters<BrowserSession['select']>[2], tenantId?: string): Promise<ReturnType<BrowserSession['select']> extends Promise<infer T> ? T : never> {
    this.assertWriteAllowed(sessionId, 'page_select', tenantId);
    return this.get(sessionId, tenantId).select(target, choice, options);
  }

  public async scroll(sessionId: string, direction: Parameters<BrowserSession['scroll']>[0], amount?: Parameters<BrowserSession['scroll']>[1], ref?: Parameters<BrowserSession['scroll']>[2], options?: Parameters<BrowserSession['scroll']>[3], tenantId?: string): Promise<ReturnType<BrowserSession['scroll']> extends Promise<infer T> ? T : never> {
    this.assertWriteAllowed(sessionId, 'page_scroll', tenantId);
    return this.get(sessionId, tenantId).scroll(direction, amount, ref, options);
  }

  public async wait(sessionId: string, request: Parameters<BrowserSession['wait']>[0], tenantId?: string): Promise<ReturnType<BrowserSession['wait']> extends Promise<infer T> ? T : never> {
    return this.get(sessionId, tenantId).wait(request);
  }

  public async workflow(
    sessionId: string,
    definition: Parameters<BrowserSession['workflow']>[0],
    options?: Parameters<BrowserSession['workflow']>[1],
    tenantId?: string,
  ): Promise<Awaited<ReturnType<BrowserSession['workflow']>>> {
    this.assertWriteAllowed(sessionId, 'page_workflow_execute', tenantId);
    return this.get(sessionId, tenantId).workflow(definition, options);
  }

  public async extract(sessionId: string, schema: ExtractionSchema, tenantId?: string): Promise<ReturnType<BrowserSession['extract']> extends Promise<infer T> ? T : never> {
    return this.get(sessionId, tenantId).extract(schema);
  }

  public async fetch(options: Omit<FetchOptions, 'urlPolicy'>): Promise<FetchResult> {
    const policy = this.options.urlPolicy;
    if (!policy?.assertAllowed) {
      throw new BrowserSessionError('NAVIGATION_DENIED', 'A server URL policy is required for HTTP fetch');
    }
    return fetchPage({
      ...options,
      urlPolicy: policy as FetchUrlPolicy,
    });
  }

  public async submitClusterTask(def: DistributedTaskDefinition, tenantId = DEFAULT_TENANT_ID): Promise<DistributedTaskRecord> {
    return this.requireClusterScheduler().submitTask(def, tenantId);
  }

  public async submitClusterBatch(defs: readonly DistributedTaskDefinition[], tenantId = DEFAULT_TENANT_ID): Promise<DistributedTaskRecord[]> {
    return this.requireClusterScheduler().submitBatch(defs, tenantId);
  }

  public async getClusterStatus(tenantId = DEFAULT_TENANT_ID): Promise<ClusterStatus> {
    return this.requireClusterScheduler().getClusterStatus(tenantId);
  }

  public async getClusterTask(taskId: string, tenantId = DEFAULT_TENANT_ID): Promise<DistributedTaskRecord | null> {
    return this.requireClusterScheduler().getTask(taskId, tenantId);
  }

  public async listClusterTasks(
    filter: TaskListFilter = {},
    limit = 100,
    tenantId = DEFAULT_TENANT_ID,
  ): Promise<DistributedTaskRecord[]> {
    return this.requireClusterScheduler().listTasks(filter, limit, tenantId);
  }

  public async preflightClusterTaskUrl(url: string, tenantId = DEFAULT_TENANT_ID): Promise<TaskUrlPreflight> {
    return this.requireClusterScheduler().preflightTaskUrl(url, tenantId);
  }

  public async cancelClusterTask(taskId: string, tenantId = DEFAULT_TENANT_ID): Promise<DistributedTaskRecord> {
    return this.requireClusterScheduler().cancelTask(taskId, tenantId);
  }

  public async retryClusterTask(taskId: string, tenantId = DEFAULT_TENANT_ID): Promise<DistributedTaskRecord> {
    return this.requireClusterScheduler().retryTask(taskId, tenantId);
  }

  public async shutdown(reason = 'shutdown'): Promise<void> {
    await this.shutdownSessions(reason);
    await this.clusterScheduler?.shutdown();
  }

  /** Close browser sessions without shutting down the cluster coordinator. */
  public async shutdownSessions(reason = 'shutdown'): Promise<void> {
    this.clearAllExpiryTimers();
    const sessions = [...this.sessions.values()];
    await Promise.all(sessions.map((session) => session.stop(reason).catch(() => undefined)));
    for (const session of sessions) {
      this.releasePersistentProfile(session.sessionId);
      this.deactivateWorkspace(session.sessionId);
      this.rememberClosed(session.status());
    }
    this.sessions.clear();
  }

  private rememberClosed(status: BrowserSessionStatus): void {
    this.closedStatuses.delete(status.sessionId);
    this.closedStatuses.set(status.sessionId, status);
    while (this.closedStatuses.size > this.maxClosedStatuses) {
      const oldest = this.closedStatuses.keys().next().value as string | undefined;
      if (!oldest) break;
      this.closedStatuses.delete(oldest);
    }
  }

  /** Schedule a one-shot absolute TTL. Native Node timers are unref'd so a
   * forgotten manager cannot keep an otherwise idle process resident. */
  private scheduleExpiry(sessionId: string): void {
    this.scheduleExpiryAt(sessionId, this.readNow() + this.sessionTtlMs);
  }

  private scheduleExpiryAt(sessionId: string, expiresAt: number): void {
    this.clearExpiryTimer(sessionId);
    const generation = ++this.nextExpiryGeneration;
    const delayMs = Math.max(0, expiresAt - this.readNow());
    const handle = this.scheduleTimer(() => {
      const current = this.expiryTimers.get(sessionId);
      if (!current || current.generation !== generation) return;
      if (current.expiresAt !== undefined && this.readNow() < current.expiresAt) {
        this.scheduleExpiryAt(sessionId, current.expiresAt);
        return;
      }
      this.expiryTimers.delete(sessionId);
      void this.expireSession(sessionId).catch(() => undefined);
    }, delayMs);
    this.expiryTimers.set(sessionId, { handle, generation, expiresAt });
    unrefTimer(handle);
  }

  private clearExpiryTimer(sessionId: string): void {
    const timer = this.expiryTimers.get(sessionId);
    if (!timer) return;
    this.expiryTimers.delete(sessionId);
    this.cancelTimer(timer.handle);
  }

  private clearAllExpiryTimers(): void {
    for (const sessionId of [...this.expiryTimers.keys()]) this.clearExpiryTimer(sessionId);
  }

  private async expireSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    // Mark first so every state/action lookup fails closed while cleanup is
    // draining the session queue and closing the browser context.
    this.rememberExpired(sessionId);
    try {
      await this.stop(sessionId, 'session-ttl-expired');
    } catch {
      const current = this.sessions.get(sessionId);
      if (current && current.state !== 'STOPPED') {
        // A transient cleanup failure must not leave an expired browser alive
        // forever. Keep the slot occupied until a later retry succeeds.
        this.scheduleExpiryRetry(sessionId);
      }
    }
  }

  private scheduleExpiryRetry(sessionId: string): void {
    this.clearExpiryTimer(sessionId);
    const generation = ++this.nextExpiryGeneration;
    const retryDelayMs = Math.min(5_000, this.sessionTtlMs);
    const handle = this.scheduleTimer(() => {
      const current = this.expiryTimers.get(sessionId);
      if (!current || current.generation !== generation) return;
      this.expiryTimers.delete(sessionId);
      void this.expireSession(sessionId).catch(() => undefined);
    }, retryDelayMs);
    this.expiryTimers.set(sessionId, { handle, generation });
    unrefTimer(handle);
  }

  private rememberExpired(sessionId: string): void {
    this.expiredSessionIds.delete(sessionId);
    this.expiredSessionIds.add(sessionId);
    while (this.expiredSessionIds.size > this.maxClosedStatuses) {
      const oldest = this.expiredSessionIds.values().next().value as string | undefined;
      if (!oldest) break;
      this.expiredSessionIds.delete(oldest);
    }
  }

  private requireWorkspace(workspaceId: string, tenantId?: string): Workspace {
    this.pruneWorkspaces();
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new BrowserToolError('WORKSPACE_NOT_FOUND', { details: { workspaceId } });
    if (tenantId !== undefined) this.assertWorkspaceTenant(workspace, tenantId);
    return workspace;
  }

  private assertSessionTenant(sessionId: string, tenantId: string): void {
    const workspaceId = this.workspaceBySession.get(sessionId);
    const workspace = workspaceId ? this.workspaces.get(workspaceId) : undefined;
    if (!workspace || workspace.tenantId !== normalizeTenantId(tenantId)) {
      throw new BrowserToolError('PERMISSION_DENIED', {
        details: { resource: 'browser_session' },
        retryable: false,
      });
    }
  }

  private assertWorkspaceTenant(workspace: Workspace, tenantId: string): void {
    if (workspace.tenantId === normalizeTenantId(tenantId)) return;
    throw new BrowserToolError('PERMISSION_DENIED', {
      details: { resource: 'workspace' },
      retryable: false,
    });
  }

  private pruneWorkspaces(): void {
    const now = this.readNow();
    for (const [workspaceId, workspace] of this.workspaces) {
      if (workspace.controlState !== 'INACTIVE' || workspace.expiresAt === undefined || workspace.expiresAt > now) continue;
      this.deleteWorkspace(workspaceId);
    }
  }

  private scheduleWorkspaceExpiry(workspaceId: string, expiresAt: number): void {
    this.clearWorkspaceExpiryTimer(workspaceId);
    const delayMs = Math.max(0, expiresAt - this.readNow());
    const handle = this.scheduleTimer(() => {
      this.workspaceExpiryTimers.delete(workspaceId);
      const workspace = this.workspaces.get(workspaceId);
      if (!workspace || workspace.expiresAt !== expiresAt || workspace.controlState !== 'INACTIVE') return;
      if (workspace.expiresAt <= this.readNow()) this.deleteWorkspace(workspaceId);
      else this.scheduleWorkspaceExpiry(workspaceId, workspace.expiresAt);
    }, delayMs);
    this.workspaceExpiryTimers.set(workspaceId, handle);
    unrefTimer(handle);
  }

  private clearWorkspaceExpiryTimer(workspaceId: string): void {
    const handle = this.workspaceExpiryTimers.get(workspaceId);
    if (!handle) return;
    this.workspaceExpiryTimers.delete(workspaceId);
    this.cancelTimer(handle);
  }

  private deleteWorkspace(workspaceId: string): void {
    this.clearWorkspaceExpiryTimer(workspaceId);
    this.workspaceLeases.delete(workspaceId);
    const workspace = this.workspaces.get(workspaceId);
    if (workspace && this.workspaceBySession.get(workspace.sessionId) === workspaceId) {
      this.workspaceBySession.delete(workspace.sessionId);
    }
    this.workspaces.delete(workspaceId);
  }

  private deactivateWorkspace(sessionId: string): void {
    const workspaceId = this.workspaceBySession.get(sessionId);
    if (!workspaceId) return;
    this.workspaceLeases.delete(workspaceId);
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      this.workspaceBySession.delete(sessionId);
      return;
    }
    const now = this.readNow();
    if (workspace.retention === 'destroy' || (workspace.expiresAt !== undefined && workspace.expiresAt <= now)) {
      this.deleteWorkspace(workspaceId);
      return;
    }
    // Retained records keep their session binding so an authenticated caller
    // cannot read a closed session projection from another tenant.
    this.workspaces.set(workspaceId, {
      ...workspace,
      owner: 'none',
      controlState: 'INACTIVE',
      updatedAt: now,
    });
  }

  private updateWorkspaceControl(
    sessionId: string,
    owner: Workspace['owner'],
    controlState: Workspace['controlState'],
    lease?: { leaseToken?: string; expiresAt?: number },
  ): void {
    const workspaceId = this.workspaceBySession.get(sessionId);
    if (!workspaceId) return;
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return;
    if (owner === 'agent') this.workspaceLeases.delete(workspaceId);
    else if (lease?.leaseToken !== undefined) {
      this.workspaceLeases.set(workspaceId, {
        tokenDigest: digestWorkspaceLease(lease.leaseToken),
        expiresAt: lease.expiresAt ?? (this.readNow() + this.handoffTtlMs),
      });
    }
    this.workspaces.set(workspaceId, {
      ...workspace,
      owner,
      controlState,
      updatedAt: this.readNow(),
    });
  }

  private readNow(): number {
    const value = this.now();
    return Number.isFinite(value) ? value : Date.now();
  }

  private requireClusterScheduler(): DistributedMasterScheduler {
    if (!this.clusterScheduler) {
      throw new BrowserSessionError('INVALID_STATE', 'Cluster coordination is disabled for this browser worker');
    }
    return this.clusterScheduler;
  }

  private releasePersistentProfile(sessionId: string): void {
    for (const [profileKey, owner] of this.persistentProfileOwners.entries()) {
      if (owner === sessionId) this.persistentProfileOwners.delete(profileKey);
    }
  }
}

function persistentProfileKey(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(normalized) ? normalized : undefined;
}

function stableProfileSeed(profileId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < profileId.length; index += 1) {
    hash ^= profileId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) || 1;
}

function fingerprintForSavedProfile(
  profile: ProfileMetadata,
  seed: number,
  engine: 'firefox' | 'chromium',
  countryCode?: string,
): UnifiedFingerprintProfile {
  const settings = profile.fingerprint;
  const generated = generateFingerprint({
    seed,
    engine,
    ...(settings?.os !== undefined ? { os: settings.os } : {}),
    ...(countryCode !== undefined ? { countryCode } : {}),
  });
  const screenSettings = settings?.screen;
  const screen = screenSettings ? {
    ...generated.screen,
    width: screenSettings.width,
    height: screenSettings.height,
    availWidth: screenSettings.availWidth ?? screenSettings.width,
    availHeight: screenSettings.availHeight ?? Math.max(240, screenSettings.height - 40),
    colorDepth: screenSettings.colorDepth ?? generated.screen.colorDepth,
    pixelDepth: screenSettings.colorDepth ?? generated.screen.pixelDepth,
    devicePixelRatio: screenSettings.devicePixelRatio ?? generated.screen.devicePixelRatio,
  } : generated.screen;

  return {
    ...generated,
    screen,
    viewport: {
      width: screen.availWidth,
      height: screen.availHeight,
    },
    hardware: {
      ...generated.hardware,
      ...(settings?.hardwareConcurrency !== undefined
        ? { hardwareConcurrency: settings.hardwareConcurrency }
        : {}),
      ...(settings?.deviceMemory !== undefined ? { deviceMemory: settings.deviceMemory } : {}),
      screenWidth: screen.width,
      screenHeight: screen.height,
      availWidth: screen.availWidth,
      availHeight: screen.availHeight,
      colorDepth: screen.colorDepth,
      devicePixelRatio: screen.devicePixelRatio,
    },
  };
}

function boundedInteger(value: number, minimum: number, maximum: number, fallback: number): number {
  return Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, Math.floor(value)))
    : fallback;
}

function unrefTimer(handle: unknown): void {
  if (!handle || (typeof handle !== 'object' && typeof handle !== 'function')) return;
  const unref = (handle as { unref?: unknown }).unref;
  if (typeof unref === 'function') unref.call(handle);
}

function sessionExpiredError(sessionId: string): BrowserToolError {
  return new BrowserToolError('SESSION_EXPIRED', { sessionId });
}

export default SessionManager;
