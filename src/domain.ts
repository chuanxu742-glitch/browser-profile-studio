/**
 * The public error vocabulary for the server.
 *
 * Keep this list deliberately boring: callers should be able to make a
 * decision from `code` without parsing a browser or Node error message.
 */
export const BROWSER_ERROR_CODES = [
  'INVALID_INPUT',
  'INVALID_ARGUMENT',
  'UNAUTHENTICATED',
  'PERMISSION_DENIED',
  'POLICY_DENIED',
  'DOMAIN_NOT_ALLOWED',
  'NETWORK_BLOCKED',
  'PRIVATE_NETWORK_DENIED',
  'NAVIGATION_DENIED',
  'NAVIGATION_BLOCKED',
  'RESOURCE_BLOCKED',
  'DOWNLOAD_BLOCKED',
  'RATE_LIMITED',
  'APPROVAL_REQUIRED',
  'SESSION_NOT_FOUND',
  'SESSION_EXPIRED',
  'WORKSPACE_NOT_FOUND',
  'INVALID_STATE',
  'SESSION_BUSY',
  'SESSION_STATE_CONFLICT',
  'SESSION_PAUSED_CHALLENGE',
  'USER_CONTROL_HARD_STOP',
  'PAGE_REVISION_MISMATCH',
  'ACTION_ID_CONFLICT',
  'SNAPSHOT_NOT_FOUND',
  'SNAPSHOT_EXPIRED',
  'SNAPSHOT_ID_CONFLICT',
  'STALE_TARGET',
  'TARGET_NOT_FOUND',
  'TARGET_AMBIGUOUS',
  'TARGET_NOT_ACTIONABLE',
  'NAVIGATION_TIMEOUT',
  'ACTION_TIMEOUT',
  'TIMEOUT',
  'WORKFLOW_STEP_LIMIT_EXCEEDED',
  'TAB_LIMIT_EXCEEDED',
  'CHALLENGE_DETECTED',
  'CHALLENGE_REQUIRES_HUMAN',
  'AUTOMATION_PAUSED',
  'MANUAL_TAKEOVER_ACTIVE',
  'HUMAN_HANDOFF_EXPIRED',
  'TAKEOVER_UNAVAILABLE',
  'RESOURCE_EXHAUSTED',
  'BROWSER_CRASHED',
  'BROWSER_LAUNCH_FAILED',
  'AUDIT_UNAVAILABLE',
  'INTERNAL',
  'INTERNAL_ERROR',
] as const;

export type WorkspaceControlState = 'AGENT_CONTROLLED' | 'USER_CONTROLLED' | 'INACTIVE';
export type WorkspaceRetention = 'destroy' | 'keep_until' | 'retain';

export interface Workspace {
  workspaceId: string;
  /** Tenant boundary enforced by the control plane and manager. */
  tenantId: string;
  name: string;
  owner: 'agent' | 'user' | 'none';
  controlState: WorkspaceControlState;
  retention: WorkspaceRetention;
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  /** Set for retained workspaces; absent when retention is `destroy`. */
  expiresAt?: number;
}

export type BrowserToolErrorCode = (typeof BROWSER_ERROR_CODES)[number];
/** Short aliases for callers that expose a generic error-code type. */
export type ErrorCode = BrowserToolErrorCode;
export const ERROR_CODES = BROWSER_ERROR_CODES;

export function isBrowserToolErrorCode(value: unknown): value is BrowserToolErrorCode {
  return typeof value === 'string' && (BROWSER_ERROR_CODES as readonly string[]).includes(value);
}

export type BrowserErrorCategory =
  | 'INPUT'
  | 'AUTH'
  | 'POLICY'
  | 'QUOTA'
  | 'SESSION'
  | 'ACTION'
  | 'BROWSER'
  | 'SAFETY'
  | 'INTERNAL';

export interface BrowserToolErrorOptions {
  /** Structured, non-sensitive context. It is redacted before being exposed. */
  details?: unknown;
  retryable?: boolean;
  category?: BrowserErrorCategory;
  cause?: unknown;
  /** Optional envelope correlation fields used by the MCP adapter. */
  sessionId?: string;
  sessionState?: string;
  traceId?: string;
}

export interface SerializedBrowserToolError {
  code: BrowserToolErrorCode;
  message: string;
  retryable: boolean;
  category: BrowserErrorCategory;
  details: Record<string, unknown>;
}

const DEFAULT_MESSAGES: Readonly<Record<BrowserToolErrorCode, string>> = {
  INVALID_INPUT: 'The request is invalid.',
  INVALID_ARGUMENT: 'The request contains an invalid argument.',
  UNAUTHENTICATED: 'Authentication is required.',
  PERMISSION_DENIED: 'The requested operation is not permitted.',
  POLICY_DENIED: 'The requested operation is not permitted by policy.',
  DOMAIN_NOT_ALLOWED: 'The host is outside the approved domain set.',
  NETWORK_BLOCKED: 'The network destination was blocked by policy.',
  PRIVATE_NETWORK_DENIED: 'The destination resolves to a protected network.',
  NAVIGATION_DENIED: 'Navigation was denied by policy.',
  NAVIGATION_BLOCKED: 'Navigation was blocked by policy.',
  RESOURCE_BLOCKED: 'The resource was blocked by policy.',
  DOWNLOAD_BLOCKED: 'Downloads are blocked by policy.',
  RATE_LIMITED: 'The request rate is limited.',
  APPROVAL_REQUIRED: 'This operation requires approval.',
  SESSION_NOT_FOUND: 'The browser session was not found.',
  SESSION_EXPIRED: 'The browser session has expired.',
  WORKSPACE_NOT_FOUND: 'The browser workspace was not found.',
  INVALID_STATE: 'The session is in an invalid state for this operation.',
  SESSION_BUSY: 'The browser session is busy.',
  SESSION_STATE_CONFLICT: 'The session state does not allow this operation.',
  SESSION_PAUSED_CHALLENGE: 'Automation is paused because a challenge was detected.',
  USER_CONTROL_HARD_STOP: 'Automation is stopped because the workspace is under user control.',
  PAGE_REVISION_MISMATCH: 'The page changed; obtain a fresh snapshot.',
  ACTION_ID_CONFLICT: 'The action id was already used with different input.',
  SNAPSHOT_NOT_FOUND: 'The base snapshot is not available.',
  SNAPSHOT_EXPIRED: 'The base snapshot has expired.',
  SNAPSHOT_ID_CONFLICT: 'The snapshot id conflicts with an existing observation.',
  STALE_TARGET: 'The target is stale; obtain a fresh snapshot.',
  TARGET_NOT_FOUND: 'The target was not found.',
  TARGET_AMBIGUOUS: 'The target is ambiguous.',
  TARGET_NOT_ACTIONABLE: 'The target is not actionable.',
  NAVIGATION_TIMEOUT: 'Navigation timed out.',
  ACTION_TIMEOUT: 'The browser action timed out.',
  TIMEOUT: 'The operation timed out.',
  WORKFLOW_STEP_LIMIT_EXCEEDED: 'The workflow contains too many steps.',
  TAB_LIMIT_EXCEEDED: 'The session has reached its tab limit.',
  CHALLENGE_DETECTED: 'Automation is paused because a challenge was detected.',
  CHALLENGE_REQUIRES_HUMAN: 'A human must handle the challenge before automation can continue.',
  AUTOMATION_PAUSED: 'Automation is paused.',
  MANUAL_TAKEOVER_ACTIVE: 'Manual takeover is active.',
  HUMAN_HANDOFF_EXPIRED: 'The human handoff has expired.',
  TAKEOVER_UNAVAILABLE: 'Manual takeover is unavailable in this browser mode.',
  RESOURCE_EXHAUSTED: 'A configured resource limit was reached.',
  BROWSER_CRASHED: 'The browser worker crashed.',
  BROWSER_LAUNCH_FAILED: 'The browser could not be started.',
  AUDIT_UNAVAILABLE: 'The audit log is unavailable.',
  INTERNAL: 'An internal error occurred.',
  INTERNAL_ERROR: 'An internal error occurred.',
};

const DEFAULT_RETRYABLE: ReadonlySet<BrowserToolErrorCode> = new Set([
  'RATE_LIMITED',
  'RESOURCE_EXHAUSTED',
  'SESSION_BUSY',
  'SESSION_STATE_CONFLICT',
  'PAGE_REVISION_MISMATCH',
  'STALE_TARGET',
  'TARGET_NOT_FOUND',
  'TARGET_NOT_ACTIONABLE',
  'NAVIGATION_TIMEOUT',
  'ACTION_TIMEOUT',
  'TIMEOUT',
  'BROWSER_CRASHED',
]);

const URL_IN_TEXT = /https?:\/\/[^\s<>"'`]+/gi;
const SENSITIVE_KEY = /(?:password|passwd|passcode|passphrase|pin|secret|token|cookie|authorization|auth[-_]?header|set[-_]?cookie|credential|private[-_]?key|api[-_]?key|access[-_]?key|refresh[-_]?token|raw(?:[-_]?text|[-_]?body|[-_]?html)?|page[-_]?content|storage|header|body|payload|form[-_]?data|dom|screenshot|clipboard|csrf|jwt|bearer|html|script|query|fragment|^trace(?:data|body)?$|^input(?:text|value)?$|^page(?:text|html|content)$|^accessible(?:name|text)$|^visible(?:text|content)$|^inner(?:text|html)$|^outerhtml$|^text(?:content|value)?$|^value$)/i;
const INPUT_KEY = /^(?:input|inputText|inputValue|text|textValue|typed(?:text|value)?|value)$/i;
const PATH_KEY = /^(?:path|root|cwd|workdir|workingDirectory|.*(?:Path|Dir|Directory|DirectoryName|Filename|FileName))$/i;
const TARGET_SAFE_KEYS = new Set([
  'role',
  'tag',
  'type',
  'inputtype',
  'kind',
  'locatortype',
]);

function removeUrlQuery(value: string): string {
  return value.replace(URL_IN_TEXT, (candidate) => {
    let core = candidate;
    let punctuation = '';
    while (/[),.;!?]$/.test(core)) {
      punctuation = core.slice(-1) + punctuation;
      core = core.slice(0, -1);
    }

    try {
      const parsed = new URL(core);
      // origin + pathname intentionally excludes both query and fragment.
      return `${parsed.origin}${parsed.pathname}${punctuation}`;
    } catch {
      // Do not return an untrusted URL if parsing failed. The URL may be
      // malformed, but it can still contain a secret query string.
      const queryIndex = core.indexOf('?');
      const fragmentIndex = core.indexOf('#');
      const cutAt = [queryIndex, fragmentIndex]
        .filter((index) => index >= 0)
        .sort((a, b) => a - b)[0];
      return `${cutAt === undefined ? core : core.slice(0, cutAt)}${punctuation}`;
    }
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeValue(value: unknown, key: string, depth: number): unknown {
  if (depth > 8) return '[omitted]';
  if (typeof value === 'string') return removeUrlQuery(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name };
  if (Array.isArray(value)) {
    return value.slice(0, 64).map((entry) => sanitizeValue(entry, key, depth + 1));
  }
  if (isPlainRecord(value)) return sanitizeRecord(value, depth + 1);
  return '[omitted]';
}

/**
 * Redact a structured value for an error response. Unknown objects are
 * reduced to JSON-safe values and high-risk fields are omitted.
 */
export function sanitizeErrorDetails(value: unknown): Record<string, unknown> {
  if (isPlainRecord(value)) return sanitizeRecord(value, 0);
  if (value === undefined) return {};
  if (typeof value === 'string') return { reason: removeUrlQuery(value) };
  return { reason: sanitizeValue(value, 'reason', 0) };
}

function sanitizeRecord(value: Record<string, unknown>, depth: number): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(value)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey === 'target') {
      // Accessible names are page text and may contain PII or secrets. Keep
      // only structural, low-sensitivity element metadata for audit/debug.
      result[key] = sanitizeTarget(entry);
      continue;
    }
    if (INPUT_KEY.test(key)) {
      if (typeof entry === 'string') result.inputLength = entry.length;
      continue;
    }
    if (SENSITIVE_KEY.test(key) || PATH_KEY.test(key)) {
      continue;
    }

    // A key named `url` is safe only after query/fragment removal. The same
    // treatment is applied to URL-looking strings in all other fields.
    if (lowerKey === 'url' || lowerKey.endsWith('url') || lowerKey === 'location') {
      if (typeof entry === 'string') {
        result[key] = removeUrlQuery(entry);
      } else {
        result[key] = sanitizeValue(entry, key, depth + 1);
      }
      continue;
    }

    result[key] = sanitizeValue(entry, key, depth + 1);
  }

  return result;
}

function sanitizeTarget(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!TARGET_SAFE_KEYS.has(key.toLowerCase())) continue;
    if (typeof entry === 'string') {
      result[key] = entry.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 64);
    } else if (typeof entry === 'number' || typeof entry === 'boolean') {
      result[key] = entry;
    }
  }
  return result;
}

function categoryForCode(code: BrowserToolErrorCode): BrowserErrorCategory {
  switch (code) {
    case 'INVALID_INPUT':
    case 'INVALID_ARGUMENT':
      return 'INPUT';
    case 'UNAUTHENTICATED':
    case 'PERMISSION_DENIED':
      return 'AUTH';
    case 'POLICY_DENIED':
    case 'DOMAIN_NOT_ALLOWED':
    case 'NETWORK_BLOCKED':
    case 'PRIVATE_NETWORK_DENIED':
    case 'NAVIGATION_DENIED':
    case 'NAVIGATION_BLOCKED':
    case 'RESOURCE_BLOCKED':
    case 'DOWNLOAD_BLOCKED':
    case 'APPROVAL_REQUIRED':
      return 'POLICY';
    case 'RATE_LIMITED':
    case 'RESOURCE_EXHAUSTED':
    case 'WORKFLOW_STEP_LIMIT_EXCEEDED':
    case 'TAB_LIMIT_EXCEEDED':
      return 'QUOTA';
    case 'SESSION_NOT_FOUND':
    case 'SESSION_EXPIRED':
    case 'WORKSPACE_NOT_FOUND':
    case 'INVALID_STATE':
    case 'SESSION_BUSY':
    case 'SESSION_STATE_CONFLICT':
    case 'SESSION_PAUSED_CHALLENGE':
    case 'PAGE_REVISION_MISMATCH':
      return 'SESSION';
    case 'USER_CONTROL_HARD_STOP':
      return 'SAFETY';
    case 'ACTION_ID_CONFLICT':
    case 'SNAPSHOT_NOT_FOUND':
    case 'SNAPSHOT_EXPIRED':
    case 'SNAPSHOT_ID_CONFLICT':
    case 'STALE_TARGET':
    case 'TARGET_NOT_FOUND':
    case 'TARGET_AMBIGUOUS':
    case 'TARGET_NOT_ACTIONABLE':
      return 'ACTION';
    case 'NAVIGATION_TIMEOUT':
    case 'ACTION_TIMEOUT':
    case 'TIMEOUT':
    case 'BROWSER_CRASHED':
    case 'BROWSER_LAUNCH_FAILED':
      return 'BROWSER';
    case 'CHALLENGE_DETECTED':
    case 'CHALLENGE_REQUIRES_HUMAN':
    case 'AUTOMATION_PAUSED':
    case 'MANUAL_TAKEOVER_ACTIVE':
    case 'HUMAN_HANDOFF_EXPIRED':
    case 'TAKEOVER_UNAVAILABLE':
    case 'AUDIT_UNAVAILABLE':
      return 'SAFETY';
    case 'INTERNAL':
    case 'INTERNAL_ERROR':
      return 'INTERNAL';
  }
}

export class BrowserToolError extends Error {
  readonly code: BrowserToolErrorCode;
  readonly retryable: boolean;
  readonly category: BrowserErrorCategory;
  readonly details: Record<string, unknown>;
  readonly sessionId?: string;
  readonly sessionState?: string;
  readonly traceId?: string;

  constructor(
    code: BrowserToolErrorCode,
    messageOrOptions?: string | BrowserToolErrorOptions,
    optionsOrDetails?: BrowserToolErrorOptions | unknown,
    legacyRetryable?: boolean,
  ) {
    const normalizedCode: BrowserToolErrorCode = isBrowserToolErrorCode(code) ? code : 'INTERNAL_ERROR';
    const message = typeof messageOrOptions === 'string' ? messageOrOptions : undefined;
    const thirdArgument = typeof messageOrOptions === 'string' ? optionsOrDetails : messageOrOptions;
    const options = isErrorOptions(thirdArgument) ? thirdArgument : undefined;
    const details = options ? options.details : thirdArgument;
    const safeMessage = removeUrlQuery(message ?? DEFAULT_MESSAGES[normalizedCode]);
    super(safeMessage);
    this.name = 'BrowserToolError';
    this.code = normalizedCode;
    this.retryable = legacyRetryable ?? options?.retryable ?? DEFAULT_RETRYABLE.has(normalizedCode);
    this.category = options?.category ?? categoryForCode(normalizedCode);
    this.details = sanitizeErrorDetails(details);
    if (options?.sessionId !== undefined) this.sessionId = options.sessionId;
    if (options?.sessionState !== undefined) this.sessionState = options.sessionState;
    if (options?.traceId !== undefined) this.traceId = options.traceId;
    if (options?.cause !== undefined) this.cause = options.cause;
  }

  toJSON(): SerializedBrowserToolError {
    return {
      code: this.code,
      message: removeUrlQuery(this.message),
      retryable: this.retryable,
      category: this.category,
      details: sanitizeErrorDetails(this.details),
    };
  }

  /** Return the stable, safe wire representation. */
  serialize(): SerializedBrowserToolError {
    return this.toJSON();
  }

  /** Convenience for transports that require a JSON string. */
  serializeJson(): string {
    return JSON.stringify(this.toJSON());
  }

  static fromUnknown(
    error: unknown,
    fallbackCode: BrowserToolErrorCode = 'INTERNAL_ERROR',
  ): BrowserToolError {
    if (error instanceof BrowserToolError) return error;
    if (error instanceof Error) {
      return new BrowserToolError(fallbackCode, error.message, {
        cause: error,
      });
    }
    return new BrowserToolError(fallbackCode);
  }
}

function isErrorOptions(value: unknown): value is BrowserToolErrorOptions {
  if (!isPlainRecord(value)) return false;
  return (
    'details' in value ||
    'retryable' in value ||
    'category' in value ||
    'cause' in value ||
    'sessionId' in value ||
    'sessionState' in value ||
    'traceId' in value
  );
}

export function isBrowserToolError(value: unknown): value is BrowserToolError {
  return value instanceof BrowserToolError;
}
