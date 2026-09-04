/**
 * The MCP layer deliberately depends on this small, high-level interface
 * instead of importing Playwright types.  The browser worker owns all pages,
 * locators, policy checks, and challenge gates.
 */

export type JsonObject = Record<string, unknown>;
type ManagerMethod = (...args: never[]) => Promise<unknown> | unknown;

export interface SessionManagerLike {
  start: ManagerMethod;
  status: ManagerMethod;
  environmentDiagnostics?: ManagerMethod;
  stop: ManagerMethod;
  reopenHeaded: ManagerMethod;
  resume: ManagerMethod;
  handoff: ManagerMethod;
  takeover: ManagerMethod;
  open: ManagerMethod;
  snapshot: ManagerMethod;
  screenshot: ManagerMethod;
  click: ManagerMethod;
  type: ManagerMethod;
  select: ManagerMethod;
  scroll: ManagerMethod;
  wait: ManagerMethod;
  workflow: ManagerMethod;
  extract?: ManagerMethod;
  fetch?: ManagerMethod;
  listWorkspaces?: ManagerMethod;
  getWorkspace?: ManagerMethod;
  getWorkspaceForSession?: (sessionId: string, tenantId?: string) => unknown;
  workspaceHandoff?: ManagerMethod;
  workspaceResume?: ManagerMethod;
  listTabs?: ManagerMethod;
  switchTab?: ManagerMethod;
  closeTab?: ManagerMethod;
  capabilities?: ManagerMethod;
  submitClusterTask?: ManagerMethod;
  submitClusterBatch?: ManagerMethod;
  getClusterStatus?: ManagerMethod;
  getClusterTask?: ManagerMethod;
  listClusterTasks?: ManagerMethod;
  createProfile?: ManagerMethod;
  listProfiles?: ManagerMethod;
  getProfile?: ManagerMethod;
  deleteProfile?: ManagerMethod;
  exportCookies?: ManagerMethod;
  importCookies?: ManagerMethod;
  checkProxy?: ManagerMethod;
  shutdown: ManagerMethod;
  /** Present on the concrete SessionManager; optional for simple test stubs. */
  get?(sessionId: string, tenantId?: string): unknown;
  getSessionState?: (sessionId: string, tenantId?: string) => unknown;
}

export type BrowserSessionState =
  | "STOPPED"
  | "STARTING"
  | "READY"
  | "BUSY"
  | "PAUSED_CHALLENGE"
  | "HUMAN_TAKEOVER"
  | "USER_CONTROLLED"
  | "PAUSED_OPERATOR"
  | "STOPPING"
  | "ERROR"
  | (string & {});

export interface BrowserToolErrorLike extends Error {
  code?: unknown;
  retryable?: unknown;
  details?: unknown;
  sessionId?: unknown;
  sessionState?: unknown;
  traceId?: unknown;
}

export interface ToolSuccessEnvelope extends JsonObject {
  ok: true;
  sessionId?: string;
  sessionState?: BrowserSessionState;
  revision?: number;
  traceId: string;
  data: unknown;
  warnings: unknown[];
}

export interface ToolErrorEnvelope extends JsonObject {
  ok: false;
  sessionId?: string;
  sessionState?: BrowserSessionState;
  traceId: string;
  timestamp: string;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details: JsonObject;
  };
}
