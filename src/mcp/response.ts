import { randomUUID } from "node:crypto";

import type {
  BrowserToolErrorLike,
  JsonObject,
  ToolErrorEnvelope,
  ToolSuccessEnvelope,
} from "./types.js";

const ERROR_CODES = new Set([
  "INVALID_INPUT",
  "INVALID_ARGUMENT",
  "UNAUTHENTICATED",
  "PERMISSION_DENIED",
  "POLICY_DENIED",
  "DOMAIN_NOT_ALLOWED",
  "NETWORK_BLOCKED",
  "RESOURCE_BLOCKED",
  "DOWNLOAD_BLOCKED",
  "APPROVAL_REQUIRED",
  "SESSION_NOT_FOUND",
  "SESSION_EXPIRED",
  "WORKSPACE_NOT_FOUND",
  "SESSION_BUSY",
  "SESSION_PAUSED_CHALLENGE",
  "SESSION_STATE_CONFLICT",
  "USER_CONTROL_HARD_STOP",
  "WORKFLOW_STEP_LIMIT_EXCEEDED",
  "TAB_LIMIT_EXCEEDED",
  "INVALID_STATE",
  "SNAPSHOT_NOT_FOUND",
  "SNAPSHOT_EXPIRED",
  "SNAPSHOT_ID_CONFLICT",
  "PAGE_REVISION_MISMATCH",
  "STALE_TARGET",
  "TARGET_NOT_FOUND",
  "TARGET_AMBIGUOUS",
  "TARGET_NOT_ACTIONABLE",
  "NAVIGATION_DENIED",
  "NAVIGATION_BLOCKED",
  "PRIVATE_NETWORK_DENIED",
  "NAVIGATION_TIMEOUT",
  "ACTION_TIMEOUT",
  "TIMEOUT",
  "CHALLENGE_DETECTED",
  "CHALLENGE_REQUIRES_HUMAN",
  "AUTOMATION_PAUSED",
  "MANUAL_TAKEOVER_ACTIVE",
  "HUMAN_HANDOFF_EXPIRED",
  "TAKEOVER_UNAVAILABLE",
  "RATE_LIMITED",
  "RESOURCE_EXHAUSTED",
  "BROWSER_LAUNCH_FAILED",
  "BROWSER_CRASHED",
  "AUDIT_UNAVAILABLE",
  "INTERNAL",
  "INTERNAL_ERROR",
]);

const RETRYABLE_CODES = new Set([
  "SESSION_BUSY",
  "ACTION_TIMEOUT",
  "TIMEOUT",
  "RATE_LIMITED",
  "BROWSER_CRASHED",
  "PAGE_REVISION_MISMATCH",
]);

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  INVALID_INPUT: "The request is invalid.",
  SESSION_NOT_FOUND: "The browser session was not found.",
  WORKSPACE_NOT_FOUND: "The browser workspace was not found.",
  SESSION_PAUSED_CHALLENGE: "Automation is paused because a challenge was detected.",
  INVALID_STATE: "The session is in an invalid state for this operation.",
  USER_CONTROL_HARD_STOP: "Automation is stopped because the workspace is under user control.",
  WORKFLOW_STEP_LIMIT_EXCEEDED: "The workflow contains too many steps.",
  TAB_LIMIT_EXCEEDED: "The session has reached its tab limit.",
  NAVIGATION_DENIED: "Navigation was denied by policy.",
  NAVIGATION_BLOCKED: "Navigation was blocked by policy.",
  PRIVATE_NETWORK_DENIED: "The destination resolves to a protected network.",
  TARGET_NOT_FOUND: "The target was not found.",
  TARGET_AMBIGUOUS: "The target is ambiguous.",
  TARGET_NOT_ACTIONABLE: "The target is not actionable.",
  ACTION_ID_CONFLICT: "The action id was already used with different input.",
  SNAPSHOT_NOT_FOUND: "The base snapshot is not available.",
  SNAPSHOT_EXPIRED: "The base snapshot has expired.",
  SNAPSHOT_ID_CONFLICT: "The snapshot id conflicts with an existing observation.",
  PAGE_REVISION_MISMATCH: "The page changed; obtain a fresh snapshot.",
  ACTION_TIMEOUT: "The browser action timed out.",
  TIMEOUT: "The operation timed out.",
  BROWSER_LAUNCH_FAILED: "The browser could not be started.",
  INTERNAL_ERROR: "An internal error occurred.",
};

// Never put the underlying exception text on the wire for an internal
// failure.  Playwright/Node errors can contain local paths, browser launch
// arguments, or other implementation details that are not part of the MCP
// contract.
const INTERNAL_ERROR_MESSAGE = "An internal error occurred.";

const SENSITIVE_KEY = /(?:password|passwd|passcode|passphrase|secret|token|cookie|authorization|credential|private[-_]?key|api[-_]?key|text|value|input|body|payload|html|content|storage|header|form[-_]?data|dom|screenshot|clipboard|csrf|jwt|bearer)/i;
const PATH_KEY = /^(?:path|root|cwd|workdir|workingDirectory|.*(?:Path|Dir|Directory|DirectoryName|Filename|FileName))$/i;

function looksLikeHostPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\/(?:[^/\s]+\/)+[^/\s]*$/.test(value);
}

function randomTraceId(): string {
  // crypto.randomUUID is available in supported Node versions. Keep a small
  // fallback for test runners that provide a minimal crypto shim.
  try {
    return `tr_${randomUUID()}`;
  } catch {
    return `tr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

function safeString(value: unknown, fallback: string, max = 500): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/((?:password|passwd|secret|token|cookie|authorization|credential|text|value)\s*[:=]\s*)([^\s,;]+)/gi, "$1<redacted>")
    .replace(/(https?:\/\/[^\s<>'"`?#]+)(?:\?[^\s<>'"`]*)/gi, "$1")
    .slice(0, max);
}

/** Remove secrets and cap nested error data before it crosses MCP. */
export function redactErrorDetails(value: unknown, depth = 0): JsonObject {
  if (depth > 3 || value === null || typeof value !== "object") return {};
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) {
      result[key] = "<redacted>";
      continue;
    }
    if (PATH_KEY.test(key)) {
      result[key] = "<redacted>";
      continue;
    }
    if (typeof item === "string") {
      result[key] = looksLikeHostPath(item) ? "<redacted>" : safeString(item, "", 500);
    } else if (item && typeof item === "object") {
      result[key] = redactErrorDetails(item, depth + 1);
    } else if (typeof item === "number" || typeof item === "boolean" || item === null) {
      result[key] = item;
    }
  }
  return result;
}

export function errorCode(error: unknown): string {
  const typed = error as BrowserToolErrorLike | undefined;
  const code = typed?.code;
  if (typeof code === "string" && ERROR_CODES.has(code)) return code;
  // SessionManager.get currently reports a missing session as a plain
  // `Error("SESSION_NOT_FOUND")`; preserve that stable code at the gateway
  // instead of degrading it to an opaque internal failure.
  const messageCode = typeof typed?.message === "string" ? typed.message.trim() : "";
  return ERROR_CODES.has(messageCode) ? messageCode : "INTERNAL_ERROR";
}

export function toToolErrorEnvelope(error: unknown, input?: unknown): ToolErrorEnvelope {
  const typed = (error ?? {}) as BrowserToolErrorLike;
  const code = errorCode(error);
  const inputObject = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const inputSessionId = typeof inputObject.sessionId === "string" ? inputObject.sessionId : undefined;
  const sessionId = typeof typed.sessionId === "string" ? typed.sessionId : inputSessionId;
  const state = typeof typed.sessionState === "string" ? typed.sessionState : undefined;
  const isInternal = code === "INTERNAL_ERROR" || code === "INTERNAL";
  // Error text from Playwright, Node, or an injected launcher is not a public
  // contract. Even a known code can carry a caller-supplied message containing
  // an embedded host path (for example, "Timeout at C:\\private\\..."). Keep
  // all wire messages stable and code-derived; diagnostics belong in the
  // server-side audit trail.
  const message = isInternal
    ? INTERNAL_ERROR_MESSAGE
    : ERROR_MESSAGES[code] ?? `Browser operation failed (${code}).`;
  const retryable = typeof typed.retryable === "boolean" ? typed.retryable : RETRYABLE_CODES.has(code);
  // Internal details are intentionally discarded instead of merely
  // redacted.  The shape of an unknown exception is not stable and can
  // contain a path in a nested/cause field.
  const details = isInternal ? {} : redactErrorDetails(typed.details);
  return {
    ok: false,
    ...(sessionId ? { sessionId } : {}),
    ...(state ? { sessionState: state } : {}),
    traceId: typeof typed.traceId === "string" ? typed.traceId : randomTraceId(),
    timestamp: new Date().toISOString(),
    error: { code, message, retryable, details },
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function toToolSuccessEnvelope(raw: unknown, input?: unknown): ToolSuccessEnvelope {
  const record = asRecord(raw);
  if (record?.ok === true) {
    const inputObject = asRecord(input);
    const sessionId = typeof record.sessionId === "string" ? record.sessionId : typeof inputObject?.sessionId === "string" ? inputObject.sessionId : undefined;
    const sessionState = typeof record.sessionState === "string" ? record.sessionState : typeof record.state === "string" ? record.state : undefined;
    const revision = typeof record.revision === "number"
      ? record.revision
      : typeof record.pageRevision === "number"
        ? record.pageRevision
        : typeof record.pageGeneration === "number"
          ? record.pageGeneration
          : undefined;
    return {
      ...(record as ToolSuccessEnvelope),
      ...(sessionId ? { sessionId } : {}),
      ...(sessionState ? { sessionState } : {}),
      ...(revision !== undefined ? { revision } : {}),
      traceId: typeof record.traceId === "string" ? record.traceId : randomTraceId(),
      data: record.data !== undefined ? record.data : {},
      warnings: Array.isArray(record.warnings) ? record.warnings : [],
    };
  }
  const inputObject = asRecord(input);
  const sessionId = typeof record?.sessionId === "string" ? record.sessionId : typeof inputObject?.sessionId === "string" ? inputObject.sessionId : undefined;
  const sessionState = typeof record?.sessionState === "string" ? record.sessionState : typeof record?.state === "string" ? record.state : undefined;
  const revision = typeof record?.revision === "number"
    ? record.revision
    : typeof record?.pageRevision === "number"
      ? record.pageRevision
      : typeof record?.pageGeneration === "number"
        ? record.pageGeneration
        : undefined;
  const traceId = typeof record?.traceId === "string" ? record.traceId : randomTraceId();
  return {
    ok: true,
    ...(sessionId ? { sessionId } : {}),
    ...(sessionState ? { sessionState } : {}),
    ...(revision !== undefined ? { revision } : {}),
    traceId,
    data: raw,
    warnings: [],
  };
}

export interface McpTextContent {
  type: "text";
  text: string;
}

export interface McpImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface McpToolResult {
  content: Array<McpTextContent | McpImageContent>;
  structuredContent?: JsonObject;
  isError?: boolean;
}

function shortText(toolName: string, envelope: ToolSuccessEnvelope): string {
  const state = envelope.sessionState ? ` (${envelope.sessionState})` : "";
  return `${toolName} completed${state}.`;
}

function imageFromResult(value: unknown): McpImageContent | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const dataRecord = asRecord(record.data);
  const candidates = [
    asRecord(record.image),
    asRecord(dataRecord?.image),
    record,
    dataRecord,
  ];
  for (const source of candidates) {
    if (!source) continue;
    const data = source.data;
    const mimeType = source.mimeType ?? source.mediaType;
    if (
      typeof data === "string" &&
      data.length <= 11_200_000 &&
      data.length % 4 === 0 &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(data) &&
      (mimeType === "image/png" || mimeType === "image/jpeg")
    ) {
      // The manager owns screenshot generation; only already encoded image
      // data is forwarded. A caller cannot choose a path or read a local
      // file here.
      return { type: "image", data, mimeType };
    }
  }
  return undefined;
}

function screenshotArtifactRef(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const data = asRecord(record.data);
  const candidate = typeof record.artifactRef === "string"
    ? record.artifactRef
    : typeof data?.artifactRef === "string"
      ? data.artifactRef
      : undefined;
  if (candidate && /^[A-Za-z0-9_-]{1,180}$/.test(candidate)) return candidate;
  return undefined;
}

/**
 * Screenshot files are server-owned artifacts.  Keep the path entirely
 * inside the server by rebuilding the success envelope from an allowlisted
 * projection before it reaches MCP.  The optional encoded image is emitted
 * as an MCP image content block, never copied into structured JSON.
 */
function screenshotSuccessResult(raw: unknown, input?: unknown): McpToolResult {
  const source = asRecord(raw);
  const inputRecord = asRecord(input);
  const sessionId = typeof source?.sessionId === "string"
    ? source.sessionId
    : typeof inputRecord?.sessionId === "string"
      ? inputRecord.sessionId
      : undefined;
  const sessionState = typeof source?.sessionState === "string"
    ? source.sessionState
    : typeof source?.state === "string"
      ? source.state
      : undefined;
  const revision = typeof source?.revision === "number"
    ? source.revision
    : typeof source?.pageRevision === "number"
      ? source.pageRevision
      : typeof source?.pageGeneration === "number"
        ? source.pageGeneration
        : undefined;
  const traceId = typeof source?.traceId === "string" ? source.traceId : undefined;
  const artifactRef = screenshotArtifactRef(raw);
  const safeEnvelopeInput: JsonObject = {
    ok: true,
    ...(sessionId ? { sessionId } : {}),
    ...(sessionState ? { sessionState } : {}),
    ...(revision !== undefined ? { revision } : {}),
    ...(traceId ? { traceId } : {}),
    data: artifactRef ? { artifactRef } : {},
    warnings: [],
  };
  const envelope = toToolSuccessEnvelope(safeEnvelopeInput, input);
  const image = imageFromResult(raw);
  return {
    content: [
      { type: "text", text: shortText("page_screenshot", envelope) },
      ...(image ? [image] : []),
    ],
    structuredContent: envelope,
  };
}

export function successResult(toolName: string, raw: unknown, input?: unknown): McpToolResult {
  if (toolName === "page_screenshot") return screenshotSuccessResult(raw, input);
  const envelope = toToolSuccessEnvelope(raw, input);
  return {
    content: [
      { type: "text", text: shortText(toolName, envelope) },
    ],
    structuredContent: envelope,
  };
}

export function errorResult(toolName: string, error: unknown, input?: unknown): McpToolResult {
  const envelope = toToolErrorEnvelope(error, input);
  return {
    content: [{ type: "text", text: `${toolName} failed: ${envelope.error.message}` }],
    structuredContent: envelope,
    isError: true,
  };
}

export const stableErrorCodes = [...ERROR_CODES] as const;
