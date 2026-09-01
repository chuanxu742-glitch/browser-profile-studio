import { mkdir, rm, writeFile } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createHash, randomBytes as cryptoRandomBytes, randomUUID } from 'node:crypto';
import { ChallengeDetector } from '../challenge/detector.js';
import { ChallengePolicy, DEFAULT_CHALLENGE_POLICY } from '../challenge/policy.js';
import type { ChallengeDetection } from '../challenge/signal.js';
import { delay as schedulerDelay, InteractionScheduler } from '../input/scheduler.js';
import type { Direction, SchedulerLocatorLike, SchedulerPageLike, SchedulerOptions } from '../input/scheduler.js';
import {
  TargetRegistry,
  TargetRegistryError,
} from './target-registry.js';
import type { RegistryLocatorLike, RegistryPageLike } from './target-registry.js';
import { addCompactSnapshotContent } from './semantic-snapshot.js';
import type { SemanticSnapshot } from './semantic-snapshot.js';
import type { SemanticTarget } from './semantic-snapshot.js';
import { SnapshotHistory, SnapshotHistoryError } from './snapshot-history.js';
import { getAutomationPolicy, DEFAULT_AUTOMATION_POLICY, type AutomationPolicy } from './automation-policy.js';
import type { SnapshotDiff } from './snapshot-history.js';
import { ControlLeaseError, ControlLeaseManager } from './control-lease.js';
import type { ControlLeaseStatus } from './control-lease.js';
import { WorkflowValidationError, workflowLimitsForPolicy } from './workflow.js';
import { WorkflowRunner } from './workflow-runner.js';
import type { WorkflowRunnerResult } from './workflow-runner.js';
import type {
  WorkflowActionOptions,
  WorkflowDefinition,
  WorkflowExecutionOptions,
  WorkflowTarget,
} from './workflow.js';
import {
  defaultFirefoxLauncher,
} from './firefox-launcher.js';
import { defaultChromiumLauncher } from './chromium-launcher.js';
import type {
  FirefoxContextLike,
  FirefoxLaunchOptions,
  FirefoxLauncherLike,
  FirefoxPageLike,
} from './firefox-launcher.js';
import { ExtractionResourceError, extractBatchData } from '../extractor/batch-extractor.js';
import type { ExtractionSchema, ExtractResult } from '../extractor/types.js';
import {
  browserVersionFromUserAgent,
  buildStealthInjectionScript,
  generateFingerprint,
  managedBrowserIdentity,
  type FingerprintConfig,
  type UnifiedFingerprintProfile,
} from '../fingerprint/index.js';
import type { CookieRecord } from '../profile/types.js';

export type BrowserSessionState =
  | 'STOPPED'
  | 'STARTING'
  | 'READY'
  | 'BUSY'
  | 'PAUSED_CHALLENGE'
  | 'HUMAN_TAKEOVER'
  | 'USER_CONTROLLED'
  | 'ERROR'
  | 'STOPPING';

export type BrowserErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'INVALID_STATE'
  | 'SESSION_BUSY'
  | 'SESSION_PAUSED_CHALLENGE'
  | 'NAVIGATION_DENIED'
  | 'PRIVATE_NETWORK_DENIED'
  | 'TARGET_NOT_FOUND'
  | 'TARGET_AMBIGUOUS'
  | 'TARGET_NOT_ACTIONABLE'
  | 'STALE_TARGET'
  | 'PAGE_REVISION_MISMATCH'
  | 'ACTION_ID_CONFLICT'
  | 'MANUAL_TAKEOVER_ACTIVE'
  | 'USER_CONTROL_HARD_STOP'
  | 'HUMAN_HANDOFF_EXPIRED'
  | 'TAKEOVER_UNAVAILABLE'
  | 'SNAPSHOT_NOT_FOUND'
  | 'SNAPSHOT_EXPIRED'
  | 'SNAPSHOT_ID_CONFLICT'
  | 'ACTION_TIMEOUT'
  | 'BROWSER_LAUNCH_FAILED'
  | 'BROWSER_CRASHED'
  | 'RESOURCE_EXHAUSTED'
  | 'AUDIT_UNAVAILABLE'
  | 'INVALID_ARGUMENT'
  | 'WORKFLOW_STEP_LIMIT_EXCEEDED'
  | 'INTERNAL';

export class BrowserSessionError extends Error {
  public readonly code: BrowserErrorCode;
  public readonly retryable: boolean;
  public readonly details: Record<string, unknown> | undefined;

  public constructor(
    code: BrowserErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'BrowserSessionError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export interface UrlPolicyLike {
  assertAllowed?(url: string, context?: { resource?: boolean }): Promise<unknown> | unknown;
  check?(url: string, context?: { resource?: boolean }): Promise<unknown> | unknown;
  isAllowed?(url: string, context?: { resource?: boolean }): Promise<boolean> | boolean;
}

export interface AuditLike {
  record?(event: Record<string, unknown>): Promise<void> | void;
  write?(event: Record<string, unknown>): Promise<void> | void;
  append?(event: Record<string, unknown>): Promise<void> | void;
}

export interface BrowserPageLike extends SchedulerPageLike {
  url(): string;
  title(): Promise<string>;
  locator(selector: string): RegistryLocatorLike;
  getByRole?(role: string, options?: { name?: string; exact?: boolean }): RegistryLocatorLike;
  getByLabel?(label: string, options?: { exact?: boolean }): RegistryLocatorLike;
  getByTestId?(testId: string): RegistryLocatorLike;
  goto?(url: string, options?: Record<string, unknown>): Promise<unknown>;
  screenshot?(options?: Record<string, unknown>): Promise<Buffer | void>;
  close?(): Promise<void>;
  bringToFront?(): Promise<void>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  mainFrame?(): unknown;
  evaluate?(expression: string, arg?: unknown): Promise<unknown>;
}

export interface BrowserSessionOptions {
  sessionId?: string;
  headless?: boolean;
  /** Browser engine used by the managed/control-plane session. */
  engine?: 'firefox' | 'chromium';
  /** Optional existing Chromium DevTools endpoint for controlled attachment. */
  cdpEndpoint?: string;
  runtimeMode?: 'headless' | 'headed_local';
  viewport?: { width: number; height: number };
  /** A server-owned root. Callers cannot provide a profile directory. */
  profileRoot?: string;
  /** A simple server-mapped profile name, never a path. */
  profileName?: string;
  /** Keep a named profile on disk across stop/start and process restarts. */
  persistentProfile?: boolean;
  /** A server-owned artifact root; screenshot calls cannot choose a path. */
  artifactsRoot?: string;
  launcher?: FirefoxLauncherLike;
  urlPolicy?: UrlPolicyLike;
  detector?: ChallengeDetector;
  scheduler?: InteractionScheduler;
  schedulerOptions?: SchedulerOptions;
  inputProfile?: 'direct' | 'paced';
  seed?: number;
  maxQueue?: number;
  /** Proxy configuration for this session */
  proxy?: {
    server: string;
    username?: string;
    password?: string;
    bypass?: string;
  };
  /** GeoIP country used to generate the session fingerprint profile. */
  countryCode?: string;
  /** Explicit or GeoIP-derived timezone ID, e.g. America/New_York */
  timezoneId?: string;
  /** Explicit or GeoIP-derived locale, e.g. en-US */
  locale?: string;
  /** Geolocation coordinates */
  geolocation?: { latitude: number; longitude: number; accuracy?: number };
  /** Granted browser permissions, e.g. ['geolocation'] */
  permissions?: string[];
  /** Challenge handling and pause policy */
  challengePolicy?: ChallengePolicy;
  /** Custom extra HTTP headers, e.g. Accept-Language */
  extraHTTPHeaders?: Record<string, string>;
  /** Custom User-Agent string */
  userAgent?: string;
  /** Fingerprint configuration or boolean to enable auto-generation */
  fingerprint?: FingerprintConfig | boolean;
  /** Seed for deterministic fingerprint generation */
  fingerprintSeed?: number;
  /** Server-loaded cookies for a saved profile. */
  initialCookies?: readonly CookieRecord[];
  /** Server-owned callback used to persist the final profile cookie jar. */
  onCookiesPersist?: (cookies: readonly CookieRecord[]) => Promise<void> | void;
  /** Server-owned resource policy selected by SessionManager. */
  automationPolicy?: AutomationPolicy;
  /** Server-owned default action timeout, bounded to 1-60 seconds. */
  defaultTimeoutMs?: number;
  now?: () => Date;
  audit?: AuditLike;
  /** Server-resolved extensions; public callers can never provide filesystem paths. */
  managedExtensions?: FirefoxLaunchOptions['managedExtensions'];
}

export interface BrowserSessionStatus {
  sessionId: string;
  state: BrowserSessionState;
  engine?: 'firefox' | 'chromium';
  headless: boolean;
  pageGeneration: number;
  queueDepth: number;
  tabId?: string;
  url?: string;
  title?: string;
  challenge: {
    detected: boolean;
    category?: string;
    detectedAt?: string;
    signals?: ChallengeDetection['signals'];
  };
  interrupts: {
    latestSequence: number;
    total: number;
    recent: BrowserInterrupt[];
  };
  /** Token-free control ownership projection. */
  control: ControlLeaseStatus;
  /** Safe profile metadata; no filesystem path is exposed. */
  profileName?: string;
  profilePersistent?: boolean;
}
export interface BrowserTabStatus {
  tabId: string;
  isMain: boolean;
  active: boolean;
  createdAt: number;
  pageRevision: number;
  url?: string;
  title?: string;
}
interface ManagedTab {
  tabId: string;
  page: BrowserPageLike;
  registry: TargetRegistry;
  snapshotHistory: SnapshotHistory;
  isMain: boolean;
  createdAt: number;
  pageRevision: number;
}
interface TabRestoreState {
  url: string;
  isMain: boolean;
  active: boolean;
}


export type BrowserInterruptType =
  | 'POPUP_BLOCKED'
  | 'TAB_LIMIT_EXCEEDED'
  | 'DIALOG_BLOCKED'
  | 'DOWNLOAD_BLOCKED'
  | 'PAGE_CRASHED';

export interface BrowserInterrupt {
  sequence: number;
  type: BrowserInterruptType;
  observedAt: string;
}
export interface WriteGuardOptions {
  /** Optional UUID supplied by the caller to make a write retry idempotent. */
  actionId?: string;
  /** Reject before the write if the current page revision differs. */
  expectedPageRevision?: number;
  /** Reject before the write if the active isolated tab differs. */
  expectedTabId?: string;
  /** Internal cancellation hook used by the bounded workflow executor. */
  signal?: AbortSignal;
}

export interface BrowserWaitRequest {
  durationMs?: number;
  condition?: { ref: string; state: 'visible' | 'hidden' | 'enabled' };
  target?: string | SemanticTarget;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type BrowserSelectChoice = string | { value: string } | { label: string };

interface RouteRequestLike {
  url(): string;
  isNavigationRequest?(): boolean;
  resourceType?(): string;
  headers?(): Record<string, string>;
}


interface RouteLike {
  request(): RouteRequestLike;
  continue(): Promise<void>;
  abort?(errorCode?: string): Promise<void>;
}

interface DialogLike {
  dismiss(): Promise<void>;
}

interface DownloadLike {
  cancel(): Promise<void>;
}

function newSessionId(): string {
  try {
    return `ses_${randomUUID().replace(/-/g, '')}`;
  } catch {
    return `ses_${Date.now().toString(36)}_${cryptoRandomBytes(8).toString('hex')}`;
  }
}

function validSessionId(value: string): boolean {
  return /^ses_[a-z0-9_-]{8,128}$/i.test(value);
}

function sanitizeProfileName(value: string | undefined): string {
  if (!value) return 'default';
  const normalized = value.trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(normalized) ? normalized : 'default';
}

function sanitizeTitle(value: string | undefined): string | undefined {
  return value?.replace(/[\u0000-\u001f]/g, '').slice(0, 500);
}

function safeUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function safeHost(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}

function isResourceProtocolAllowed(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || value === 'about:blank';
  } catch {
    return value === 'about:blank';
  }
}

function browserErrorFromTarget(error: unknown): BrowserSessionError {
  if (error instanceof ControlLeaseError) {
    return new BrowserSessionError(error.code as BrowserErrorCode, error.message, {
      retryable: error.retryable,
      details: error.details,
      cause: error,
    });
  }
  if (error instanceof SnapshotHistoryError) {
    const code: BrowserErrorCode = error.code === 'INVALID_SNAPSHOT'
      ? 'INVALID_ARGUMENT'
      : error.code;
    return new BrowserSessionError(code, error.message, {
      retryable: error.retryable,
      ...(error.details !== undefined ? { details: error.details } : {}),
      cause: error,
    });
  }
  if (error instanceof ExtractionResourceError) {
    return new BrowserSessionError('RESOURCE_EXHAUSTED', error.message, {
      details: error.details,
      retryable: false,
      cause: error,
    });
  }
  if (error instanceof TargetRegistryError) {
    const code: BrowserErrorCode = error.code === 'TARGET_AMBIGUOUS'
      ? 'TARGET_AMBIGUOUS'
      : error.code === 'TARGET_NOT_ACTIONABLE'
        ? 'TARGET_NOT_ACTIONABLE'
        : error.code === 'STALE_TARGET'
          ? 'STALE_TARGET'
          : error.code === 'INVALID_TARGET'
            ? 'INVALID_ARGUMENT'
            : 'TARGET_NOT_FOUND';
    return error.details === undefined
      ? new BrowserSessionError(code, error.message)
      : new BrowserSessionError(code, error.message, { details: error.details });
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'AUDIT_UNAVAILABLE'
  ) {
    return new BrowserSessionError('AUDIT_UNAVAILABLE', 'The audit log is unavailable', { cause: error });
  }
  return error instanceof BrowserSessionError
    ? error
    : new BrowserSessionError('INTERNAL', 'Browser action failed', { cause: error });
}

function isWritableState(state: BrowserSessionState): boolean {
  return state === 'READY';
}

function isReadableState(state: BrowserSessionState): boolean {
  return state === 'READY'
    || state === 'BUSY'
    || state === 'PAUSED_CHALLENGE'
    || state === 'HUMAN_TAKEOVER'
    || state === 'USER_CONTROLLED';
}

const STOP_DRAIN_TIMEOUT_MS = 5_000;
const MAX_ACTION_CACHE = 256;
const ACTION_CACHE_TTL_MS = 10 * 60_000;
const MAX_RECENT_INTERRUPTS = 16;
export const MAX_TABS_PER_SESSION = 32;
export class BrowserSession {
  public readonly sessionId: string;
  public readonly profileDirectory: string;
  public readonly automationPolicy: AutomationPolicy;
  public get registry(): TargetRegistry {
    return this.activeTab?.registry ?? this.fallbackRegistry;
  }
  public readonly detector: ChallengeDetector;
  public readonly scheduler: InteractionScheduler;
  public readonly challengePolicy: ChallengePolicy;

  private readonly options: BrowserSessionOptions;
  private readonly launcher: FirefoxLauncherLike;
  private readonly profileRoot: string;
  private readonly profileName: string;
  private readonly persistentProfile: boolean;
  private readonly engine: 'firefox' | 'chromium';
  private readonly artifactsRoot: string;
  private readonly artifactsDirectory: string;
  private readonly maxQueue: number;
  private readonly maxTabs: number;
  private readonly defaultTimeoutMs: number;
  private readonly fallbackRegistry: TargetRegistry;
  private readonly tabs = new Map<string, ManagedTab>();
  private activeTabId: string | undefined;
  private tabSequence = 0;
  private context: FirefoxContextLike | undefined;
  private page: BrowserPageLike | undefined;
  private _state: BrowserSessionState = 'STOPPED';
  private pageGeneration = 0;
  private queueDepth = 0;
  private queueTail: Promise<void> = Promise.resolve();
  private activeAbort: AbortController | undefined;
  private challengeDetection: ChallengeDetection | undefined;
  private stopPromise: Promise<BrowserSessionStatus> | undefined;
  private startPromise: Promise<BrowserSessionStatus> | undefined;
  private screenshotSequence = 0;
  private interruptSequence = 0;
  private interruptTotal = 0;
  private readonly recentInterrupts: BrowserInterrupt[] = [];
  private popupAdmissionTail: Promise<void> = Promise.resolve();
  private readonly blockedPopups = new WeakSet<object>();
  private controlLease: ControlLeaseManager;
  private readonly workflowExecutor: WorkflowRunner;
  private readonly workflowContext = new AsyncLocalStorage<symbol>();
  private activeWorkflowToken: symbol | undefined;
  private readonly actionCache = new Map<string, {
    fingerprint: string;
    expiresAt: number;
    result: Promise<unknown>;
  }>();
  private startedAt?: number;
  private currentHeadless: boolean;
  private syncEventHandler: ((action: { type: 'navigate' | 'click' | 'type' | 'scroll'; url?: string; target?: SemanticTarget; text?: string; deltaY?: number }) => void) | undefined;
  private syncCaptureInstalled = false;

  private get activeTab(): ManagedTab | undefined {
    return this.activeTabId === undefined ? undefined : this.tabs.get(this.activeTabId);
  }

  public constructor(options: BrowserSessionOptions = {}) {
    this.options = options;
    this.automationPolicy = options.automationPolicy ?? getAutomationPolicy(DEFAULT_AUTOMATION_POLICY);
    this.sessionId = options.sessionId && validSessionId(options.sessionId) ? options.sessionId : newSessionId();
    this.profileRoot = resolve(options.profileRoot ?? join(tmpdir(), 'compliant-firefox-profiles'));
    this.profileName = sanitizeProfileName(options.profileName);
    this.engine = options.engine ?? 'firefox';
    const namedProfile = typeof options.profileName === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(options.profileName.trim());
    this.persistentProfile = options.persistentProfile === true && namedProfile;
    this.profileDirectory = this.persistentProfile
      ? join(this.profileRoot, this.profileName)
      : join(this.profileRoot, `${this.profileName}-${this.sessionId}`);
    this.artifactsRoot = resolve(options.artifactsRoot ?? join(tmpdir(), 'compliant-firefox-artifacts'));
    this.artifactsDirectory = resolve(this.artifactsRoot, this.sessionId);
    this.currentHeadless = options.runtimeMode === 'headed_local'
      ? false
      : options.headless ?? true;
    this.launcher = options.launcher ?? defaultFirefoxLauncher;
    this.detector = options.detector ?? new ChallengeDetector();
    this.challengePolicy = options.challengePolicy ?? DEFAULT_CHALLENGE_POLICY;
    this.fallbackRegistry = new TargetRegistry({ sessionId: this.sessionId });
    if (options.scheduler) this.scheduler = options.scheduler;
    else {
      const schedulerOptions: SchedulerOptions = {
        ...(options.schedulerOptions ?? {}),
        mode: options.inputProfile ?? options.schedulerOptions?.mode ?? 'paced',
      };
      if (options.seed !== undefined) schedulerOptions.seed = options.seed;
      this.scheduler = new InteractionScheduler(schedulerOptions);
    }
    this.maxQueue = boundedInteger(options.maxQueue ?? 32, 1, 32, 32);
    this.maxTabs = Math.max(1, Math.min(MAX_TABS_PER_SESSION, this.automationPolicy.limits.maxTabs));
    this.defaultTimeoutMs = boundedInteger(options.defaultTimeoutMs ?? 15_000, 1_000, 60_000, 15_000);
    this.controlLease = this.createControlLease();
    this.workflowExecutor = new WorkflowRunner({
      open: (url, options) => this.open(url, workflowActionOptions(options)),
      click: (target, options) => this.click(workflowTarget(target), workflowActionOptions(options)),
      type: (target, text, options) => this.type(workflowTarget(target), text, workflowActionOptions(options)),
      select: (target, choice, options) => this.select(workflowTarget(target), choice, workflowActionOptions(options)),
      scroll: (direction, amount, target, options) => this.scroll(
        direction,
        amount,
        target === undefined ? undefined : workflowTarget(target),
        workflowActionOptions(options),
      ),
      wait: (request) => this.wait(request),
      snapshot: (options) => this.snapshot(options),
      status: () => this.status(),
    }, {
      now: () => this.options.now?.().getTime() ?? Date.now(),
      limits: workflowLimitsForPolicy(this.automationPolicy.limits),
    });
  }

  public get state(): BrowserSessionState {
    return this._state;
  }

  public get headless(): boolean {
    return this.currentHeadless;
  }

  public async start(): Promise<BrowserSessionStatus> {
    if (this._state === 'READY' || this._state === 'PAUSED_CHALLENGE' || this._state === 'HUMAN_TAKEOVER') {
      return this.status();
    }
    if (this._state === 'STARTING') {
      if (this.startPromise) return this.startPromise;
      throw new BrowserSessionError('INVALID_STATE', 'Session is already starting', { retryable: true });
    }
    if (this._state === 'STOPPING') throw new BrowserSessionError('INVALID_STATE', 'Session is stopping', { retryable: true });
    if (!this.controlLease.status().agentWriteAllowed) {
      this.controlLease.dispose();
      this.controlLease = this.createControlLease();
    }
    this._state = 'STARTING';
    this.stopPromise = undefined;
    this.startedAt = Date.now();
    const startPromise = (async (): Promise<BrowserSessionStatus> => {
      try {
        await mkdir(this.profileDirectory, { recursive: true, mode: 0o700 });
        await mkdir(this.artifactsDirectory, { recursive: true, mode: 0o700 });
        await this.launchContext(this.headless);
        await this.loadInitialCookies();
        this._state = 'READY';
        await this.scanChallenge();
        await this.audit({ action: 'browser_start', outcome: 'success' });
        return this.status();
      } catch (error) {
        this._state = 'ERROR';
        await this.closeContext().catch(() => undefined);
        await this.cleanupOwnedProfile().catch(() => undefined);
        await this.cleanupOwnedArtifacts().catch(() => undefined);
        throw error instanceof BrowserSessionError
          ? error
          : typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'AUDIT_UNAVAILABLE'
            ? browserErrorFromTarget(error)
            : new BrowserSessionError('BROWSER_LAUNCH_FAILED', 'Firefox could not be started', { cause: error });
      }
    })();
    this.startPromise = startPromise;
    try {
      return await startPromise;
    } finally {
      if (this.startPromise === startPromise) this.startPromise = undefined;
    }
  }

  public getStatus(): BrowserSessionStatus {
    return this.status();
  }

  public status(): BrowserSessionStatus {
    let url: string | undefined;
    try {
      url = safeUrl(this.page?.url());
    } catch {
      url = undefined;
    }
    const status: BrowserSessionStatus = {
      sessionId: this.sessionId,
      state: this._state,
      engine: this.engine,
      headless: this.headless,
      pageGeneration: this.pageGeneration,
      queueDepth: this.queueDepth,
      ...(this.activeTabId !== undefined ? { tabId: this.activeTabId } : {}),
      ...(url ? { url } : {}),
      challenge: {
        detected: this.challengeDetection?.detected ?? false,
        ...(this.challengeDetection?.category ? { category: this.challengeDetection.category } : {}),
        ...(this.challengeDetection?.observedAt ? { detectedAt: this.challengeDetection.observedAt } : {}),
        ...(this.challengeDetection?.signals ? { signals: this.challengeDetection.signals } : {}),
      },
      interrupts: {
        latestSequence: this.interruptSequence,
        total: this.interruptTotal,
        recent: this.recentInterrupts.map((event) => ({ ...event })),
      },
      control: this.controlLease.status(),
      ...(this.persistentProfile ? { profileName: this.profileName } : {}),
      profilePersistent: this.persistentProfile,
    };
    return status;
  }
  public async listTabs(): Promise<BrowserTabStatus[]> {
    return this.enqueue('page_list_tabs', async () => this.listTabStatuses(), {
      allowPaused: true,
      allowUserControl: true,
      requireReady: false,
    });
  }

  public async switchTab(tabId: string): Promise<BrowserTabStatus> {
    if (typeof tabId !== 'string' || !tabId.trim()) {
      throw new BrowserSessionError('INVALID_ARGUMENT', 'tabId is required');
    }
    return this.enqueue('page_switch_tab', async () => {
      const tab = this.tabs.get(tabId);
      if (!tab) throw new BrowserSessionError('INVALID_ARGUMENT', 'The requested tab does not exist');
      this.activateTab(tab);
      await this.scanChallenge();
      return this.tabStatus(tab);
    });
  }

  public async closeTab(tabId: string): Promise<{ closedTabId: string; tabs: BrowserTabStatus[] }> {
    if (typeof tabId !== 'string' || !tabId.trim()) {
      throw new BrowserSessionError('INVALID_ARGUMENT', 'tabId is required');
    }
    return this.enqueue('page_close_tab', async () => {
      const tab = this.tabs.get(tabId);
      if (!tab) throw new BrowserSessionError('INVALID_ARGUMENT', 'The requested tab does not exist');

      if (this.tabs.size === 1) {
        if (!this.context?.newPage) {
          throw new BrowserSessionError('INVALID_STATE', 'Firefox cannot create a replacement tab');
        }
        const replacement = await this.context.newPage() as unknown as BrowserPageLike;
        const existingReplacement = this.findTabByPage(replacement);
        const replacementTab = existingReplacement ?? this.registerTab(replacement, true);
        if (!existingReplacement) this.installPageObservers(replacement, replacementTab);
        try {
          await tab.page.close?.();
        } catch (error) {
          this.tabs.delete(replacementTab.tabId);
          await replacement.close?.().catch(() => undefined);
          throw error;
        }
        tab.registry.clear();
        tab.snapshotHistory.clear();
        this.tabs.delete(tabId);
        this.activateTab(replacementTab);
      } else {
        await tab.page.close?.();
        tab.registry.clear();
        tab.snapshotHistory.clear();
        this.tabs.delete(tabId);
        if (this.activeTabId === tabId) {
          const replacement = this.tabs.values().next().value as ManagedTab | undefined;
          if (!replacement) throw new BrowserSessionError('INVALID_STATE', 'No active tab remains');
          replacement.isMain = replacement.isMain || tab.isMain;
          this.activateTab(replacement);
        }
      }

      await this.audit({ action: 'page_close_tab', outcome: 'success' });
      return { closedTabId: tabId, tabs: await this.listTabStatuses() };
    });
  }

  public async stop(reason = 'requested'): Promise<BrowserSessionStatus> {
    if (this._state === 'STOPPED') return this.status();
    if (this._state === 'STARTING' && this.startPromise) {
      await this.startPromise.catch(() => undefined);
    }
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      this._state = 'STOPPING';
      this.activeAbort?.abort();
      // Queued actions observe the abort/state gate.  Awaiting the chain gives
      // the current high-level Playwright call a chance to close cleanly.
      let drainTimer: NodeJS.Timeout | undefined;
      await Promise.race([
        this.queueTail.catch(() => undefined),
        new Promise<void>((resolve) => {
          drainTimer = setTimeout(resolve, STOP_DRAIN_TIMEOUT_MS);
        }),
      ]);
      if (drainTimer) clearTimeout(drainTimer);
      await this.persistContextCookies().catch(() => undefined);
      await this.closeContext().catch(() => undefined);
      await this.cleanupOwnedProfile().catch(() => undefined);
      await this.cleanupOwnedArtifacts().catch(() => undefined);
      this.controlLease.dispose();
      this.actionCache.clear();
      this._state = 'STOPPED';
      await this.audit({ action: 'browser_stop', outcome: 'success', reason });
      return this.status();
    })();
    return this.stopPromise;
  }

  public async shutdown(reason = 'shutdown'): Promise<BrowserSessionStatus> {
    return this.stop(reason);
  }

  public async reopenHeaded(): Promise<BrowserSessionStatus> {
    if (this._state !== 'PAUSED_CHALLENGE') {
      throw new BrowserSessionError('INVALID_STATE', 'Headed takeover is available only after a challenge pause');
    }
    return this.enqueue('reopenHeaded', async () => {
      const tabStates = this.captureTabStates();
      await this.closeContext();
      await this.launchContext(false);
      await this.restoreTabStates(tabStates);
      this._state = 'HUMAN_TAKEOVER';
      const detection = await this.scanChallenge(true);
      if (detection.detected) this._state = 'HUMAN_TAKEOVER';
      await this.audit({ action: 'browser_reopen_headed', outcome: 'success' });
      return this.status();
    }, { allowPaused: true, requireReady: false });
  }

  public async resume(humanConfirmed: boolean): Promise<BrowserSessionStatus> {
    if (!humanConfirmed) throw new BrowserSessionError('INVALID_ARGUMENT', 'humanConfirmed must be true');
    if (this._state !== 'HUMAN_TAKEOVER') {
      throw new BrowserSessionError('INVALID_STATE', 'Session must be in human takeover state before resume');
    }
    return this.enqueue('resume', async () => {
      const detection = await this.scanChallenge(true);
      if (detection.detected) {
        this._state = 'PAUSED_CHALLENGE';
        throw new BrowserSessionError('SESSION_PAUSED_CHALLENGE', 'Challenge is still present after human confirmation');
      }
      this.notePageGeneration();
      this._state = 'READY';
      this.challengeDetection = undefined;
      await this.audit({ action: 'browser_resume', outcome: 'success' });
      return this.status();
    }, { allowPaused: true, requireReady: false });
  }

  /** Transfer the headed browser to a person and return a one-time lease token. */
  public async handoff(options: { ttlMs?: number; reason?: string } = {}): Promise<BrowserSessionStatus & { leaseToken: string }> {
    if (this._state !== 'READY' && this._state !== 'PAUSED_CHALLENGE') {
      if (this._state === 'USER_CONTROLLED') {
        throw new BrowserSessionError('MANUAL_TAKEOVER_ACTIVE', 'Manual takeover is active');
      }
      throw new BrowserSessionError('TAKEOVER_UNAVAILABLE', 'Manual takeover is unavailable in the current session state');
    }
    return this.enqueue('browser_handoff', async () => {
      if (this.currentHeadless) {
        const tabStates = this.captureTabStates();
        await this.closeContext();
        await this.launchContext(false);
        await this.restoreTabStates(tabStates);
      }
      const grant = this.controlLease.handoff({
        ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
        ...(options.reason !== undefined ? { reason: options.reason } : {}),
      });
      // browser_handoff is the explicit transition to active user ownership;
      // callers receive the only copy of the token needed to return control.
      this.controlLease.takeover(grant.leaseToken, true);
      this._state = 'USER_CONTROLLED';
      await this.scanChallenge(true);
      await this.audit({ action: 'browser_handoff', outcome: 'success' });
      return { ...this.status(), leaseToken: grant.leaseToken };
    }, { allowPaused: true, allowUserControl: false, requireReady: false, timeoutMs: 60_000 });
  }

  /** Return control to automation after the person explicitly confirms completion. */
  public async takeover(leaseToken: string, humanConfirmed: boolean): Promise<BrowserSessionStatus> {
    if (!humanConfirmed) throw new BrowserSessionError('INVALID_ARGUMENT', 'humanConfirmed must be true');
    if (this._state !== 'USER_CONTROLLED') {
      throw new BrowserSessionError('TAKEOVER_UNAVAILABLE', 'The session is not under manual control');
    }
    return this.enqueue('browser_takeover', async () => {
      const currentUrl = this.page?.url() ?? 'about:blank';
      await this.assertUrlAllowed(currentUrl);
      this.controlLease.release(leaseToken, true);
      this.controlLease.resume();
      this.notePageGeneration();
      this._state = 'READY';
      const detection = await this.scanChallenge();
      if (detection.detected) {
        throw new BrowserSessionError('SESSION_PAUSED_CHALLENGE', 'Challenge is still present after human confirmation');
      }
      this.challengeDetection = undefined;
      await this.audit({ action: 'browser_takeover', outcome: 'success' });
      return this.status();
    }, { allowPaused: true, allowUserControl: true, requireReady: false });
  }

  public async open(url: string, options: ({ waitUntil?: 'domcontentloaded' | 'load'; timeoutMs?: number } & WriteGuardOptions) = {}): Promise<{
    url?: string;
    title?: string;
    pageGeneration: number;
    state: BrowserSessionState;
  }> {
    if (!url || typeof url !== 'string' || url.length > 2_048) {
      throw new BrowserSessionError('INVALID_ARGUMENT', 'A valid absolute URL is required');
    }
    return this.runIdempotentWrite('page_open', {
      url,
      waitUntil: options.waitUntil ?? 'domcontentloaded',
    }, options, () => this.enqueue('page_open', async (signal) => {
      this.assertExpectedPageRevision(options.expectedPageRevision, options.expectedTabId);
      const page = this.requirePage();
      await this.assertUrlAllowed(url);
      try { await (page as any).bringToFront?.(); } catch (_) {}
      const beforeGeneration = this.pageGeneration;
      if (!page.goto) throw new BrowserSessionError('INTERNAL', 'Firefox page does not support navigation');
      try {
        await page.goto(url, {
          waitUntil: options.waitUntil ?? 'domcontentloaded',
          timeout: Math.max(1_000, Math.min(60_000, Math.floor(options.timeoutMs ?? this.defaultTimeoutMs))),
        });
      } catch (error: any) {
        if (this._state === 'PAUSED_CHALLENGE') throw new BrowserSessionError('SESSION_PAUSED_CHALLENGE', 'Challenge detected during navigation');
        const currentUrl = page.url?.();
        const isTimeout = error?.name === 'TimeoutError' || (typeof error?.message === 'string' && error.message.toLowerCase().includes('timeout'));
        const isTargetReached = currentUrl && currentUrl !== 'about:blank' && (
          currentUrl === url || safeHost(currentUrl) === safeHost(url)
        );
        if (isTimeout && isTargetReached) {
          console.warn(`[Navigation] Partial load for ${url} (current: ${currentUrl}): ${error?.message || error}`);
        } else {
          throw new BrowserSessionError('ACTION_TIMEOUT', 'Navigation did not complete', { retryable: true, cause: error });
        }
      }
      if (this.pageGeneration === beforeGeneration) this.notePageGeneration();
      await this.assertUrlAllowed(page.url());
      const detection = await this.scanChallenge();
      if (detection.detected && this.challengePolicy.shouldPause(detection)) throw new BrowserSessionError('SESSION_PAUSED_CHALLENGE', 'Automation paused because a challenge was detected');
      if (signal.aborted) throw new BrowserSessionError('ACTION_TIMEOUT', 'Navigation was aborted', { retryable: true });
      let title: string | undefined;
      try { title = sanitizeTitle(await page.title()); } catch { title = undefined; }
      await this.audit({ action: 'page_open', outcome: 'success', host: safeHost(page.url()) });
      const finalUrl = safeUrl(page.url());
      return {
        ...(finalUrl !== undefined ? { url: finalUrl } : {}),
        ...(title ? { title } : {}),
        pageGeneration: this.pageGeneration,
        state: this._state,
      };
    }, {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    }));
  }

  public async snapshot(options: {
    maxNodes?: number;
    maxChars?: number;
    maxBytes?: number;
    includeText?: boolean;
    format?: 'structured' | 'compact';
    sinceSnapshotId?: string;
    signal?: AbortSignal;
  } = {}): Promise<SemanticSnapshot & { changes?: SnapshotDiff }> {
    if (
      options.maxBytes !== undefined
      && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 100 || options.maxBytes > this.automationPolicy.limits.snapshotMaxSnapshotBytes)
    ) {
      throw new BrowserSessionError(
        'INVALID_ARGUMENT',
        `Snapshot maxBytes must be an integer from 100 to ${this.automationPolicy.limits.snapshotMaxSnapshotBytes}`,
      );
    }
    return this.enqueue('page_snapshot', async () => {
      const page = this.requirePage();
      const tab = this.activeTab;
      if (!tab) throw new BrowserSessionError('INVALID_STATE', 'No active tab is available');
      if (!isReadableState(this._state)) throw new BrowserSessionError('INVALID_STATE', 'Session is not readable');
      const baseSnapshot = await tab.registry.snapshot(page, {
        generation: this.pageGeneration,
        pageGeneration: this.pageGeneration,
        ...(options.maxNodes !== undefined ? { maxNodes: options.maxNodes } : {}),
        ...(options.maxChars !== undefined ? { maxChars: options.maxChars } : {}),
        ...(options.includeText !== undefined ? { includeText: options.includeText } : {}),
      });
      const observed = tab.snapshotHistory.recordWithDiff({
        ...baseSnapshot,
        tabId: tab.tabId,
      }, {
        ...(options.sinceSnapshotId !== undefined ? { sinceSnapshotId: options.sinceSnapshotId } : {}),
      });
      const snapshot = addCompactSnapshotContent(observed.snapshot, {
        ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
        ...(options.format !== undefined ? { format: options.format } : {}),
      }) as SemanticSnapshot & { changes?: SnapshotDiff };
      if (observed.diff !== undefined) snapshot.changes = observed.diff;
      await this.audit({ action: 'page_snapshot', outcome: 'success' });
      return snapshot;
    }, {
      allowPaused: true,
      allowUserControl: true,
      requireReady: false,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  }

  public async extract(schema: ExtractionSchema): Promise<ExtractResult & { pageGeneration: number }> {
    return this.enqueue('page_extract', async () => {
      const page = this.requirePage();
      const result = await extractBatchData(page, schema);
      await this.audit({ action: 'page_extract', outcome: 'success', count: result.count });
      return { ...result, pageGeneration: this.pageGeneration };
    }, {
      allowPaused: true,
      allowUserControl: true,
      requireReady: false,
    });
  }

  public async screenshot(options: { fullPage?: boolean } = {}): Promise<{
    artifactRef: string;
    image: { data: string; mimeType: 'image/png' };
  }> {
    return this.enqueue('page_screenshot', async () => {
      if (!isReadableState(this._state)) throw new BrowserSessionError('INVALID_STATE', 'Session is not readable');
      const page = this.requirePage();
      if (!page.screenshot) throw new BrowserSessionError('INTERNAL', 'Firefox page does not support screenshots');
      await mkdir(this.artifactsDirectory, { recursive: true, mode: 0o700 });
      const artifactRef = `art_${this.sessionId}_${(++this.screenshotSequence).toString(36)}`;
      const filePath = join(this.artifactsDirectory, `${artifactRef}.png`);
      const bytes = await page.screenshot({ fullPage: options.fullPage ?? false });
      if (!Buffer.isBuffer(bytes)) throw new BrowserSessionError('INTERNAL', 'Firefox did not return screenshot bytes');
      if (bytes.byteLength > 8 * 1024 * 1024) {
        throw new BrowserSessionError('RESOURCE_EXHAUSTED', 'Screenshot exceeds the server response limit');
      }
      await writeFile(filePath, bytes, { mode: 0o600 });
      await this.audit({ action: 'page_screenshot', outcome: 'success', artifactRef });
      return {
        artifactRef,
        image: { data: bytes.toString('base64'), mimeType: 'image/png' },
      };
    }, { allowPaused: true, allowUserControl: true, requireReady: false });
  }

  /** Capture user-originated semantic actions in the master page for an opt-in synchronizer. */
  public async observeSyncEvents(handler: (action: { type: 'navigate' | 'click' | 'type' | 'scroll'; url?: string; target?: SemanticTarget; text?: string; deltaY?: number }) => void): Promise<() => void> {
    const page = this.requirePage() as any;
    this.syncEventHandler = handler;
    if (!this.syncCaptureInstalled) {
      this.syncCaptureInstalled = true;
      const binding = `__abs_sync_${this.sessionId.replace(/[^A-Za-z0-9_]/g, '_')}`;
      await page.exposeFunction(binding, (action: unknown) => {
        if (!action || typeof action !== 'object') return;
        this.syncEventHandler?.(action as Parameters<NonNullable<typeof this.syncEventHandler>>[0]);
      });
      const script = syncCaptureScript(binding);
      await (this.context as any)?.addInitScript?.(script);
      await page.evaluate(script).catch(() => undefined);
    }
    return () => { if (this.syncEventHandler === handler) this.syncEventHandler = undefined; };
  }

  public async click(target: string | SemanticTarget, options: ({ timeoutMs?: number } & WriteGuardOptions) = {}): Promise<{ ref: string; pageGeneration: number }> {
    return this.runIdempotentWrite('page_click', { target }, options, () => this.enqueue('page_click', async (signal) => {
      this.assertExpectedPageRevision(options.expectedPageRevision, options.expectedTabId);
      const resolved = await this.resolveActionTarget(target);
      await this.scheduler.click(resolved.locator as SchedulerLocatorLike, { button: 'left' }, signal);
      const detection = await this.scanChallenge();
      if (detection.detected) throw new BrowserSessionError('SESSION_PAUSED_CHALLENGE', 'Automation paused because a challenge was detected');
      await this.audit({ action: 'page_click', outcome: 'success', target: { role: resolved.metadata.role } });
      return { ref: targetRef(target), pageGeneration: this.pageGeneration };
    }, {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    }));
  }

  public async type(
    target: string | SemanticTarget,
    text: string,
    options: ({ clearFirst?: boolean; submit?: boolean; sensitive?: boolean; timeoutMs?: number } & WriteGuardOptions) = {},
  ): Promise<{ ref: string; length: number; pageGeneration: number }> {
    if (typeof text !== 'string' || text.length > 10_000) throw new BrowserSessionError('INVALID_ARGUMENT', 'Text is too long or invalid');
    return this.runIdempotentWrite('page_type', {
      target,
      text,
      clearFirst: Boolean(options.clearFirst),
      submit: Boolean(options.submit),
      sensitive: Boolean(options.sensitive),
    }, options, () => this.enqueue('page_type', async (signal) => {
      this.assertExpectedPageRevision(options.expectedPageRevision, options.expectedTabId);
      const resolved = await this.resolveActionTarget(target);
      if (resolved.metadata.editable === false || ['button', 'link', 'checkbox'].includes(resolved.metadata.role)) {
        throw new BrowserSessionError('TARGET_NOT_ACTIONABLE', 'Target is not an editable control');
      }
      if (options.clearFirst) {
        const clearable = resolved.locator as RegistryLocatorLike & { fill?: (value: string) => Promise<void> };
        if (clearable.fill) await clearable.fill('');
      }
      await this.scheduler.typeText(resolved.locator as SchedulerLocatorLike, text, Boolean(options.sensitive), signal);
      if (options.submit) {
        const detection = await this.scanChallenge();
        if (detection.detected) throw new BrowserSessionError('SESSION_PAUSED_CHALLENGE', 'Challenge detected before submit');
        const pressable = resolved.locator as RegistryLocatorLike & { press?: (key: string) => Promise<void> };
        if (!pressable.press) throw new BrowserSessionError('TARGET_NOT_ACTIONABLE', 'Target cannot submit with Enter');
        await pressable.press('Enter');
      }
      const detection = await this.scanChallenge();
      if (detection.detected) throw new BrowserSessionError('SESSION_PAUSED_CHALLENGE', 'Automation paused because a challenge was detected');
      // Only the length is retained; callers may mark the input sensitive and
      // the audit layer never receives the text itself.
      await this.audit({ action: 'page_type', outcome: 'success', target: { role: resolved.metadata.role }, length: text.length });
      return { ref: targetRef(target), length: text.length, pageGeneration: this.pageGeneration };
    }, {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    }));
  }

  public async select(target: string | SemanticTarget, choice: BrowserSelectChoice, options: ({ timeoutMs?: number } & WriteGuardOptions) = {}): Promise<{ ref: string; pageGeneration: number }> {
    const selection = typeof choice === 'string' ? { value: choice } : choice;
    if (!selection || typeof selection !== 'object') {
      throw new BrowserSessionError('INVALID_ARGUMENT', 'Select value is invalid');
    }
    const hasValue = 'value' in selection && typeof selection.value === 'string';
    const hasLabel = 'label' in selection && typeof selection.label === 'string';
    const selectedText = hasValue ? selection.value : hasLabel ? selection.label : undefined;
    if (hasValue === hasLabel || !selectedText || selectedText.length > 1_000) {
      throw new BrowserSessionError('INVALID_ARGUMENT', 'Select requires exactly one bounded value or label');
    }
    return this.runIdempotentWrite('page_select', { target, selection }, options, () => this.enqueue('page_select', async (signal) => {
      this.assertExpectedPageRevision(options.expectedPageRevision, options.expectedTabId);
      const resolved = await this.resolveActionTarget(target);
      if (!['combobox', 'listbox'].includes(resolved.metadata.role) && resolved.metadata.tag !== 'select') {
        throw new BrowserSessionError('TARGET_NOT_ACTIONABLE', 'Target is not a select control');
      }
      await this.scheduler.selectOption(resolved.locator as SchedulerLocatorLike, selection, signal);
      const detection = await this.scanChallenge();
      if (detection.detected) throw new BrowserSessionError('SESSION_PAUSED_CHALLENGE', 'Automation paused because a challenge was detected');
      await this.audit({ action: 'page_select', outcome: 'success', target: { role: resolved.metadata.role } });
      return { ref: targetRef(target), pageGeneration: this.pageGeneration };
    }, {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    }));
  }

  public async scroll(
    direction: Direction,
    amount: number = 1,
    ref?: string | SemanticTarget,
    options: WriteGuardOptions = {},
  ): Promise<{ direction: Direction; amount: number; pageGeneration: number }> {
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > this.automationPolicy.limits.maxScrollAmount) {
      throw new BrowserSessionError('INVALID_ARGUMENT', `Scroll amount must be an integer from 1 to ${this.automationPolicy.limits.maxScrollAmount}`);
    }
    return this.runIdempotentWrite('page_scroll', { direction, amount, ref }, options, () => this.enqueue('page_scroll', async (signal) => {
      this.assertExpectedPageRevision(options.expectedPageRevision, options.expectedTabId);
      const page = this.requirePage();
      if (!page) throw new BrowserSessionError('INVALID_STATE', 'No active page is available');
      await this.scheduler.scroll(direction, amount, signal, page as SchedulerPageLike);
      const detection = await this.scanChallenge();
      if (detection.detected) throw new BrowserSessionError('SESSION_PAUSED_CHALLENGE', 'Automation paused because a challenge was detected');
      await this.audit({ action: 'page_scroll', outcome: 'success', direction, amount });
      return { direction, amount, pageGeneration: this.pageGeneration };
    }, options.signal === undefined ? {} : { signal: options.signal }));
  }

  public async wait(request: BrowserWaitRequest | number): Promise<{ waitedMs: number; conditionMet?: boolean }> {
    const normalized: BrowserWaitRequest = typeof request === 'number' ? { durationMs: request } : request;
    if (normalized.durationMs === undefined && !normalized.condition && !normalized.target) {
      throw new BrowserSessionError('INVALID_ARGUMENT', 'Wait requires durationMs, target, or a semantic condition');
    }
    return this.enqueue('page_wait', async (signal) => {
      const targetLocator = normalized.target !== undefined && typeof normalized.target !== 'string'
        ? (await this.resolveActionTarget(normalized.target, false)).locator as RegistryLocatorLike
        : undefined;
      const targetRef = typeof normalized.target === 'string' ? normalized.target : undefined;
      const condition = normalized.condition ?? (targetRef === undefined ? undefined : { ref: targetRef, state: 'visible' as const });
      const timeout = Math.max(50, Math.min(10_000, Math.floor(normalized.timeoutMs ?? normalized.durationMs ?? 10_000)));
      const start = Date.now();
      if (normalized.durationMs !== undefined) {
        const requested = Math.max(50, Math.min(10_000, Math.floor(normalized.durationMs)));
        let elapsed = 0;
        while (elapsed < requested) {
          if (signal.aborted) throw new BrowserSessionError('ACTION_TIMEOUT', 'Wait was aborted', { retryable: true });
          const step = Math.min(100, requested - elapsed);
          await schedulerDelay(step, signal);
          elapsed += step;
          const preservePause = this._state === 'PAUSED_CHALLENGE'
            || this._state === 'HUMAN_TAKEOVER'
            || this._state === 'USER_CONTROLLED';
          const detection = await this.scanChallenge(preservePause);
          if (detection.detected && !preservePause) {
            throw new BrowserSessionError('SESSION_PAUSED_CHALLENGE', 'Automation paused because a challenge was detected');
          }
        }
        return { waitedMs: Date.now() - start };
      }

      if (!condition && !targetLocator) throw new BrowserSessionError('INVALID_ARGUMENT', 'Wait condition is missing');
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        try {
          const locator = targetLocator ?? (condition === undefined
            ? undefined
            : (await this.resolveRef(condition.ref, false)).locator as RegistryLocatorLike);
          if (!locator) throw new BrowserSessionError('INVALID_ARGUMENT', 'Wait condition is missing');
          const state = condition?.state ?? 'visible';
          const value = state === 'visible'
            ? locator.isVisible ? await locator.isVisible() : true
            : state === 'enabled'
              ? locator.isEnabled ? await locator.isEnabled() : true
              : locator.isVisible ? !(await locator.isVisible()) : false;
          if (value) return { waitedMs: Date.now() - start, conditionMet: true };
        } catch (error) {
          if (!(error instanceof TargetRegistryError) || condition?.state !== 'hidden') throw browserErrorFromTarget(error);
          return { waitedMs: Date.now() - start, conditionMet: true };
        }
        await schedulerDelay(50, signal);
        const preservePause = this._state === 'PAUSED_CHALLENGE'
          || this._state === 'HUMAN_TAKEOVER'
          || this._state === 'USER_CONTROLLED';
        const detection = await this.scanChallenge(preservePause);
        if (detection.detected && !preservePause) {
          throw new BrowserSessionError('SESSION_PAUSED_CHALLENGE', 'Automation paused because a challenge was detected');
        }
      }
      throw new BrowserSessionError('ACTION_TIMEOUT', 'Wait condition did not complete', { retryable: true });
    }, {
      allowPaused: true,
      allowUserControl: true,
      requireReady: false,
      ...(normalized.signal !== undefined ? { signal: normalized.signal } : {}),
    });
  }

  /** Execute a finite declarative workflow while reserving this session. */
  public workflow(
    definition: WorkflowDefinition,
    options: Pick<WorkflowExecutionOptions, 'actionId' | 'expectedPageRevision' | 'expectedTabId' | 'maxDurationMs' | 'maxResultBytes' | 'signal'> = {},
  ): Promise<WorkflowRunnerResult> {
    const expectedTabId = options.expectedTabId ?? definition.expectedTabId;
    const guards: WriteGuardOptions = {
      ...(options.actionId !== undefined ? { actionId: options.actionId } : {}),
      ...(options.expectedPageRevision !== undefined ? { expectedPageRevision: options.expectedPageRevision } : {}),
      ...(expectedTabId !== undefined ? { expectedTabId } : {}),
    };
    return this.runIdempotentWrite('page_workflow', {
      steps: definition.steps,
      maxDurationMs: options.maxDurationMs ?? definition.maxDurationMs,
      maxResultBytes: options.maxResultBytes ?? definition.maxResultBytes,
    }, guards, async () => {
      if (this.activeWorkflowToken !== undefined) {
        throw new BrowserSessionError('SESSION_BUSY', 'Another workflow is already active', { retryable: true });
      }
      this.assertExpectedPageRevision(options.expectedPageRevision ?? definition.expectedPageRevision, expectedTabId);
      const token = Symbol('browser-workflow');
      this.activeWorkflowToken = token;
      const { actionId: _actionId, expectedPageRevision: _revision, expectedTabId: _tabId, ...safeDefinition } = definition;
      try {
        const result = await this.workflowContext.run(token, () => this.workflowExecutor.run(safeDefinition, {
          ...((options.expectedPageRevision ?? definition.expectedPageRevision) !== undefined
            ? { expectedPageRevision: options.expectedPageRevision ?? definition.expectedPageRevision }
            : {}),
          ...(expectedTabId !== undefined ? { expectedTabId } : {}),
          ...(options.maxDurationMs !== undefined ? { maxDurationMs: options.maxDurationMs } : {}),
          ...(options.maxResultBytes !== undefined ? { maxResultBytes: options.maxResultBytes } : {}),
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        }));
        await this.audit({ action: 'page_workflow', outcome: result.ok ? 'success' : 'stopped', stopReason: result.stopReason });
        return result;
      } catch (error) {
        if (error instanceof WorkflowValidationError) {
          const code = error.code === 'WORKFLOW_STEP_LIMIT_EXCEEDED'
            ? 'WORKFLOW_STEP_LIMIT_EXCEEDED'
            : 'INVALID_ARGUMENT';
          throw new BrowserSessionError(code, 'The workflow is invalid', {
            details: { path: error.path },
            cause: error,
          });
        }
        throw error;
      } finally {
        if (this.activeWorkflowToken === token) this.activeWorkflowToken = undefined;
      }
    });
  }

  public async challengeStatus(): Promise<BrowserSessionStatus['challenge']> {
    if (this.page && isReadableState(this._state)) await this.scanChallenge();
    return this.status().challenge;
  }

  private resolveFingerprintProfile(): UnifiedFingerprintProfile | undefined {
    if (!this.options.fingerprint) return undefined;
    const profile = (typeof this.options.fingerprint === 'object'
      ? this.options.fingerprint
      : generateFingerprint({
          seed: this.options.fingerprintSeed ?? this.options.seed,
          engine: this.engine,
          countryCode: this.options.countryCode,
        })) as UnifiedFingerprintProfile;

    if (typeof this.options.fingerprint === 'object' && profile.engine !== this.engine) {
      throw new BrowserSessionError(
        'INVALID_ARGUMENT',
        `Fingerprint engine ${profile.engine} does not match session engine ${this.engine}`,
      );
    }

    const managedIdentity = managedBrowserIdentity(this.engine);
    if (profile.browserVersion !== managedIdentity.fullVersion) {
      throw new BrowserSessionError(
        'INVALID_ARGUMENT',
        `Fingerprint browser version ${profile.browserVersion ?? 'unknown'} does not match managed ${this.engine} ${managedIdentity.fullVersion}`,
      );
    }

    const userAgent = this.options.userAgent ?? profile.userAgent;
    const userAgentVersion = browserVersionFromUserAgent(userAgent, this.engine);
    if (userAgentVersion?.split('.')[0] !== managedIdentity.majorVersion) {
      throw new BrowserSessionError(
        'INVALID_ARGUMENT',
        `User-Agent must identify managed ${this.engine} major version ${managedIdentity.majorVersion}`,
      );
    }
    const locale = this.options.locale ?? profile.geo.locale;
    const languages = this.options.locale
      ? [this.options.locale]
      : [...profile.geo.languages];
    const timezoneId = this.options.timezoneId ?? profile.geo.timezoneId;
    const geolocation = this.options.geolocation ?? profile.geo.geolocation;
    return {
      ...profile,
      userAgent,
      appVersion: userAgent.replace(/^Mozilla\//, ''),
      ...(this.options.viewport
        ? { viewport: { width: this.options.viewport.width, height: this.options.viewport.height } }
        : {}),
      geo: {
        ...profile.geo,
        timezoneId,
        locale,
        languages,
        geolocation: {
          ...geolocation,
          accuracy: geolocation.accuracy ?? profile.geo.geolocation.accuracy,
        },
      },
    };
  }

  private async launchContext(headless: boolean): Promise<void> {
    if (headless && this.engine === 'chromium' && this.options.managedExtensions?.length) {
      throw new BrowserSessionError('INVALID_STATE', 'Managed Chromium extensions require a headed browser session');
    }
    if (this.engine === 'chromium' && this.options.cdpEndpoint && this.options.managedExtensions?.length) {
      throw new BrowserSessionError('INVALID_STATE', 'Managed extensions cannot be injected into an already-running CDP browser');
    }
    const fpConfig = this.resolveFingerprintProfile();
    if (this.options.userAgent && !fpConfig) {
      throw new BrowserSessionError(
        'INVALID_STATE',
        'A custom User-Agent requires a managed fingerprint profile so Client Hints and engine surfaces stay aligned',
      );
    }
    if (this.engine === 'chromium' && this.options.cdpEndpoint && (fpConfig || this.options.userAgent)) {
      throw new BrowserSessionError(
        'INVALID_STATE',
        'Managed fingerprint and User-Agent profiles cannot be applied to an externally versioned CDP browser',
      );
    }
    const initScript = fpConfig ? buildStealthInjectionScript(fpConfig) : undefined;
    const extraHTTPHeaders = this.options.extraHTTPHeaders ?? (fpConfig
      ? { 'Accept-Language': fpConfig.geo.languages.join(',') }
      : undefined);
    const launchOptions: FirefoxLaunchOptions = {
      headless,
      viewport: this.options.viewport ?? (fpConfig ? fpConfig.viewport : undefined),
      ...(this.options.proxy ? { proxy: this.options.proxy } : {}),
      timezoneId: this.options.timezoneId ?? fpConfig?.geo.timezoneId,
      locale: this.options.locale ?? fpConfig?.geo.locale,
      geolocation: this.options.geolocation ?? fpConfig?.geo.geolocation,
      permissions: this.options.permissions ?? ['geolocation'],
      ...(extraHTTPHeaders ? { extraHTTPHeaders } : {}),
      userAgent: this.options.userAgent ?? fpConfig?.userAgent,
      ...(initScript ? { initScript } : {}),
      ...(this.options.managedExtensions !== undefined ? { managedExtensions: this.options.managedExtensions } : {}),
      ...(fpConfig !== undefined ? { fingerprintProfile: fpConfig } : {}),
    };
    if (this.engine === 'chromium' && this.options.cdpEndpoint !== undefined) {
      const launcher = (this.options.launcher ?? defaultChromiumLauncher) as unknown as { connectOverCDP?: (endpoint: string) => Promise<FirefoxContextLike> };
      if (!launcher.connectOverCDP) throw new BrowserSessionError('BROWSER_LAUNCH_FAILED', 'Chromium launcher cannot attach over CDP');
      this.context = await launcher.connectOverCDP(this.options.cdpEndpoint);
      if (initScript && this.context.addInitScript) await this.context.addInitScript(initScript);
    } else {
      const launcher = this.engine === 'chromium' ? defaultChromiumLauncher : this.launcher;
      this.context = await launcher.launchPersistentContext(this.profileDirectory, launchOptions);
    }
    this.currentHeadless = headless;
    this.context.setDefaultTimeout?.(this.defaultTimeoutMs);
    this.context.setDefaultNavigationTimeout?.(this.defaultTimeoutMs);
    const pages = this.context.pages?.() ?? [];
    const retainedPages = pages.slice(0, this.maxTabs) as unknown as BrowserPageLike[];
    for (const extra of pages.slice(this.maxTabs)) await extra.close?.().catch(() => undefined);
    if (retainedPages.length === 0 && this.context.newPage) {
      retainedPages.push(await this.context.newPage() as unknown as BrowserPageLike);
    }
    const [mainPage] = retainedPages;
    if (!mainPage) throw new BrowserSessionError('BROWSER_LAUNCH_FAILED', 'Firefox did not provide a page');
    if (!headless && typeof mainPage.bringToFront === 'function') {
      await mainPage.bringToFront().catch(() => undefined);
    }
    if (initScript) {
      if (typeof this.context.addInitScript === 'function') {
        await this.context.addInitScript(initScript).catch(() => undefined);
      }
      for (const p of retainedPages) {
        if (typeof (p as any).addInitScript === 'function') {
          await (p as any).addInitScript(initScript).catch(() => undefined);
        }
      }
    }

    this.tabs.clear();
    this.activeTabId = undefined;
    this.page = undefined;
    const mainTab = this.registerTab(mainPage, true);
    this.activateTab(mainTab);
    for (const tabPage of retainedPages.slice(1)) this.registerTab(tabPage, false);

    await this.installContextGuards(this.context);
    for (const tab of this.tabs.values()) this.installPageObservers(tab.page, tab);
  }
  private captureTabStates(): TabRestoreState[] {
    const states: TabRestoreState[] = [];
    for (const tab of this.tabs.values()) {
      let url = 'about:blank';
      try {
        const candidate = tab.page.url();
        if (candidate.length <= 8_192) url = candidate;
      } catch {
        // A closing/crashed page is restored as a blank tab below.
      }
      states.push({
        url,
        isMain: tab.isMain,
        active: tab.tabId === this.activeTabId,
      });
    }
    return states.length > 0
      ? states
      : [{ url: 'about:blank', isMain: true, active: true }];
  }

  private async restoreTabStates(states: readonly TabRestoreState[]): Promise<void> {
    const context = this.context;
    const initialMain = this.activeTab;
    if (!context || !initialMain) throw new BrowserSessionError('BROWSER_LAUNCH_FAILED', 'Firefox did not provide a replacement page');

    for (const tab of [...this.tabs.values()]) {
      if (tab === initialMain) continue;
      tab.registry.clear();
      tab.snapshotHistory.clear();
      await tab.page.close?.().catch(() => undefined);
      this.tabs.delete(tab.tabId);
    }
    initialMain.isMain = true;
    const mainState = states.find((state) => state.isMain) ?? states[0] ?? { url: 'about:blank', isMain: true, active: true };
    const orderedStates = [
      mainState,
      ...states.filter((state) => state !== mainState),
    ].slice(0, this.maxTabs);
    const restoredTabs: ManagedTab[] = [initialMain];
    await this.restoreTabPage(initialMain, mainState.url);
    for (const state of orderedStates.slice(1)) {
      if (!context.newPage) throw new BrowserSessionError('BROWSER_LAUNCH_FAILED', 'Firefox cannot restore all open tabs');
      const page = await context.newPage() as unknown as BrowserPageLike;
      const tab = this.registerTab(page, false);
      this.installPageObservers(page, tab);
      await this.restoreTabPage(tab, state.url);
      restoredTabs.push(tab);
    }

    const activeIndex = orderedStates.findIndex((state) => state.active);
    this.activateTab(restoredTabs[activeIndex >= 0 ? activeIndex : 0] ?? initialMain);
  }

  private async restoreTabPage(tab: ManagedTab, url: string): Promise<void> {
    if (url === 'about:blank') return;
    await this.assertUrlAllowed(url);
    if (!tab.page.goto) throw new BrowserSessionError('BROWSER_LAUNCH_FAILED', 'Firefox page cannot restore navigation');
    const beforeRevision = tab.pageRevision;
    await tab.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (tab.pageRevision === beforeRevision) this.notePageGeneration(tab);
    await this.assertUrlAllowed(tab.page.url());
  }


  private async installContextGuards(context: FirefoxContextLike): Promise<void> {
    const onContext = context.on?.bind(context);
    if (onContext) {
      onContext('page', (...args: unknown[]) => {
        const popup = args[0] as BrowserPageLike | undefined;
        if (popup && this.findTabByPage(popup) === undefined) void this.handlePopup(popup);
      });
    }
    if (!context.route) {
      throw new BrowserSessionError('BROWSER_LAUNCH_FAILED', 'Firefox context cannot enforce the resource URL policy');
    }
    // Route registration is a startup barrier. Declaring READY before this
    // promise settles would let the first navigation race ahead of
    // allowlist/SSRF enforcement; swallowing a registration error would run
    // the whole session without that guard.
    await context.route('**/*', async (...args: unknown[]) => {
      const route = args[0] as RouteLike;
      try {
        const request = route.request();
        const requestUrl = request.url();
        await this.assertUrlAllowed(requestUrl, { resource: request.isNavigationRequest?.() !== true });
        await route.continue();
      } catch (error) {
        if (route.abort) await route.abort('blockedbyclient').catch(() => undefined);
        else throw error;
      }
    });
  }

  private installPageObservers(page: BrowserPageLike, tab?: ManagedTab): void {
    const on = page.on?.bind(page);
    if (!on) return;
    on('popup', (...args: unknown[]) => {
      const popup = args[0] as BrowserPageLike | undefined;
      if (popup && this.findTabByPage(popup) === undefined) void this.handlePopup(popup);
    });
    on('dialog', (...args: unknown[]) => {
      const dialog = args[0] as DialogLike | undefined;
      if (dialog) {
        this.recordInterrupt('DIALOG_BLOCKED');
        void dialog.dismiss().catch(() => undefined);
      }
    });
    on('download', (...args: unknown[]) => {
      const download = args[0] as DownloadLike | undefined;
      if (download) {
        this.recordInterrupt('DOWNLOAD_BLOCKED');
        void download.cancel().catch(() => undefined);
      }
    });
    on('framenavigated', () => this.notePageGeneration(tab));
    on('domcontentloaded', () => this.scheduleChallengeScan(tab));
    on('load', () => this.scheduleChallengeScan(tab));
    on('frameattached', () => this.scheduleChallengeScan(tab));
    on('crash', () => {
      this.recordInterrupt('PAGE_CRASHED');
      if (tab === undefined || tab.tabId === this.activeTabId) {
        this._state = 'ERROR';
        this.activeAbort?.abort();
      }
    });
  }
  private registerTab(page: BrowserPageLike, isMain: boolean): ManagedTab {
    const existing = this.findTabByPage(page);
    if (existing) {
      existing.isMain = existing.isMain || isMain;
      return existing;
    }
    const tabId = this.newTabId();
    const tab: ManagedTab = {
      tabId,
      page,
      registry: new TargetRegistry({ sessionId: this.sessionId }),
      snapshotHistory: new SnapshotHistory({
        sessionId: `${this.sessionId}_${tabId}`,
        maxSnapshots: this.automationPolicy.limits.snapshotMaxSnapshots,
        ttlMs: this.automationPolicy.limits.snapshotTtlMs,
        maxBytes: this.automationPolicy.limits.snapshotMaxBytes,
        maxSnapshotBytes: this.automationPolicy.limits.snapshotMaxSnapshotBytes,
        now: () => this.options.now?.().getTime() ?? Date.now(),
      }),
      isMain,
      createdAt: this.options.now?.().getTime() ?? Date.now(),
      pageRevision: 0,
    };
    tab.registry.setGeneration(tab.pageRevision);
    this.tabs.set(tab.tabId, tab);
    return tab;
  }
  private newTabId(): string {
    this.tabSequence += 1;
    return `tab_${this.tabSequence.toString(36)}`;
  }

  private findTabByPage(page: BrowserPageLike): ManagedTab | undefined {
    for (const tab of this.tabs.values()) {
      if (tab.page === page) return tab;
    }
    return undefined;
  }

  private activateTab(tab: ManagedTab): void {
    this.activeTabId = tab.tabId;
    this.page = tab.page;
    this.pageGeneration = tab.pageRevision;
    this.scheduler.setPage(tab.page as SchedulerPageLike);
  }

  private async listTabStatuses(): Promise<BrowserTabStatus[]> {
    const statuses: BrowserTabStatus[] = [];
    for (const tab of this.tabs.values()) statuses.push(await this.tabStatus(tab));
    return statuses;
  }

  private async tabStatus(tab: ManagedTab): Promise<BrowserTabStatus> {
    let url: string | undefined;
    try {
      url = safeUrl(tab.page.url());
    } catch {
      url = undefined;
    }
    let title: string | undefined;
    try {
      title = sanitizeTitle(await tab.page.title());
    } catch {
      title = undefined;
    }
    return {
      tabId: tab.tabId,
      isMain: tab.isMain,
      active: tab.tabId === this.activeTabId,
      createdAt: tab.createdAt,
      pageRevision: tab.pageRevision,
      ...(url !== undefined ? { url } : {}),
      ...(title !== undefined ? { title } : {}),
    };
  }

  private handlePopup(popup: BrowserPageLike): Promise<void> {
    // A malformed/non-Playwright popup cannot be policy-checked. Reject it
    // synchronously so interrupt ordering remains deterministic for callers.
    if (typeof popup.url !== 'function') {
      if (this.recordPopupBlocked(popup)) void popup.close?.().catch(() => undefined);
      return Promise.resolve();
    }
    const admission = this.popupAdmissionTail.then(
      () => this.admitPopup(popup),
      () => this.admitPopup(popup),
    );
    this.popupAdmissionTail = admission.then(() => undefined, () => undefined);
    return admission;
  }

  private async admitPopup(popup: BrowserPageLike): Promise<void> {
    if (this._state === 'STOPPING' || this._state === 'STOPPED' || this._state === 'ERROR') {
      this.blockedPopups.add(popup);
      await popup.close?.().catch(() => undefined);
      return;
    }
    if (this.tabs.size >= this.maxTabs) {
      this.blockedPopups.add(popup);
      this.recordInterrupt('TAB_LIMIT_EXCEEDED');
      await popup.close?.().catch(() => undefined);
      return;
    }
    let popupUrl = 'about:blank';
    try {
      popupUrl = popup.url();
      await this.assertUrlAllowed(popupUrl);
    } catch {
      this.recordPopupBlocked(popup);
      await popup.close?.().catch(() => undefined);
      return;
    }
    const tab = this.registerTab(popup, false);
    this.installPageObservers(popup, tab);
    await this.audit({
      action: 'page_popup',
      outcome: 'accepted',
      ...(safeHost(popupUrl) ? { host: safeHost(popupUrl) } : {}),
    });
  }

  private scheduleChallengeScan(tab?: ManagedTab): void {
    if (!this.page || this._state === 'STOPPING' || this._state === 'STOPPED') return;
    if (tab !== undefined && tab.tabId !== this.activeTabId) return;
    void this.scanChallenge().catch(() => undefined);
  }

  private notePageGeneration(tab?: ManagedTab): void {
    const target = tab ?? this.activeTab;
    if (!target) {
      this.pageGeneration += 1;
      this.fallbackRegistry.setGeneration(this.pageGeneration);
      return;
    }
    target.pageRevision += 1;
    target.registry.setGeneration(target.pageRevision);
    if (target.tabId === this.activeTabId) this.pageGeneration = target.pageRevision;
  }

  private async scanChallenge(preserveTakeover = false): Promise<ChallengeDetection> {
    if (!this.page) return { detected: false, signals: [], observedAt: new Date().toISOString() };
    const detection = await this.detector.detectPage(this.page);
    if (detection.detected) {
      const firstDetection = this.challengeDetection?.detected !== true;
      this.challengeDetection = detection;
      if (this.challengePolicy.shouldPause(detection) && !preserveTakeover && this._state !== 'HUMAN_TAKEOVER' && this._state !== 'USER_CONTROLLED' && this._state !== 'STOPPING' && this._state !== 'STOPPED') {
        this._state = 'PAUSED_CHALLENGE';
        this.activeAbort?.abort();
      }
      if (firstDetection) {
        await this.audit({
          action: 'challenge_detected',
          outcome: 'paused',
          ...(detection.category ? { category: detection.category } : {}),
        });
      }
    } else {
      this.challengeDetection = undefined;
    }
    return detection;
  }

  private requirePage(): BrowserPageLike {
    if (!this.page || !this.context || this._state === 'STOPPED' || this._state === 'ERROR') {
      throw new BrowserSessionError('SESSION_NOT_FOUND', 'Browser session is not running');
    }
    return this.page;
  }

  private async resolveRef(ref: string, requireActionable = true) {
    if (typeof ref !== 'string' || ref.length > 100) throw new BrowserSessionError('INVALID_ARGUMENT', 'Target ref is invalid');
    try {
      return await this.registry.resolve(ref, {
        page: this.requirePage(),
        generation: this.pageGeneration,
        requireActionable,
      });
    } catch (error) {
      throw browserErrorFromTarget(error);
    }
  }

  private async assertUrlAllowed(url: string, context: { resource?: boolean } = {}): Promise<void> {
    if (!isResourceProtocolAllowed(url)) throw new BrowserSessionError('NAVIGATION_DENIED', 'Only HTTP(S) navigation is allowed');
    if (url.startsWith('about:')) return;
    if (!this.options.urlPolicy) {
      return;
    }
    try {
      let decision: unknown;
      if (this.options.urlPolicy.assertAllowed) decision = await this.options.urlPolicy.assertAllowed(url, context);
      else if (this.options.urlPolicy.check) decision = await this.options.urlPolicy.check(url, context);
      else if (this.options.urlPolicy.isAllowed) decision = await this.options.urlPolicy.isAllowed(url, context);
      else return;
      if (decision === false || (typeof decision === 'object' && decision !== null && 'allowed' in decision && !(decision as { allowed: boolean }).allowed)) {
        throw new BrowserSessionError('NAVIGATION_DENIED', 'Navigation is outside the approved URL policy');
      }
    } catch (error) {
      if (error instanceof BrowserSessionError) throw error;
      const code = /private|loopback|metadata|network/i.test(String((error as Error)?.message ?? ''))
        ? 'PRIVATE_NETWORK_DENIED'
        : 'NAVIGATION_DENIED';
      throw new BrowserSessionError(code, 'Navigation was denied by the URL policy', { cause: error });
    }
  }

  private assertExpectedPageRevision(expected: number | undefined, expectedTabId?: string): void {
    if (expectedTabId !== undefined && (
      expectedTabId.length === 0
      || expectedTabId.length > 100
      || /[\u0000-\u001f\u007f]/u.test(expectedTabId)
    )) {
      throw new BrowserSessionError('INVALID_ARGUMENT', 'expectedTabId must be a bounded opaque string');
    }
    if (expectedTabId !== undefined && expectedTabId !== this.activeTabId) {
      throw new BrowserSessionError('PAGE_REVISION_MISMATCH', 'The active tab changed; obtain a fresh snapshot.', {
        retryable: true,
        details: {
          expectedTabId,
          ...(this.activeTabId !== undefined ? { actualTabId: this.activeTabId } : {}),
        },
      });
    }
    if (expected === undefined) return;
    if (!Number.isSafeInteger(expected) || expected < 0) {
      throw new BrowserSessionError('INVALID_ARGUMENT', 'expectedPageRevision must be a non-negative integer');
    }
    if (expected !== this.pageGeneration) {
      throw new BrowserSessionError('PAGE_REVISION_MISMATCH', 'The page changed; obtain a fresh snapshot.', {
        retryable: true,
        details: {
          expectedPageRevision: expected,
          actualPageRevision: this.pageGeneration,
          ...(expectedTabId !== undefined ? { expectedTabId } : {}),
          ...(this.activeTabId !== undefined ? { actualTabId: this.activeTabId } : {}),
        },
      });
    }
  }

  private runIdempotentWrite<T>(
    action: string,
    identity: unknown,
    options: WriteGuardOptions,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this._state === 'USER_CONTROLLED') {
      return Promise.reject(new BrowserSessionError('USER_CONTROL_HARD_STOP', 'User control is active; automation writes are blocked'));
    }
    const actionId = options.actionId;
    if (actionId === undefined) return operation();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(actionId)) {
      return Promise.reject(new BrowserSessionError('INVALID_ARGUMENT', 'actionId must be a UUID'));
    }
    const now = this.actionCacheNow();
    this.pruneActionCache(now);
    const fingerprint = createHash('sha256')
      .update(stableJson({
        action,
        identity,
        expectedPageRevision: options.expectedPageRevision,
        expectedTabId: options.expectedTabId,
      }))
      .digest('hex');
    const existing = this.actionCache.get(actionId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(new BrowserSessionError('ACTION_ID_CONFLICT', 'The action id was already used with different input'));
      }
      return existing.result as Promise<T>;
    }
    const result = operation();
    this.actionCache.set(actionId, {
      fingerprint,
      expiresAt: now + ACTION_CACHE_TTL_MS,
      result,
    });
    while (this.actionCache.size > MAX_ACTION_CACHE) {
      const oldest = this.actionCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.actionCache.delete(oldest);
    }
    return result;
  }

  private actionCacheNow(): number {
    return this.options.now?.().getTime() ?? Date.now();
  }

  private createControlLease(): ControlLeaseManager {
    return new ControlLeaseManager({
      ttlMs: 5 * 60_000,
      maxTtlMs: 15 * 60_000,
      now: () => this.options.now?.().getTime() ?? Date.now(),
    });
  }

  private pruneActionCache(now: number): void {
    for (const [actionId, entry] of this.actionCache) {
      if (entry.expiresAt <= now) this.actionCache.delete(actionId);
    }
  }

  private recordInterrupt(type: BrowserInterruptType): void {
    const event: BrowserInterrupt = {
      sequence: ++this.interruptSequence,
      type,
      observedAt: (this.options.now ?? (() => new Date()))().toISOString(),
    };
    this.interruptTotal += 1;
    this.recentInterrupts.push(event);
    if (this.recentInterrupts.length > MAX_RECENT_INTERRUPTS) this.recentInterrupts.shift();
    void this.audit({ action: 'browser_interrupt', outcome: 'blocked', interruptType: type }).catch(() => undefined);
  }

  private recordPopupBlocked(popup: object): boolean {
    if (this.blockedPopups.has(popup)) return false;
    this.blockedPopups.add(popup);
    this.recordInterrupt('POPUP_BLOCKED');
    return true;
  }

  private enqueue<T>(
    action: string,
    operation: (signal: AbortSignal) => Promise<T>,
    options: { allowPaused?: boolean; allowUserControl?: boolean; requireReady?: boolean; timeoutMs?: number | undefined; signal?: AbortSignal } = {},
  ): Promise<T> {
    const workflowToken = this.workflowContext.getStore();
    if (this.activeWorkflowToken !== undefined && workflowToken !== this.activeWorkflowToken) {
      return Promise.reject(new BrowserSessionError('SESSION_BUSY', 'A workflow has reserved this session', { retryable: true }));
    }
    if (this._state === 'USER_CONTROLLED' && options.allowUserControl !== true) {
      return Promise.reject(new BrowserSessionError('USER_CONTROL_HARD_STOP', 'User control is active; automation writes are blocked'));
    }
    if (this.queueDepth >= this.maxQueue) return Promise.reject(new BrowserSessionError('RESOURCE_EXHAUSTED', 'Session action queue is full', { retryable: true }));
    // Reserve queue capacity at submission time. Incrementing only when the
    // task starts would leave all waiting promises uncounted and allow an
    // unbounded backlog behind one active browser action.
    this.queueDepth += 1;
    const requireReady = options.requireReady ?? true;
    const task = async (): Promise<T> => {
      const controller = new AbortController();
      const abortFromParent = (): void => controller.abort();
      if (options.signal?.aborted) controller.abort();
      else options.signal?.addEventListener('abort', abortFromParent, { once: true });
      this.activeAbort = controller;
      const priorState = this._state;
      try {
        if (controller.signal.aborted) {
          throw new BrowserSessionError('ACTION_TIMEOUT', 'Browser action was aborted', { retryable: true });
        }
        if (this.activeWorkflowToken !== undefined && this.workflowContext.getStore() !== this.activeWorkflowToken) {
          throw new BrowserSessionError('SESSION_BUSY', 'A workflow has reserved this session', { retryable: true });
        }
        if (this._state === 'USER_CONTROLLED' && options.allowUserControl !== true) {
          throw new BrowserSessionError('USER_CONTROL_HARD_STOP', 'User control is active; automation writes are blocked');
        }
        if (requireReady && !isWritableState(this._state)) {
          if (this._state === 'PAUSED_CHALLENGE') throw new BrowserSessionError('SESSION_PAUSED_CHALLENGE', 'Automation is paused for human challenge handling');
          if (this._state === 'HUMAN_TAKEOVER') throw new BrowserSessionError('INVALID_STATE', 'Human takeover is active');
          if (this._state === 'USER_CONTROLLED') throw new BrowserSessionError('USER_CONTROL_HARD_STOP', 'User control is active; automation writes are blocked');
          throw new BrowserSessionError('INVALID_STATE', 'Session is not ready', { retryable: true });
        }
        if (options.allowPaused !== true && this._state === 'PAUSED_CHALLENGE') {
          throw new BrowserSessionError('SESSION_PAUSED_CHALLENGE', 'Automation is paused for human challenge handling');
        }
        if (this._state === 'ERROR' || this._state === 'STOPPED' || this._state === 'STOPPING') {
          throw new BrowserSessionError('INVALID_STATE', 'Session is closing or unavailable');
        }
        if (requireReady) this._state = 'BUSY';
        const preserveExistingPause = options.allowPaused === true && !requireReady &&
          (priorState === 'PAUSED_CHALLENGE' || priorState === 'HUMAN_TAKEOVER' || priorState === 'USER_CONTROLLED');
        await this.scanChallenge(preserveExistingPause);
        if (requireReady && this._state === 'PAUSED_CHALLENGE') {
          throw new BrowserSessionError('SESSION_PAUSED_CHALLENGE', 'Automation is paused for human challenge handling');
        }
        const timeoutMs = Math.max(500, Math.min(60_000, Math.floor(options.timeoutMs ?? this.defaultTimeoutMs)));
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        let result: T;
        try {
          result = await operation(controller.signal);
        } finally {
          clearTimeout(timeout);
        }
        if (controller.signal.aborted) {
          throw new BrowserSessionError('ACTION_TIMEOUT', 'Browser action timed out or was aborted', { retryable: true });
        }
        return result;
      } catch (error) {
        let mapped: BrowserSessionError;
        if (controller.signal.aborted && this._state !== 'PAUSED_CHALLENGE') {
          mapped = new BrowserSessionError('ACTION_TIMEOUT', 'Browser action timed out or was aborted', { retryable: true });
        } else if (controller.signal.aborted && this._state === 'PAUSED_CHALLENGE') {
          mapped = new BrowserSessionError('SESSION_PAUSED_CHALLENGE', 'Automation was stopped after challenge detection');
        } else {
          mapped = error instanceof BrowserSessionError ? error : browserErrorFromTarget(error);
        }
        // Failure audit records contain only the stable action/code pair. Do
        // not retain a target name, input text, URL or underlying exception.
        await this.audit({ action, outcome: 'error', errorCode: mapped.code }).catch(() => undefined);
        throw mapped;
      } finally {
        options.signal?.removeEventListener('abort', abortFromParent);
        if (requireReady && this._state === 'BUSY') this._state = 'READY';
        else if (priorState === 'READY' && this._state === 'BUSY') this._state = priorState;
        this.activeAbort = undefined;
        this.queueDepth -= 1;
      }
    };
    const result = this.queueTail.then(task, task);
    this.queueTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async closeContext(): Promise<void> {
    const context = this.context;
    this.context = undefined;
    for (const tab of this.tabs.values()) {
      tab.registry.clear();
      tab.snapshotHistory.clear();
    }
    this.tabs.clear();
    this.fallbackRegistry.clear();
    if (context) await context.close();
  }

  private async loadInitialCookies(): Promise<void> {
    const cookies = this.options.initialCookies;
    if (!cookies?.length || !this.context?.addCookies) return;
    await this.context.addCookies(cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || '/',
      ...(cookie.expires !== undefined && cookie.expires > 0 ? { expires: cookie.expires } : {}),
      ...(cookie.httpOnly !== undefined ? { httpOnly: cookie.httpOnly } : {}),
      ...(cookie.secure !== undefined ? { secure: cookie.secure } : {}),
      ...(cookie.sameSite !== undefined ? { sameSite: cookie.sameSite } : {}),
    })));
  }

  private async persistContextCookies(): Promise<void> {
    if (!this.options.onCookiesPersist || !this.context?.cookies) return;
    const cookies = await this.context.cookies();
    await this.options.onCookiesPersist(cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || '/',
      ...(cookie.expires > 0 ? { expires: cookie.expires } : {}),
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
    })));
  }
  private async cleanupOwnedProfile(): Promise<void> {
    if (this.persistentProfile) return;
    await this.cleanupOwnedDirectory(this.profileRoot, this.profileDirectory);
  }

  private async cleanupOwnedArtifacts(): Promise<void> {
    await this.cleanupOwnedDirectory(this.artifactsRoot, this.artifactsDirectory);
  }

  private async cleanupOwnedDirectory(rootValue: string, directoryValue: string): Promise<void> {
    const root = resolve(rootValue);
    const directory = resolve(directoryValue);
    const relativePath = relative(root, directory);
    if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) return;
    await rm(directory, { recursive: true, force: true });
  }

  private async audit(fields: Record<string, unknown>): Promise<void> {
    const audit = this.options.audit;
    if (!audit) return;
    const event: Record<string, unknown> = {
      timestamp: (this.options.now ?? (() => new Date()))().toISOString(),
      sessionId: this.sessionId,
      ...fields,
    };
    if (audit.record) await audit.record(event);
    else if (audit.write) await audit.write(event);
    else if (audit.append) await audit.append(event);
  }

  private async resolveActionTarget(target: string | SemanticTarget, requireActionable = true) {
    if (typeof target === 'string') return this.resolveRef(target, requireActionable);
    try {
      return await this.registry.resolveDirect(this.requirePage(), target, requireActionable);
    } catch (error) {
      throw browserErrorFromTarget(error);
    }
  }

}

function workflowTarget(target: WorkflowTarget): string | SemanticTarget {
  if (typeof target === 'string') return target;
  if (typeof target.ref === 'string') return target.ref;
  return {
    ...(target.role !== undefined ? { role: target.role } : {}),
    ...(target.name !== undefined ? { name: target.name } : {}),
    ...(target.exact !== undefined ? { exact: target.exact } : {}),
    ...(target.label !== undefined ? { label: target.label } : {}),
    ...(target.testId !== undefined ? { testId: target.testId } : {}),
  };
}

/** The workflow owns outer idempotency, so its actionId is never reused by an inner step. */
function workflowActionOptions(options: WorkflowActionOptions | undefined): Omit<WorkflowActionOptions, 'actionId'> {
  if (!options) return {};
  const { actionId: _actionId, ...safe } = options;
  return safe;
}

function targetRef(target: string | SemanticTarget): string {
  return typeof target === 'string' ? target : target.selector ?? target.role ?? target.label ?? target.testId ?? 'target';
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function boundedInteger(value: number, minimum: number, maximum: number, fallback: number): number {
  return Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, Math.floor(value)))
    : fallback;
}

function syncCaptureScript(binding: string): string {
  return `(() => {
    if (window.__absSyncCaptureInstalled) return;
    window.__absSyncCaptureInstalled = true;
    const send = (action) => { const fn = window[${JSON.stringify(binding)}]; if (typeof fn === 'function') Promise.resolve(fn(action)).catch(() => {}); };
    const targetOf = (element) => {
      if (!(element instanceof Element)) return null;
      const testId = element.getAttribute('data-testid'); if (testId) return { testId };
      const aria = element.getAttribute('aria-label');
      const labelled = element.id ? document.querySelector('label[for="' + CSS.escape(element.id) + '"]')?.textContent?.trim() : '';
      if (labelled) return { label: labelled };
      const role = element.getAttribute('role') || ({BUTTON:'button',A:'link',INPUT: element.getAttribute('type') === 'checkbox' ? 'checkbox' : 'textbox',TEXTAREA:'textbox',SELECT:'combobox'})[element.tagName];
      const name = aria || element.textContent?.trim() || element.getAttribute('placeholder') || element.getAttribute('name');
      return role && name ? { role, name: name.slice(0, 200), exact: true } : null;
    };
    document.addEventListener('click', (event) => { if (!event.isTrusted) return; const target = targetOf(event.target); if (target) send({ type:'click', target }); }, true);
    document.addEventListener('change', (event) => { if (!event.isTrusted) return; const element = event.target; if (element?.type === 'password') return; const target = targetOf(element); if (target && element && typeof element.value === 'string') send({ type:'type', target, text:element.value.slice(0, 10000) }); }, true);
    let lastY = scrollY; let scrollTimer;
    addEventListener('scroll', () => { clearTimeout(scrollTimer); scrollTimer = setTimeout(() => { const next = scrollY; send({ type:'scroll', deltaY:next-lastY }); lastY=next; }, 80); }, {passive:true});
    addEventListener('pageshow', () => send({ type:'navigate', url:location.href }));
  })()`;
}

export default BrowserSession;
