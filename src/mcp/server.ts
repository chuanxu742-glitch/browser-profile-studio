import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  BrowserReopenHeadedSchema,
  BrowserResumeSchema,
  BrowserHandoffSchema,
  BrowserTakeoverSchema,
  BrowserStartSchema,
  BrowserStatusSchema,
  BrowserStopSchema,
  BrowserCapabilitiesSchema,
  WorkspaceListSchema,
  WorkspaceGetSchema,
  WorkspaceHandoffSchema,
  WorkspaceResumeSchema,
  ClusterBatchSubmitSchema,
  ClusterGetTaskSchema,
  ClusterStatusSchema,
  ClusterSubmitTaskSchema,
  PageClickSchema,
  PageExtractSchema,
  PageFetchSchema,
  PageOpenSchema,
  PageScreenshotSchema,
  PageScrollSchema,
  PageSelectSchema,
  PageSnapshotSchema,
  PageTypeSchema,
  PageWaitSchema,
  PageWorkflowSchema,
  PageWorkflowExecuteSchema,
  PageListTabsSchema,
  PageSwitchTabSchema,
  PageCloseTabSchema,
  ProfileCreateSchema,
  ProfileListSchema,
  ProfileGetSchema,
  ProfileDeleteSchema,
  ProfileExportCookiesSchema,
  ProfileImportCookiesSchema,
  ProxyCheckSchema,
  TOOL_INPUT_SCHEMAS,
  type ToolName,
} from "./schemas.js";
import { errorResult, successResult, type McpToolResult } from "./response.js";
import type { SessionManagerLike } from "./types.js";
import { TenantAuthenticator } from "../auth/tenant-auth.js";
import { findAdaptiveTarget } from "../browser/adaptive-locator.js";
import type { SemanticTarget } from "../browser/semantic-snapshot.js";
import type { WorkspaceControlState } from "../domain.js";
import { DEFAULT_TENANT_ID, normalizeTenantId } from "../distributed/tenant.js";
import { McpRuntimeGuard } from "./runtime-guard.js";
import { SERVER_VERSION } from "../capabilities.js";

export const MCP_SERVER_NAME = "compliant-firefox";
export const MCP_SERVER_VERSION = SERVER_VERSION;

export const TOOL_NAMES = [
  "browser_start",
  "browser_status",
  "browser_stop",
  "browser_reopen_headed",
  "browser_resume",
  "browser_handoff",
  "browser_takeover",
  "page_fetch",
  "page_open",
  "page_snapshot",
  "page_extract",
  "page_screenshot",
  "page_click",
  "page_type",
  "page_select",
  "page_scroll",
  "page_wait",
  "page_workflow",
  "workspace_list",
  "workspace_get",
  "workspace_handoff",
  "workspace_resume",
  "page_workflow_execute",
  "page_list_tabs",
  "page_switch_tab",
  "page_close_tab",
  "browser_capabilities",
  "cluster_submit_task",
  "cluster_batch_submit",
  "cluster_status",
  "cluster_get_task",
  "profile_create",
  "profile_list",
  "profile_get",
  "profile_delete",
  "profile_export_cookies",
  "profile_import_cookies",
  "proxy_check",
] as const satisfies readonly ToolName[];

const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "page_open",
  "page_click",
  "page_type",
  "page_select",
  "page_scroll",
  "page_workflow",
  "page_workflow_execute",
  "page_switch_tab",
  "page_close_tab",
]);
type ToolDefinition = {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  parse: (value: unknown) => unknown;
  invoke: (
    manager: SessionManagerLike,
    input: unknown,
    tenantAuthenticator?: TenantAuthenticator,
    authenticatedTenantId?: string,
  ) => Promise<unknown>;
};

export interface McpServerOptions {
  /** Optional control-plane authentication. When absent, the default tenant
   * remains available for local development and backwards compatibility. */
  tenantAuthenticator?: TenantAuthenticator | undefined;
  runtimeGuard?: McpRuntimeGuard | undefined;
  audit?: {
    record(event: Record<string, unknown>): Promise<void> | void;
  } | undefined;
  now?: (() => number) | undefined;
}

function recordAuditBestEffort(options: McpServerOptions, event: Record<string, unknown>): void {
  try {
    void Promise.resolve(options.audit?.record(event)).catch(() => undefined);
  } catch {
    // Completion has already happened. The attempt event remains the durable
    // fail-closed boundary, so a completion-sink failure cannot replay or
    // retroactively change a tool outcome.
  }
}

function managerIsConcreteSessionManager(manager: SessionManagerLike): boolean {
  // The production SessionManager exposes get(sessionId), while contract
  // tests and embedders may provide a small object-shaped stub. This is a
  // compatibility check only; it never exposes the returned BrowserSession.
  return typeof manager.get === "function";
}

function targetRef(target: unknown): string | undefined {
  if (target && typeof target === "object" && typeof (target as Record<string, unknown>).ref === "string") {
    return (target as Record<string, string>).ref;
  }
  return undefined;
}

function targetName(target: Record<string, unknown>): string | undefined {
  if (typeof target.name === "string") return target.name;
  if (typeof target.label === "string") return target.label;
  return undefined;
}

/** Resolve semantic targets against the bounded snapshot registry used by the
 * concrete BrowserSession. No browser object crosses this boundary. */
async function resolveConcreteTarget(
  manager: SessionManagerLike,
  sessionId: string,
  target: unknown,
  tenantId?: string,
): Promise<string | Record<string, unknown>> {
  const direct = targetRef(target);
  if (direct) return direct;
  if (!target || typeof target !== "object") {
    throw Object.assign(new Error("A semantic target is required"), { code: "TARGET_NOT_FOUND" });
  }
  const candidate = target as Record<string, unknown>;
  const snapshot = tenantId === undefined
    ? await (manager.snapshot as unknown as (sessionId: string, options?: Record<string, unknown>) => Promise<unknown>).call(
      manager,
      sessionId,
      { maxChars: 0, includeText: false },
    )
    : await (manager.snapshot as unknown as (sessionId: string, options: Record<string, unknown>, tenantId: string) => Promise<unknown>).call(
      manager,
      sessionId,
      { maxChars: 0, includeText: false },
      tenantId,
    );
  const snapshotRecord = snapshot && typeof snapshot === "object" ? (snapshot as Record<string, unknown>) : {};
  const nodes = Array.isArray(snapshotRecord.targets)
    ? snapshotRecord.targets
    : Array.isArray(snapshotRecord.elements)
      ? snapshotRecord.elements
      : [];
  const expectedName = targetName(candidate);
  const exact = candidate.exact !== false;
  const matches = nodes.filter((node): node is Record<string, unknown> => {
    if (!node || typeof node !== "object") return false;
    const item = node as Record<string, unknown>;
    if (typeof item.ref !== "string") return false;
    if (typeof candidate.role === "string" && item.role !== candidate.role) return false;
    if (expectedName !== undefined) {
      if (typeof item.name !== "string") return false;
      if (exact ? item.name !== expectedName : !item.name.includes(expectedName)) return false;
    }
    // Test ids are deliberately not exposed in semantic snapshots by the
    // browser adapter. Refine the target by snapshot metadata only when a
    // future adapter explicitly returns a testId field.
    if (typeof candidate.testId === "string" && item.testId !== candidate.testId) return false;
    return true;
  });
  if (matches.length === 0) {
    const semanticCandidate: SemanticTarget = {
      ...(typeof candidate.role === 'string' ? { role: candidate.role } : {}),
      ...(expectedName !== undefined ? { name: expectedName } : {}),
      ...(typeof candidate.testId === 'string' ? { testId: candidate.testId } : {}),
    };
    const adaptive = findAdaptiveTarget(nodes as any, semanticCandidate);
    if (adaptive && adaptive.node && typeof adaptive.node.ref === 'string') {
      return adaptive.node.ref;
    }
    throw Object.assign(new Error("The semantic target was not found"), { code: "TARGET_NOT_FOUND" });
  }
  if (matches.length > 1) throw Object.assign(new Error("The semantic target is ambiguous"), { code: "TARGET_AMBIGUOUS", details: { count: matches.length } });
  const [match] = matches;
  if (!match || typeof match.ref !== "string") {
    throw Object.assign(new Error("The semantic target was not found"), { code: "TARGET_NOT_FOUND" });
  }
  return match.ref;
}
type TenantOperationRole = "read" | "submit";

const TENANT_SCOPED_METHODS: ReadonlySet<keyof SessionManagerLike> = new Set([
  "start",
  "status",
  "stop",
  "reopenHeaded",
  "resume",
  "handoff",
  "takeover",
  "open",
  "snapshot",
  "screenshot",
  "click",
  "type",
  "select",
  "scroll",
  "wait",
  "workflow",
  "extract",
  "listWorkspaces",
  "getWorkspace",
  "workspaceHandoff",
  "workspaceResume",
  "listTabs",
  "switchTab",
  "closeTab",
]);

const TENANT_SCOPED_TOOLS: ReadonlySet<string> = new Set([
  "browser_start",
  "browser_status",
  "browser_stop",
  "browser_reopen_headed",
  "browser_resume",
  "browser_handoff",
  "browser_takeover",
  "page_open",
  "page_snapshot",
  "page_extract",
  "page_screenshot",
  "page_click",
  "page_type",
  "page_select",
  "page_scroll",
  "page_wait",
  "page_workflow",
  "workspace_list",
  "workspace_get",
  "workspace_handoff",
  "workspace_resume",
  "page_workflow_execute",
  "page_list_tabs",
  "page_switch_tab",
  "page_close_tab",
]);

function tenantRoleForTool(toolName: string): TenantOperationRole | undefined {
  if (!TENANT_SCOPED_TOOLS.has(toolName)) return undefined;
  return WRITE_TOOL_NAMES.has(toolName) || toolName === "browser_start" || toolName === "browser_stop"
    ? "submit"
    : "read";
}

function tenantRoleForMethod(method: keyof SessionManagerLike): TenantOperationRole | undefined {
  if (!TENANT_SCOPED_METHODS.has(method)) return undefined;
  return method === "start"
    || method === "stop"
    || method === "reopenHeaded"
    || method === "resume"
    || method === "handoff"
    || method === "takeover"
    || method === "open"
    || method === "click"
    || method === "type"
    || method === "select"
    || method === "scroll"
    || method === "workflow"
    || method === "workspaceHandoff"
    || method === "workspaceResume"
    || method === "switchTab"
    || method === "closeTab"
    ? "submit"
    : "read";
}

function withoutTenantCredentials(input: Record<string, unknown>): Record<string, unknown> {
  const { tenantId: _tenantId, tenantToken: _tenantToken, ...safeInput } = input;
  return safeInput;
}

function resolveToolTenant(
  toolName: string,
  input: Record<string, unknown>,
  tenantAuthenticator?: TenantAuthenticator,
): string | undefined {
  const role = tenantRoleForTool(toolName);
  if (!role || !tenantAuthenticator) return undefined;
  return tenantAuthenticator.authenticate(input.tenantId, input.tenantToken, role).tenantId;
}

function resolveMethodTenant(
  method: keyof SessionManagerLike,
  input: Record<string, unknown>,
  tenantAuthenticator: TenantAuthenticator | undefined,
  authenticatedTenantId: string | undefined,
): string | undefined {
  const role = tenantRoleForMethod(method);
  if (!role) return undefined;
  if (authenticatedTenantId !== undefined) return authenticatedTenantId;
  if (tenantAuthenticator) {
    return tenantAuthenticator.authenticate(input.tenantId, input.tenantToken, role).tenantId;
  }
  return undefined;
}


type ClusterOperationRole = "read" | "submit";

function clusterRole(method: keyof SessionManagerLike): ClusterOperationRole | undefined {
  if (method === "submitClusterTask" || method === "submitClusterBatch") return "submit";
  if (method === "getClusterStatus" || method === "getClusterTask") return "read";
  return undefined;
}

function clusterInputWithoutCredentials(input: Record<string, unknown>): Record<string, unknown> {
  const { tenantId: _tenantId, tenantToken: _tenantToken, ...safeInput } = input;
  return safeInput;
}

function resolveClusterTenant(
  method: keyof SessionManagerLike,
  input: Record<string, unknown>,
  tenantAuthenticator?: TenantAuthenticator,
): string | undefined {
  const role = clusterRole(method);
  if (!role) return undefined;
  if (tenantAuthenticator) {
    return tenantAuthenticator.authenticate(input.tenantId, input.tenantToken, role).tenantId;
  }
  return normalizeTenantId(typeof input.tenantId === "string" ? input.tenantId : DEFAULT_TENANT_ID);
}

const call = async (
  manager: SessionManagerLike,
  method: keyof SessionManagerLike,
  input: any,
  tenantAuthenticator?: TenantAuthenticator,
  authenticatedTenantId?: string,
): Promise<unknown> => {
  const fn = manager[method];
  if (typeof fn !== "function") {
    throw Object.assign(new Error(`SessionManager.${String(method)} is unavailable`), { code: "INTERNAL_ERROR" });
  }

  const rawInput = input as Record<string, unknown>;
  const scopedTenantId = resolveMethodTenant(method, rawInput, tenantAuthenticator, authenticatedTenantId);
  const dispatchInput = tenantRoleForMethod(method) === undefined
    ? input
    : {
      ...withoutTenantCredentials(rawInput),
      ...(scopedTenantId !== undefined ? { tenantId: scopedTenantId } : {}),
    };
  input = dispatchInput;
  const clusterTenantId = resolveClusterTenant(method, rawInput, tenantAuthenticator);
  const safeClusterInput = clusterTenantId
    ? { ...clusterInputWithoutCredentials(rawInput), tenantId: clusterTenantId }
    : dispatchInput;
  const withTenant = (...args: unknown[]): unknown[] =>
    scopedTenantId === undefined ? args : [...args, scopedTenantId];

  if (!managerIsConcreteSessionManager(manager)) {
    // Object-shaped SessionManager adapters are useful for embedding and
    // tests. They still receive only validated input and never credentials.
    return await (fn as (arg: any) => Promise<unknown> | unknown).call(manager, safeClusterInput);
  }

  const requireSessionId = (): string => {
    if (typeof input.sessionId !== "string") {
      throw Object.assign(new Error("sessionId is required"), { code: "INVALID_INPUT" });
    }
    return input.sessionId;
  };
  switch (method) {
    case "start": {
      const startOptions: Record<string, unknown> = {
        ...(input.headless !== undefined ? { headless: input.headless } : {}),
        ...(input.engine !== undefined ? { engine: input.engine } : {}),
        ...(input.profile !== undefined ? { profileName: input.profile } : {}),
        ...(input.profileId !== undefined ? { profileId: input.profileId } : {}),
        ...(input.proxy !== undefined ? { proxy: input.proxy } : {}),
        ...(input.countryCode !== undefined ? { countryCode: input.countryCode } : {}),
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        ...(input.locale !== undefined ? { locale: input.locale } : {}),
        ...(input.geolocation !== undefined ? { geolocation: input.geolocation } : {}),
        ...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
        ...(input.fingerprint !== undefined ? { fingerprint: input.fingerprint } : {}),
        ...(input.fingerprintSeed !== undefined ? { fingerprintSeed: input.fingerprintSeed } : {}),
        ...(input.viewport !== undefined ? { viewport: input.viewport } : {}),
        ...(input.seed !== undefined ? { seed: input.seed } : {}),
        ...(input.workspaceName !== undefined ? { workspaceName: input.workspaceName } : {}),
        ...(input.workspaceRetention !== undefined ? { workspaceRetention: input.workspaceRetention } : {}),
        ...(scopedTenantId !== undefined ? { tenantId: scopedTenantId } : {}),
      };
      const started = await (fn as (options: Record<string, unknown>) => Promise<unknown>).call(manager, startOptions);
      // The concrete manager returns a BrowserSession instance. Never put that
      // object on the wire: it owns locators, schedulers, paths, and other
      // internal state. Return its bounded status projection instead.
      const startedRecord = started && typeof started === "object" ? (started as Record<string, unknown>) : {};
      const startedId = typeof startedRecord.sessionId === "string" ? startedRecord.sessionId : undefined;
      if (startedId && typeof manager.status === "function") {
        const statusFn = manager.status as unknown as (...args: unknown[]) => Promise<unknown> | unknown;
        return await statusFn.call(manager, ...withTenant(startedId));
      }
      if (typeof startedRecord.status === "function") return await startedRecord.status.call(started);
      return {
        ...(startedId ? { sessionId: startedId } : {}),
        ...(typeof startedRecord.state === "string" ? { state: startedRecord.state } : {}),
        ...(typeof startedRecord.headless === "boolean" ? { headless: startedRecord.headless } : {}),
      };
    }
    case "createProfile":
      return await (fn as (...args: unknown[]) => Promise<unknown> | unknown).call(manager, input);
    case "listProfiles":
      return await (fn as (...args: unknown[]) => Promise<unknown> | unknown).call(manager);
    case "getProfile":
      return await (fn as (...args: unknown[]) => Promise<unknown> | unknown).call(manager, input.profileId);
    case "deleteProfile":
      return await (fn as (...args: unknown[]) => Promise<unknown> | unknown).call(manager, input.profileId);
    case "exportCookies":
      return await (fn as (...args: unknown[]) => Promise<unknown> | unknown).call(manager, input.profileId, input.format);
    case "importCookies":
      return await (fn as (...args: unknown[]) => Promise<unknown> | unknown).call(manager, input.profileId, input.cookies, input.format);
    case "checkProxy":
      return await (fn as (...args: unknown[]) => Promise<unknown> | unknown).call(manager, input.proxy);
    case "status":
    case "stop":
    case "reopenHeaded": {
      const args = method === "stop" ? [requireSessionId(), "mcp_request"] : [requireSessionId()];
      return await (fn as (...args: unknown[]) => Promise<unknown> | unknown).call(manager, ...withTenant(...args));
    }
    case "resume":
      return await (fn as (...args: unknown[]) => Promise<unknown> | unknown).call(
        manager,
        ...withTenant(requireSessionId(), input.humanConfirmed),
      );
    case "handoff":
      return await (fn as (...args: unknown[]) => Promise<unknown> | unknown).call(
        manager,
        ...withTenant(requireSessionId(), { ttlMs: input.ttlMs, reason: input.reason }),
      );
    case "takeover":
      return await (fn as (...args: unknown[]) => Promise<unknown> | unknown).call(
        manager,
        ...withTenant(requireSessionId(), input.leaseToken, input.humanConfirmed),
      );
    case "listWorkspaces":
      return await (fn as (...args: unknown[]) => Promise<unknown> | unknown).call(manager, ...withTenant());
    case "getWorkspace":
      return await (fn as (...args: unknown[]) => Promise<unknown> | unknown).call(manager, ...withTenant(input.workspaceId));
    case "workspaceHandoff":
      return await (fn as (...args: unknown[]) => Promise<unknown> | unknown).call(manager, ...withTenant(input.workspaceId, input.reason));
    case "workspaceResume":
      return await (fn as (...args: unknown[]) => Promise<unknown> | unknown).call(
        manager,
        ...withTenant(input.workspaceId, input.leaseId, input.humanConfirmed),
      );
    case "listTabs":
      return await (fn as (...args: unknown[]) => Promise<unknown> | unknown).call(manager, ...withTenant(requireSessionId()));
    case "switchTab":
    case "closeTab":
      return await (fn as (...args: unknown[]) => Promise<unknown> | unknown).call(
        manager,
        ...withTenant(requireSessionId(), input.tabId),
      );
    case "capabilities":
      return await (fn as (supportedTools: readonly string[]) => Promise<unknown> | unknown).call(manager, TOOL_NAMES);
    case "open":
      return await (fn as (...args: unknown[]) => Promise<unknown> | unknown).call(manager, ...withTenant(requireSessionId(), input.url, {
        ...(input.waitUntil !== undefined ? { waitUntil: input.waitUntil } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.actionId !== undefined ? { actionId: input.actionId } : {}),
        ...(input.expectedPageRevision !== undefined ? { expectedPageRevision: input.expectedPageRevision } : {}),
        ...(input.expectedTabId !== undefined ? { expectedTabId: input.expectedTabId } : {}),
      }));
    case "fetch":
      return await (fn as (options: Record<string, unknown>) => Promise<unknown>).call(manager, input);
    case "submitClusterTask":
      return await (fn as (def: Record<string, unknown>, tenantId?: string) => Promise<unknown> | unknown).call(
        manager,
        clusterInputWithoutCredentials(input),
        clusterTenantId,
      );
    case "submitClusterBatch":
      return await (fn as (defs: readonly Record<string, unknown>[], tenantId?: string) => Promise<unknown> | unknown).call(
        manager,
        input.tasks,
        clusterTenantId,
      );
    case "getClusterStatus":
      return await (fn as (tenantId?: string) => Promise<unknown> | unknown).call(manager, clusterTenantId);
    case "getClusterTask":
      return await (fn as (id: string, tenantId?: string) => Promise<unknown> | unknown).call(manager, input.taskId, clusterTenantId);
    case "extract":
      return await (fn as (...args: unknown[]) => Promise<unknown> | unknown).call(manager, ...withTenant(requireSessionId(), {
        containerSelector: input.containerSelector,
        fields: input.fields,
        ...(input.maxItems !== undefined ? { maxItems: input.maxItems } : {}),
      }));
    case "snapshot":
      return await (fn as (...args: unknown[]) => Promise<unknown> | unknown).call(manager, ...withTenant(requireSessionId(), {
        maxChars: input.maxChars,
        maxBytes: input.maxBytes,
        format: input.format,
        ...(input.sinceSnapshotId !== undefined ? { sinceSnapshotId: input.sinceSnapshotId } : {}),
      }));
    case "screenshot":
      return await (fn as (...args: unknown[]) => Promise<unknown>).call(manager, ...withTenant(requireSessionId(), {
        fullPage: input.fullPage,
      }));
    case "click": {
      const sessionId = requireSessionId();
      const ref = await resolveConcreteTarget(manager, sessionId, input.target, scopedTenantId);
      return await (fn as (...args: unknown[]) => Promise<unknown> | unknown).call(manager, ...withTenant(sessionId, ref, {
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.actionId !== undefined ? { actionId: input.actionId } : {}),
        ...(input.expectedPageRevision !== undefined ? { expectedPageRevision: input.expectedPageRevision } : {}),
        ...(input.expectedTabId !== undefined ? { expectedTabId: input.expectedTabId } : {}),
      }));
    }
    case "type": {
      const sessionId = requireSessionId();
      const ref = await resolveConcreteTarget(manager, sessionId, input.target, scopedTenantId);
      return await (fn as (...args: unknown[]) => Promise<unknown> | unknown).call(manager, ...withTenant(sessionId, ref, input.text, {
        clearFirst: input.clear,
        submit: input.submit,
        sensitive: input.sensitive,
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.actionId !== undefined ? { actionId: input.actionId } : {}),
        ...(input.expectedPageRevision !== undefined ? { expectedPageRevision: input.expectedPageRevision } : {}),
        ...(input.expectedTabId !== undefined ? { expectedTabId: input.expectedTabId } : {}),
      }));
    }
    case "select": {
      const sessionId = requireSessionId();
      const ref = await resolveConcreteTarget(manager, sessionId, input.target, scopedTenantId);
      const selection = input.value !== undefined ? { value: input.value } : { label: input.label };
      return await (fn as (...args: unknown[]) => Promise<unknown> | unknown).call(manager, ...withTenant(sessionId, ref, selection, {
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.actionId !== undefined ? { actionId: input.actionId } : {}),
        ...(input.expectedPageRevision !== undefined ? { expectedPageRevision: input.expectedPageRevision } : {}),
        ...(input.expectedTabId !== undefined ? { expectedTabId: input.expectedTabId } : {}),
      }));
    }
    case "scroll": {
      const sessionId = requireSessionId();
      const ref = input.target ? await resolveConcreteTarget(manager, sessionId, input.target, scopedTenantId) : undefined;
      return await (fn as (...args: unknown[]) => Promise<unknown> | unknown).call(manager, ...withTenant(sessionId, input.direction, input.amount, ref, {
        ...(input.actionId !== undefined ? { actionId: input.actionId } : {}),
        ...(input.expectedPageRevision !== undefined ? { expectedPageRevision: input.expectedPageRevision } : {}),
        ...(input.expectedTabId !== undefined ? { expectedTabId: input.expectedTabId } : {}),
      }));
    }
    case "wait":
      return await (fn as (...args: unknown[]) => Promise<unknown> | unknown).call(manager, ...withTenant(requireSessionId(), {
        ...(input.milliseconds !== undefined ? { durationMs: input.milliseconds } : {}),
        ...(input.condition !== undefined ? { condition: input.condition } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      }));
    case "workflow": {
      const executeContract = Array.isArray(input.stopOn);
      const maxDurationMs = input.timeoutMs;
      const maxResultBytes = input.maxResultBytes;
      return await (fn as (...args: unknown[]) => Promise<unknown>).call(manager, ...withTenant(requireSessionId(), {
        steps: input.steps,
        ...(executeContract ? { stopOn: input.stopOn } : {}),
        ...(maxDurationMs !== undefined ? { maxDurationMs } : {}),
        ...(maxResultBytes !== undefined ? { maxResultBytes } : {}),
      }, {
        ...(input.actionId !== undefined ? { actionId: input.actionId } : {}),
        ...(input.expectedPageRevision !== undefined ? { expectedPageRevision: input.expectedPageRevision } : {}),
        ...(input.expectedTabId !== undefined ? { expectedTabId: input.expectedTabId } : {}),
        ...(maxDurationMs !== undefined ? { maxDurationMs } : {}),
        ...(maxResultBytes !== undefined ? { maxResultBytes } : {}),
      }));
    }
  }
};

const define = (
  name: ToolName,
  description: string,
  schema: z.ZodTypeAny,
  method: keyof SessionManagerLike,
  annotations: ToolDefinition["annotations"],
): ToolDefinition => ({
  name,
  description,
  inputSchema: TOOL_INPUT_SCHEMAS[name],
  annotations,
  parse: (value) => schema.parse(value),
  invoke: (manager, input, tenantAuthenticator, authenticatedTenantId) =>
    call(manager, method, input, tenantAuthenticator, authenticatedTenantId),
});

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  define(
    "browser_start",
    "Start a policy-controlled, version-locked Playwright Firefox session.",
    BrowserStartSchema,
    "start",
    { title: "Start browser", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  ),
  define(
    "browser_status",
    "Read the current session state and challenge status.",
    BrowserStatusSchema,
    "status",
    { title: "Browser status", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  ),
  define(
    "browser_stop",
    "Stop and clean up a browser session.",
    BrowserStopSchema,
    "stop",
    { title: "Stop browser", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  ),
  define(
    "browser_reopen_headed",
    "Request a headed window for human takeover of a paused session.",
    BrowserReopenHeadedSchema,
    "reopenHeaded",
    { title: "Reopen headed", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  ),
  define(
    "browser_resume",
    "Resume automation only after an operator confirms the challenge is gone.",
    BrowserResumeSchema,
    "resume",
    { title: "Resume browser", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  ),
  define(
    "browser_handoff",
    "Transfer a headed browser to explicit user control and issue a short-lived one-time lease token.",
    BrowserHandoffSchema,
    "handoff",
    { title: "Hand off browser", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  ),
  define(
    "browser_takeover",
    "Return browser control to automation using the user-held lease token and explicit confirmation.",
    BrowserTakeoverSchema,
    "takeover",
    { title: "Resume agent control", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  ),
  define(
    "page_fetch",
    "Fetch a web page with the server URL policy using a read-only HTTP client.",
    PageFetchSchema,
    "fetch",
    { title: "Lightweight Fetch", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  ),
  define(
    "page_open",
    "Open an allowlisted HTTP(S) URL in the session's single controlled page.",
    PageOpenSchema,
    "open",
    { title: "Open page", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  ),
  define(
    "page_snapshot",
    "Read a bounded semantic snapshot with safe target descriptions.",
    PageSnapshotSchema,
    "snapshot",
    { title: "Page snapshot", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  ),
  define(
    "page_extract",
    "Extract structured batch data from the current page using containers and field selectors.",
    PageExtractSchema,
    "extract",
    { title: "Extract structured data", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  ),
  define(
    "page_screenshot",
    "Capture a server-generated screenshot artifact or image.",
    PageScreenshotSchema,
    "screenshot",
    { title: "Page screenshot", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  ),
  define(
    "page_click",
    "Click one uniquely resolved semantic target using a left button.",
    PageClickSchema,
    "click",
    { title: "Click target", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  ),
  define(
    "page_type",
    "Type bounded text into one uniquely resolved semantic target.",
    PageTypeSchema,
    "type",
    { title: "Type text", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  ),
  define(
    "page_select",
    "Select one option by value or label on a semantic select target.",
    PageSelectSchema,
    "select",
    { title: "Select option", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  ),
  define(
    "page_scroll",
    "Scroll by a bounded semantic amount in the current page.",
    PageScrollSchema,
    "scroll",
    { title: "Scroll page", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  ),
  define(
    "page_wait",
    "Wait for a bounded duration or a safe semantic condition.",
    PageWaitSchema,
    "wait",
    { title: "Wait page", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  ),
  define(
    "page_workflow",
    "Execute a bounded semantic browser workflow under the administrator-selected policy and stop-on-interrupt safety.",
    PageWorkflowSchema,
    "workflow",
    { title: "Run page workflow", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  ),
  define(
    "workspace_list",
    "List active browser workspaces using token-free ownership metadata.",
    WorkspaceListSchema,
    "listWorkspaces",
    { title: "List workspaces", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  ),
  define(
    "workspace_get",
    "Read one browser workspace ownership and retention record.",
    WorkspaceGetSchema,
    "getWorkspace",
    { title: "Get workspace", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  ),
  define(
    "workspace_handoff",
    "Transfer one workspace to explicit user control with a short-lived lease.",
    WorkspaceHandoffSchema,
    "workspaceHandoff",
    { title: "Hand off workspace", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  ),
  define(
    "workspace_resume",
    "Return one workspace to agent control after explicit human confirmation.",
    WorkspaceResumeSchema,
    "workspaceResume",
    { title: "Resume workspace", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  ),
  define(
    "page_workflow_execute",
    "Execute a bounded serial semantic browser workflow under the administrator-selected policy.",
    PageWorkflowExecuteSchema,
    "workflow",
    { title: "Execute page workflow", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  ),
  define(
    "page_list_tabs",
    "List isolated tabs and their bounded page revisions.",
    PageListTabsSchema,
    "listTabs",
    { title: "List tabs", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  ),
  define(
    "page_switch_tab",
    "Switch the active isolated tab used by subsequent page actions.",
    PageSwitchTabSchema,
    "switchTab",
    { title: "Switch tab", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  ),
  define(
    "page_close_tab",
    "Close one isolated tab and select a remaining tab when needed.",
    PageCloseTabSchema,
    "closeTab",
    { title: "Close tab", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  ),
  define(
    "browser_capabilities",
    "Describe supported tools, limits, policy flags, and forbidden primitives.",
    BrowserCapabilitiesSchema,
    "capabilities",
    { title: "Browser capabilities", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  ),
  define(
    "cluster_submit_task",
    "Submit an asynchronous crawling/scraping task to the distributed priority queue.",
    ClusterSubmitTaskSchema,
    "submitClusterTask",

    { title: "Submit cluster task", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  ),
  define(
    "cluster_batch_submit",
    "Submit a batch of crawling tasks to the distributed cluster queue.",
    ClusterBatchSubmitSchema,
    "submitClusterBatch",
    { title: "Batch submit tasks", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  ),
  define(
    "cluster_status",
    "Query the real-time status of distributed workers, queue capacity, and task counts.",
    ClusterStatusSchema,
    "getClusterStatus",
    { title: "Cluster status", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  ),
  define(
    "cluster_get_task",
    "Query the execution state and extracted result of a distributed task by taskId.",
    ClusterGetTaskSchema,
    "getClusterTask",
    { title: "Get task result", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  ),
  define(
    "profile_create",
    "Create a new persistent browser profile with optional proxy, GeoIP, and initial cookies.",
    ProfileCreateSchema,
    "createProfile",
    { title: "Create profile", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  ),
  define(
    "profile_list",
    "List all saved persistent browser profiles.",
    ProfileListSchema,
    "listProfiles",
    { title: "List profiles", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  ),
  define(
    "profile_get",
    "Get detailed metadata of a saved persistent browser profile by profileId.",
    ProfileGetSchema,
    "getProfile",
    { title: "Get profile", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  ),
  define(
    "profile_delete",
    "Delete a saved persistent browser profile and its storage directory.",
    ProfileDeleteSchema,
    "deleteProfile",
    { title: "Delete profile", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  ),
  define(
    "profile_export_cookies",
    "Export cookies of a saved profile in JSON or Netscape cookies.txt format.",
    ProfileExportCookiesSchema,
    "exportCookies",
    { title: "Export cookies", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  ),
  define(
    "profile_import_cookies",
    "Import cookies into a saved profile from JSON or Netscape format.",
    ProfileImportCookiesSchema,
    "importCookies",
    { title: "Import cookies", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  ),
  define(
    "proxy_check",
    "Check connectivity, measure latency, and test proxy server status.",
    ProxyCheckSchema,
    "checkProxy",
    { title: "Check proxy", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  ),
];

const TOOL_BY_NAME = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));

function invalidToolError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "INVALID_INPUT" });
}

function sessionIdFromInput(value: unknown): string | undefined {
  return value && typeof value === "object" && typeof (value as Record<string, unknown>).sessionId === "string"
    ? (value as Record<string, string>).sessionId
    : undefined;
}

function workspaceControlState(
  manager: SessionManagerLike,
  sessionId: string | undefined,
  tenantId?: string,
): WorkspaceControlState | undefined {
  if (!sessionId || typeof manager.getWorkspaceForSession !== "function") return undefined;
  try {
    const workspace = manager.getWorkspaceForSession(sessionId, tenantId);
    const state = workspace && typeof workspace === "object" ? (workspace as Record<string, unknown>).controlState : undefined;
    return state === 'AGENT_CONTROLLED' || state === 'USER_CONTROLLED' || state === 'INACTIVE' ? state : undefined;
  } catch {
    return undefined;
  }
}

function sessionState(
  manager: SessionManagerLike,
  sessionId: string | undefined,
  tenantId?: string,
): string | undefined {
  if (!sessionId || typeof manager.getSessionState !== "function") return undefined;
  try {
    const state = manager.getSessionState(sessionId, tenantId);
    return typeof state === "string"
      ? state
      : state && typeof state === "object" && typeof (state as Record<string, unknown>).state === "string"
        ? (state as Record<string, string>).state
        : undefined;
  } catch {
    return undefined;
  }
}

/** Dispatch one call without requiring a transport; useful for contract tests
 * and for embedding the same gateway in a host that already owns a transport. */
export async function handleToolCall(
  manager: SessionManagerLike,
  toolName: string,
  rawInput: unknown = {},
  options: McpServerOptions = {},
): Promise<McpToolResult> {
  const tool = TOOL_BY_NAME.get(toolName as ToolName);
  if (!tool) return errorResult(toolName, invalidToolError(`Unknown tool: ${toolName}`), rawInput);

  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  try {
    const parsed = tool.parse(rawInput);
    // Record only the stable tool name and phase. Raw input, credentials,
    // targets, URLs and page content never enter this control-plane event.
    await options.audit?.record({ action: "mcp_tool_call", phase: "attempt", toolName });
    const parsedRecord = parsed as Record<string, unknown>;
    const authenticatedTenantId = resolveToolTenant(toolName, parsedRecord, options.tenantAuthenticator);
    const sessionId = sessionIdFromInput(parsed);
    const controlState = workspaceControlState(manager, sessionId, authenticatedTenantId);
    const currentSessionState = sessionState(manager, sessionId, authenticatedTenantId);
    options.runtimeGuard?.beforeCall({
      ...(sessionId !== undefined ? { sessionId } : {}),
      toolName,
      write: WRITE_TOOL_NAMES.has(toolName),
      ...(controlState !== undefined ? { controlState } : {}),
      ...(currentSessionState !== undefined ? { sessionState: currentSessionState } : {}),
    });
    const value = await tool.invoke(manager, parsed, options.tenantAuthenticator, authenticatedTenantId);
    const result = successResult(toolName, value, parsed);
    options.runtimeGuard?.record(toolName, true, now() - startedAt);
    recordAuditBestEffort(options, {
      action: "mcp_tool_call",
      phase: "complete",
      toolName,
      outcome: "success",
      traceId: result.structuredContent?.traceId,
    });
    return result;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issueDetails = error.issues.slice(0, 16).map((issue) => ({
        path: issue.path.map(String).join("."),
        code: issue.code,
        message: issue.message,
      }));
      const workflowStepLimitExceeded = toolName === "page_workflow_execute"
        && error.issues.some((issue) => issue.path.length === 1 && issue.path[0] === "steps" && issue.code === "too_big");
      error = Object.assign(
        new Error(workflowStepLimitExceeded ? "The workflow contains too many steps." : "The request is invalid."),
        {
          code: workflowStepLimitExceeded ? "WORKFLOW_STEP_LIMIT_EXCEEDED" : "INVALID_INPUT",
          details: { issues: issueDetails },
        },
      );
    }
    const result = errorResult(toolName, error, rawInput);
    options.runtimeGuard?.record(toolName, false, now() - startedAt);
    recordAuditBestEffort(options, {
      action: "mcp_tool_call",
      phase: "complete",
      toolName,
      outcome: "error",
      errorCode: result.structuredContent?.error && typeof result.structuredContent.error === "object"
        ? (result.structuredContent.error as Record<string, unknown>).code
        : undefined,
      traceId: result.structuredContent?.traceId,
    });
    return result;
  }
}

/** Construct the low-level SDK server so tools/list remains exact and easy to contract-test. */
export function createMcpServer(manager: SessionManagerLike, options: McpServerOptions = {}): Server {
  const server = new Server(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map(({ name, description, inputSchema, annotations }) => ({
      name,
      description,
      inputSchema,
      annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const rawInput = request.params.arguments ?? {};
    // Zod and BrowserToolError remain tool-level errors instead of JSON-RPC
    // failures, so agents can branch on the stable error.code field.
    return (await handleToolCall(manager, toolName, rawInput, options)) as any;
  });

  return server;
}

export { TOOL_INPUT_SCHEMAS };
