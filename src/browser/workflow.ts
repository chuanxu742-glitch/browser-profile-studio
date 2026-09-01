import { createHash } from 'node:crypto';

import type { Direction } from '../input/scheduler.js';
import {
  DEFAULT_AUTOMATION_POLICY,
  getAutomationPolicy,
  HARD_AUTOMATION_LIMITS,
} from './automation-policy.js';
import type { SemanticSnapshot } from './semantic-snapshot.js';

/**
 * A deliberately small, data-only workflow language.
 *
 * This module is kept independent from BrowserSession so that callers can
 * provide a server-owned adapter without giving a workflow access to a page,
 * locator, JavaScript evaluator, or CDP connection.  The concrete adapter is
 * expected to call the existing high-level BrowserSession methods.
 */

export interface WorkflowLimits {
  readonly maxSteps: number;
  readonly maxDurationMs: number;
  readonly maxResultBytes: number;
  readonly maxSnapshotBytes: number;
  readonly maxScrollAmount: number;
}

export const MAX_WORKFLOW_STEPS = HARD_AUTOMATION_LIMITS.maxWorkflowSteps;
export const MAX_WORKFLOW_DURATION_MS = HARD_AUTOMATION_LIMITS.maxWorkflowDurationMs;
export const MAX_WORKFLOW_RESULT_BYTES = HARD_AUTOMATION_LIMITS.maxWorkflowResultBytes;
export const DEFAULT_WORKFLOW_STEPS = getAutomationPolicy(DEFAULT_AUTOMATION_POLICY).limits.maxWorkflowSteps;
export const DEFAULT_WORKFLOW_DURATION_MS = getAutomationPolicy(DEFAULT_AUTOMATION_POLICY).limits.maxWorkflowDurationMs;
export const DEFAULT_WORKFLOW_RESULT_BYTES = getAutomationPolicy(DEFAULT_AUTOMATION_POLICY).limits.maxWorkflowResultBytes;
export const MIN_WORKFLOW_RESULT_BYTES = 100;

const DEFAULT_WORKFLOW_LIMITS: WorkflowLimits = Object.freeze({
  maxSteps: DEFAULT_WORKFLOW_STEPS,
  maxDurationMs: DEFAULT_WORKFLOW_DURATION_MS,
  maxResultBytes: DEFAULT_WORKFLOW_RESULT_BYTES,
  maxSnapshotBytes: getAutomationPolicy(DEFAULT_AUTOMATION_POLICY).limits.snapshotMaxSnapshotBytes,
  maxScrollAmount: getAutomationPolicy(DEFAULT_AUTOMATION_POLICY).limits.maxScrollAmount,
});

const MAX_ACTION_TIMEOUT_MS = HARD_AUTOMATION_LIMITS.maxWorkflowDurationMs;
const MAX_WAIT_DURATION_MS = 10_000;
const MAX_SNAPSHOT_CHARS = 50_000;
const MAX_SNAPSHOT_NODES = 2_000;
const MAX_SNAPSHOT_BYTES = HARD_AUTOMATION_LIMITS.snapshotMaxSnapshotBytes;
const MAX_TEXT_CHARS = 10_000;
const MAX_TARGET_CHARS = 500;
const MAX_TEST_ID_CHARS = 128;
const MAX_REF_CHARS = 100;

const ACTION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const OPAQUE_REF_PATTERN = /^ref_[A-Za-z0-9_-]{1,96}$/u;
const WORKFLOW_STOP_TRIGGERS = [
  'navigation',
  'challenge',
  'dialog',
  'download',
  'interrupt',
  'revision_mismatch',
  'error',
  'ambiguity',
  'timeout',
] as const;

export type WorkflowStopTrigger = (typeof WORKFLOW_STOP_TRIGGERS)[number];

export type WorkflowStopReason =
  | 'completed'
  | 'navigation'
  | 'challenge'
  | 'interrupt'
  | 'revision_mismatch'
  | 'error'
  | 'timeout';

export type WorkflowOperation =
  | 'open'
  | 'click'
  | 'type'
  | 'select'
  | 'scroll'
  | 'wait'
  | 'snapshot';

/** Public semantic target shape.  There is intentionally no selector field. */
export interface WorkflowSemanticTarget {
  role?: string;
  name?: string;
  exact?: boolean;
  label?: string;
  testId?: string;
  /** A short-lived opaque ref issued by page_snapshot. */
  ref?: string;
}

export type WorkflowTarget = string | WorkflowSemanticTarget;
export type WorkflowSelectChoice = string | { value: string } | { label: string };

export interface WorkflowOpenStep {
  op: 'open';
  url: string;
  waitUntil?: 'domcontentloaded' | 'load';
  timeoutMs?: number;
}

export interface WorkflowClickStep {
  op: 'click';
  target: WorkflowTarget;
  timeoutMs?: number;
}

export interface WorkflowTypeStep {
  op: 'type';
  target: WorkflowTarget;
  text: string;
  /** `clear` mirrors the MCP contract; `clearFirst` is accepted for adapters. */
  clear?: boolean;
  clearFirst?: boolean;
  submit?: boolean;
  sensitive?: boolean;
  timeoutMs?: number;
}

export interface WorkflowSelectStep {
  op: 'select';
  target: WorkflowTarget;
  value?: string;
  label?: string;
  /** Convenience form for callers that already have the choice object. */
  choice?: WorkflowSelectChoice;
  /** Declarative multi-select form; values execute serially within this step. */
  values?: readonly string[];
  timeoutMs?: number;
}

export interface WorkflowScrollStep {
  op: 'scroll';
  direction: Direction;
  amount?: number;
  target?: WorkflowTarget;
}

export interface WorkflowWaitCondition {
  ref: string;
  state: 'visible' | 'hidden' | 'enabled';
}

export interface WorkflowWaitStep {
  op: 'wait';
  /** `milliseconds` mirrors the MCP contract; `durationMs` is the native name. */
  milliseconds?: number;
  durationMs?: number;
  condition?: WorkflowWaitCondition;
  target?: WorkflowTarget;
  timeoutMs?: number;
}

export interface WorkflowSnapshotStep {
  op: 'snapshot';
  maxNodes?: number;
  maxChars?: number;
  maxBytes?: number;
  includeText?: boolean;
  compact?: boolean;
  format?: 'structured' | 'compact';
}

export type WorkflowStep =
  | WorkflowOpenStep
  | WorkflowClickStep
  | WorkflowTypeStep
  | WorkflowSelectStep
  | WorkflowScrollStep
  | WorkflowWaitStep
  | WorkflowSnapshotStep;

export interface WorkflowDefinition {
  steps: readonly WorkflowStep[];
  /** Workflow-level idempotency key. It is not reused for every step. */
  actionId?: string;
  /** Initial page revision precondition for the first write step. */
  expectedPageRevision?: number;
  /** Initial active-tab precondition for the first write step. */
  expectedTabId?: string;
  maxDurationMs?: number;
  maxResultBytes?: number;
  /** Additional stop conditions; safety-critical states still stop unconditionally. */
  stopOn?: readonly WorkflowStopTrigger[];
}

export type Workflow = WorkflowDefinition;

export interface WorkflowActionOptions {
  actionId?: string;
  expectedPageRevision?: number;
  expectedTabId?: string;
  timeoutMs?: number;
  waitUntil?: 'domcontentloaded' | 'load';
  clearFirst?: boolean;
  submit?: boolean;
  sensitive?: boolean;
  signal?: AbortSignal;
}

export interface WorkflowWaitRequest {
  durationMs?: number;
  condition?: WorkflowWaitCondition;
  target?: WorkflowTarget;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface WorkflowSnapshotOptions {
  maxNodes?: number;
  maxChars?: number;
  maxBytes?: number;
  includeText?: boolean;
  format?: 'structured' | 'compact';
  signal?: AbortSignal;
}

/** A safe subset of BrowserSession.status() understood by the executor. */
export interface WorkflowAdapterStatus {
  state?: string;
  tabId?: string;
  pageRevision?: number;
  pageGeneration?: number;
  challenge?: { detected?: boolean };
  interrupts?: {
    latestSequence?: number;
    total?: number;
    recent?: readonly { sequence?: number; type?: string }[];
  };
}

/**
 * The adapter is intentionally higher-level than Playwright.  A production
 * adapter should be a thin wrapper around BrowserSession and must not expose
 * page/evaluate/locator primitives here.
 */
export interface WorkflowAdapter {
  open(url: string, options?: WorkflowActionOptions): Promise<unknown>;
  click(target: WorkflowTarget, options?: WorkflowActionOptions): Promise<unknown>;
  type(target: WorkflowTarget, text: string, options?: WorkflowActionOptions): Promise<unknown>;
  select(target: WorkflowTarget, choice: WorkflowSelectChoice, options?: WorkflowActionOptions): Promise<unknown>;
  scroll(direction: Direction, amount: number, target?: WorkflowTarget, options?: WorkflowActionOptions): Promise<unknown>;
  wait(request: WorkflowWaitRequest): Promise<unknown>;
  snapshot(options?: WorkflowSnapshotOptions): Promise<unknown>;
  status?(): Promise<WorkflowAdapterStatus | unknown> | WorkflowAdapterStatus | unknown;
}

export interface WorkflowExecutionOptions {
  actionId?: string;
  expectedTabId?: string;
  expectedPageRevision?: number;
  maxDurationMs?: number;
  maxResultBytes?: number;
  signal?: AbortSignal;
}

export type WorkflowStepStatus = 'success' | 'error' | 'interrupted';

export interface WorkflowErrorSummary {
  code: string;
  retryable: boolean;
  message?: string;
  details?: { expectedPageRevision?: number; actualPageRevision?: number };
}

export interface WorkflowSnapshotSummary {
  tabId?: string;
  kind: 'snapshot';
  snapshotId?: string;
  pageRevision?: number;
  format?: 'structured' | 'compact';
  content?: string;
  contentBytes?: number;
  truncated?: boolean;
}

export type WorkflowStepSummary =
  | { kind: 'open'; url?: string; title?: string; pageRevision?: number }
  | { kind: 'click'; ref?: string; pageRevision?: number }
  | { kind: 'type'; ref?: string; length: number; pageRevision?: number }
  | { kind: 'select'; ref?: string; pageRevision?: number }
  | { kind: 'scroll'; direction: Direction; amount: number; pageRevision?: number }
  | { kind: 'wait'; waitedMs?: number; conditionMet?: boolean; pageRevision?: number }
  | WorkflowSnapshotSummary;

export interface WorkflowStepResult {
  index: number;
  op: WorkflowOperation;
  status: WorkflowStepStatus;
  ok: boolean;
  elapsedMs: number;
  pageRevision?: number;
  summary?: WorkflowStepSummary;
  error?: WorkflowErrorSummary;
}

export interface WorkflowResult {
  ok: boolean;
  status: 'completed' | 'stopped';
  stopReason: WorkflowStopReason;
  steps: WorkflowStepResult[];
  completedSteps: number;
  elapsedMs: number;
  resultBytes: number;
  truncated: boolean;
}

export class WorkflowValidationError extends Error {
  public readonly code: 'INVALID_WORKFLOW' | 'WORKFLOW_STEP_LIMIT_EXCEEDED';
  public readonly path: string;

  public constructor(
    message: string,
    path = 'workflow',
    code: 'INVALID_WORKFLOW' | 'WORKFLOW_STEP_LIMIT_EXCEEDED' = 'INVALID_WORKFLOW',
  ) {
    super(message);
    this.name = 'WorkflowValidationError';
    this.code = code;
    this.path = path;
  }
}

export class WorkflowActionIdConflictError extends Error {
  public readonly code = 'ACTION_ID_CONFLICT' as const;

  public constructor() {
    super('The workflow action id was already used with different input');
    this.name = 'WorkflowActionIdConflictError';
  }
}

class WorkflowTimeoutError extends Error {
  public readonly code = 'WORKFLOW_TIMEOUT' as const;

  public constructor() {
    super('Workflow deadline exceeded');
    this.name = 'WorkflowTimeoutError';
  }
}

interface NormalizedWorkflow {
  steps: WorkflowStep[];
  actionId?: string;
  expectedPageRevision?: number;
  expectedTabId?: string;
  maxDurationMs: number;
  maxResultBytes: number;
  stopOn: Set<WorkflowStopTrigger>;
}

interface NormalizedStatus {
  state?: string;
  tabId?: string;
  pageRevision?: number;
  challengeDetected: boolean;
  latestInterruptSequence?: number;
  recentInterruptTypes?: readonly string[];
  interruptTotal?: number;
}

interface ClassifiedFailure {
  code: string;
  reason: WorkflowStopReason;
  retryable: boolean;
  details?: { expectedPageRevision?: number; actualPageRevision?: number };
}

interface WorkflowCacheEntry {
  fingerprint: string;
  expiresAt: number;
  result: Promise<WorkflowResult>;
}

const WORKFLOW_CACHE_TTL_MS = 10 * 60 * 1_000;
const MAX_WORKFLOW_CACHE_ENTRIES = 256;
interface WorkflowValidationOptions {
  maxDurationMs?: number;
  maxResultBytes?: number;
  limits?: WorkflowLimits;
}

function clampLimit(value: number, minimum: number, maximum: number, fallback: number): number {
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, value));
}

export function resolveWorkflowLimits(limits?: WorkflowLimits): WorkflowLimits {
  const requested = limits ?? DEFAULT_WORKFLOW_LIMITS;
  return {
    maxSteps: clampLimit(requested.maxSteps, 1, MAX_WORKFLOW_STEPS, DEFAULT_WORKFLOW_STEPS),
    maxDurationMs: clampLimit(requested.maxDurationMs, 1, MAX_WORKFLOW_DURATION_MS, DEFAULT_WORKFLOW_DURATION_MS),
    maxResultBytes: clampLimit(requested.maxResultBytes, MIN_WORKFLOW_RESULT_BYTES, MAX_WORKFLOW_RESULT_BYTES, DEFAULT_WORKFLOW_RESULT_BYTES),
    maxSnapshotBytes: clampLimit(requested.maxSnapshotBytes, 100, MAX_SNAPSHOT_BYTES, DEFAULT_WORKFLOW_LIMITS.maxSnapshotBytes),
    maxScrollAmount: clampLimit(requested.maxScrollAmount, 1, HARD_AUTOMATION_LIMITS.maxScrollAmount, DEFAULT_WORKFLOW_LIMITS.maxScrollAmount),
  };
}

export function workflowLimitsForPolicy(limits: {
  maxWorkflowSteps: number;
  maxWorkflowDurationMs: number;
  maxWorkflowResultBytes: number;
  snapshotMaxSnapshotBytes: number;
  maxScrollAmount: number;
}): WorkflowLimits {
  return resolveWorkflowLimits({
    maxSteps: limits.maxWorkflowSteps,
    maxDurationMs: limits.maxWorkflowDurationMs,
    maxResultBytes: limits.maxWorkflowResultBytes,
    maxSnapshotBytes: limits.snapshotMaxSnapshotBytes,
    maxScrollAmount: limits.maxScrollAmount,
  });
}

/** Validate and normalize untrusted JSON before any adapter call. */
export function validateWorkflow(
  value: unknown,
  options: WorkflowValidationOptions = {},
): WorkflowDefinition {
  const normalized = normalizeWorkflow(value, options);
  return {
    steps: normalized.steps,
    ...(normalized.actionId !== undefined ? { actionId: normalized.actionId } : {}),
    ...(normalized.expectedPageRevision !== undefined ? { expectedPageRevision: normalized.expectedPageRevision } : {}),
    ...(normalized.expectedTabId !== undefined ? { expectedTabId: normalized.expectedTabId } : {}),
    maxDurationMs: normalized.maxDurationMs,
    maxResultBytes: normalized.maxResultBytes,
    stopOn: [...normalized.stopOn],
  };
}

function normalizeWorkflow(value: unknown, options: WorkflowValidationOptions = {}): NormalizedWorkflow {
  const workflow = record(value, 'workflow');
  const limits = resolveWorkflowLimits(options.limits);
  assertKeys(workflow, ['steps', 'actionId', 'expectedPageRevision', 'expectedTabId', 'maxDurationMs', 'maxResultBytes', 'stopOn'], 'workflow');

  if (!Array.isArray(workflow.steps)) fail('steps must be an array', 'workflow.steps');
  if (workflow.steps.length > limits.maxSteps) {
    fail(`at most ${limits.maxSteps} steps are allowed`, 'workflow.steps', 'WORKFLOW_STEP_LIMIT_EXCEEDED');
  }
  if (workflow.steps.length === 0) fail('at least one step is required', 'workflow.steps');

  const actionId = optionalString(workflow.actionId, 'workflow.actionId');
  if (actionId !== undefined && !ACTION_ID_PATTERN.test(actionId)) {
    fail('actionId must be a UUID', 'workflow.actionId');
  }
  const expectedPageRevision = optionalRevision(workflow.expectedPageRevision, 'workflow.expectedPageRevision');
  const expectedTabId = optionalTabId(workflow.expectedTabId, 'workflow.expectedTabId');

  const maxDurationCandidate = workflow.maxDurationMs ?? options.maxDurationMs ?? limits.maxDurationMs;
  const maxDurationMs = boundedInteger(maxDurationCandidate, 1, limits.maxDurationMs, -1);
  if (maxDurationMs < 1) fail(`maxDurationMs must be an integer from 1 to ${limits.maxDurationMs}`, 'workflow.maxDurationMs');

  const maxResultCandidate = workflow.maxResultBytes ?? options.maxResultBytes ?? limits.maxResultBytes;
  const maxResultBytes = boundedInteger(maxResultCandidate, MIN_WORKFLOW_RESULT_BYTES, limits.maxResultBytes, -1);
  if (maxResultBytes < MIN_WORKFLOW_RESULT_BYTES) {
    fail(`maxResultBytes must be an integer from ${MIN_WORKFLOW_RESULT_BYTES} to ${limits.maxResultBytes}`, 'workflow.maxResultBytes');
  }

  const stopOn = new Set<WorkflowStopTrigger>();
  if (workflow.stopOn !== undefined) {
    if (!Array.isArray(workflow.stopOn)) fail('stopOn must be an array', 'workflow.stopOn');
    for (const [index, valueItem] of (workflow.stopOn as unknown[]).entries()) {
      if (typeof valueItem !== 'string' || !(WORKFLOW_STOP_TRIGGERS as readonly string[]).includes(valueItem)) {
        fail('stopOn contains an unsupported trigger', `workflow.stopOn[${index}]`);
      }
      stopOn.add(valueItem as WorkflowStopTrigger);
    }
  }

  const steps = workflow.steps.map((step, index) => normalizeStep(step, `workflow.steps[${index}]`, limits));
  return {
    steps,
    ...(actionId !== undefined ? { actionId } : {}),
    ...(expectedPageRevision !== undefined ? { expectedPageRevision } : {}),
    ...(expectedTabId !== undefined ? { expectedTabId } : {}),
    maxDurationMs,
    maxResultBytes,
    stopOn,
  };
}

function normalizeStep(value: unknown, path: string, limits: WorkflowLimits): WorkflowStep {
  const step = record(value, path);
  const op = step.op;
  if (typeof op !== 'string' || !['open', 'click', 'type', 'select', 'scroll', 'wait', 'snapshot'].includes(op)) {
    fail('op must be one of open, click, type, select, scroll, wait, snapshot', `${path}.op`);
  }
  const operation = op as WorkflowOperation;
  switch (operation) {
    case 'open': {
      assertKeys(step, ['op', 'url', 'waitUntil', 'timeoutMs'], path);
      const waitUntil = optionalEnum(step.waitUntil, ['domcontentloaded', 'load'] as const, `${path}.waitUntil`);
      const timeoutMs = optionalTimeout(step.timeoutMs, `${path}.timeoutMs`);
      return {
        op: operation,
        url: validateUrl(step.url, `${path}.url`),
        ...(waitUntil !== undefined ? { waitUntil } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    }
    case 'click': {
      assertKeys(step, ['op', 'target', 'timeoutMs'], path);
      const timeoutMs = optionalTimeout(step.timeoutMs, `${path}.timeoutMs`);
      return {
        op: operation,
        target: validateTarget(step.target, `${path}.target`),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    }
    case 'type': {
      assertKeys(step, ['op', 'target', 'text', 'clear', 'clearFirst', 'submit', 'sensitive', 'timeoutMs'], path);
      if (typeof step.text !== 'string' || step.text.length > MAX_TEXT_CHARS) fail(`text must be at most ${MAX_TEXT_CHARS} characters`, `${path}.text`);
      if (step.clear !== undefined && typeof step.clear !== 'boolean') fail('clear must be boolean', `${path}.clear`);
      if (step.clearFirst !== undefined && typeof step.clearFirst !== 'boolean') fail('clearFirst must be boolean', `${path}.clearFirst`);
      if (step.clear !== undefined && step.clearFirst !== undefined && step.clear !== step.clearFirst) {
        fail('clear and clearFirst must agree when both are supplied', path);
      }
      if (step.submit !== undefined && typeof step.submit !== 'boolean') fail('submit must be boolean', `${path}.submit`);
      if (step.sensitive !== undefined && typeof step.sensitive !== 'boolean') fail('sensitive must be boolean', `${path}.sensitive`);
      const timeoutMs = optionalTimeout(step.timeoutMs, `${path}.timeoutMs`);
      return {
        op: operation,
        target: validateTarget(step.target, `${path}.target`),
        text: step.text,
        ...(step.clear !== undefined ? { clear: step.clear } : {}),
        ...(step.clearFirst !== undefined ? { clearFirst: step.clearFirst } : {}),
        ...(step.submit !== undefined ? { submit: step.submit } : {}),
        ...(step.sensitive !== undefined ? { sensitive: step.sensitive } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    }
    case 'select': {
      assertKeys(step, ['op', 'target', 'value', 'label', 'choice', 'values', 'timeoutMs'], path);
      const hasValue = step.value !== undefined;
      const hasLabel = step.label !== undefined;
      const hasChoice = step.choice !== undefined;
      const hasValues = step.values !== undefined;
      if (hasValues) {
        if (hasValue || hasLabel || hasChoice) fail('values cannot be combined with value, label, or choice', path);
        if (!Array.isArray(step.values) || step.values.length < 1 || step.values.length > 32) {
          fail('values must contain 1 to 32 options', `${path}.values`);
        }
        for (const [index, value] of step.values.entries()) {
          if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
            fail('each select value must be a bounded non-empty string', `${path}.values.${index}`);
          }
        }
      } else if (hasChoice && (hasValue || hasLabel)) {
        fail('choice cannot be combined with value or label', path);
      } else if (!hasChoice && hasValue === hasLabel) {
        fail('select requires exactly one of value or label', path);
      }
      let choice: WorkflowSelectChoice | undefined;
      if (hasChoice) choice = validateChoice(step.choice, `${path}.choice`);
      else if (!hasValues) {
        if (hasValue && (typeof step.value !== 'string' || step.value.length === 0 || step.value.length > 1_000)) fail('value is invalid or too long', `${path}.value`);
        if (hasLabel && (typeof step.label !== 'string' || step.label.length === 0 || step.label.length > 1_000)) fail('label is invalid or too long', `${path}.label`);
        choice = hasValue ? { value: step.value as string } : { label: step.label as string };
      }
      const timeoutMs = optionalTimeout(step.timeoutMs, `${path}.timeoutMs`);
      return {
        op: operation,
        target: validateTarget(step.target, `${path}.target`),
        ...(choice !== undefined ? { choice } : {}),
        ...(hasValues ? { values: [...(step.values as unknown[])] as string[] } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    }
    case 'scroll': {
      assertKeys(step, ['op', 'direction', 'amount', 'target'], path);
      const direction = optionalEnum(step.direction, ['up', 'down', 'left', 'right'] as const, `${path}.direction`);
      if (direction === undefined) fail('direction is required', `${path}.direction`);
      const amount = step.amount === undefined ? 1 : optionalBoundedInteger(step.amount, 1, limits.maxScrollAmount, `${path}.amount`);
      if (amount === undefined) fail('amount is required', `${path}.amount`);
      return {
        op: operation,
        direction,
        amount,
        ...(step.target !== undefined ? { target: validateTarget(step.target, `${path}.target`) } : {}),
      };
    }
    case 'wait': {
      assertKeys(step, ['op', 'milliseconds', 'durationMs', 'condition', 'target', 'timeoutMs'], path);
      const hasMilliseconds = step.milliseconds !== undefined;
      const hasDuration = step.durationMs !== undefined;
      if (hasMilliseconds && hasDuration) fail('milliseconds and durationMs cannot both be supplied', path);
      const durationMs = hasMilliseconds ? validateWaitDuration(step.milliseconds, `${path}.milliseconds`) : hasDuration ? validateWaitDuration(step.durationMs, `${path}.durationMs`) : undefined;
      const condition = step.condition === undefined ? undefined : validateCondition(step.condition, `${path}.condition`);
      const target = step.target === undefined ? undefined : validateTarget(step.target, `${path}.target`);
      if (durationMs === undefined && condition === undefined && target === undefined) fail('wait requires milliseconds/durationMs, condition, or target', path);
      if (durationMs !== undefined && (condition !== undefined || target !== undefined)) fail('wait cannot combine a duration with a condition or target', path);
      if (condition !== undefined && target !== undefined) fail('wait cannot combine condition and target', path);
      const timeoutMs = step.timeoutMs === undefined ? undefined : validateWaitDuration(step.timeoutMs, `${path}.timeoutMs`);
      return {
        op: operation,
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(condition !== undefined ? { condition } : {}),
        ...(target !== undefined ? { target } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    }
    case 'snapshot': {
      assertKeys(step, ['op', 'maxNodes', 'maxChars', 'maxBytes', 'includeText', 'compact', 'format'], path);
      const maxNodes = optionalBoundedInteger(step.maxNodes, 1, MAX_SNAPSHOT_NODES, `${path}.maxNodes`);
      const maxChars = optionalBoundedInteger(step.maxChars, 100, MAX_SNAPSHOT_CHARS, `${path}.maxChars`);
      const maxBytes = optionalBoundedInteger(step.maxBytes, 100, Math.min(MAX_SNAPSHOT_BYTES, limits.maxSnapshotBytes), `${path}.maxBytes`);
      if (step.includeText !== undefined && typeof step.includeText !== 'boolean') fail('includeText must be boolean', `${path}.includeText`);
      if (step.compact !== undefined && typeof step.compact !== 'boolean') fail('compact must be boolean', `${path}.compact`);
      const format = optionalEnum(step.format, ['structured', 'compact'] as const, `${path}.format`);
      if (step.compact !== undefined && format !== undefined && step.compact !== (format === 'compact')) {
        fail('compact and format must agree when both are supplied', path);
      }
      return {
        op: operation,
        ...(maxNodes !== undefined ? { maxNodes } : {}),
        ...(maxChars !== undefined ? { maxChars } : {}),
        ...(maxBytes !== undefined ? { maxBytes } : {}),
        ...(step.includeText !== undefined ? { includeText: step.includeText } : {}),
        ...(step.compact !== undefined ? { compact: step.compact } : {}),
        ...(format !== undefined ? { format } : {}),
      };
    }
  }
}

function validateTarget(value: unknown, path: string): WorkflowTarget {
  if (typeof value === 'string') {
    if (!OPAQUE_REF_PATTERN.test(value) || value.length > MAX_REF_CHARS) fail('string targets must be opaque snapshot refs', path);
    return value;
  }
  const target = record(value, path);
  assertKeys(target, ['role', 'name', 'exact', 'label', 'testId', 'ref'], path);
  const hasRole = target.role !== undefined || target.name !== undefined;
  const hasLabel = target.label !== undefined;
  const hasTestId = target.testId !== undefined;
  const hasRef = target.ref !== undefined;
  const strategies = Number(hasRole) + Number(hasLabel) + Number(hasTestId) + Number(hasRef);
  if (strategies !== 1) fail('target must contain exactly one semantic strategy', path);
  if (hasRole) {
    if (typeof target.role !== 'string' || target.role.length === 0 || target.role.length > 64) fail('role is invalid', `${path}.role`);
    if (typeof target.name !== 'string' || target.name.length === 0 || target.name.length > MAX_TARGET_CHARS) fail('name is required and bounded', `${path}.name`);
    if (target.exact !== undefined && typeof target.exact !== 'boolean') fail('exact must be boolean', `${path}.exact`);
    return {
      role: target.role,
      name: target.name,
      ...(target.exact !== undefined ? { exact: target.exact } : {}),
    };
  }
  if (hasLabel) {
    if (typeof target.label !== 'string' || target.label.length === 0 || target.label.length > MAX_TARGET_CHARS) fail('label is invalid or too long', `${path}.label`);
    if (target.exact !== undefined && typeof target.exact !== 'boolean') fail('exact must be boolean', `${path}.exact`);
    return { label: target.label, ...(target.exact !== undefined ? { exact: target.exact } : {}) };
  }
  if (hasTestId) {
    if (typeof target.testId !== 'string' || target.testId.length === 0 || target.testId.length > MAX_TEST_ID_CHARS) fail('testId is invalid or too long', `${path}.testId`);
    if (target.exact !== undefined) fail('exact is only valid for role/name or label targets', `${path}.exact`);
    return { testId: target.testId };
  }
  if (target.exact !== undefined) fail('exact is only valid for role/name or label targets', `${path}.exact`);
  if (typeof target.ref !== 'string' || !OPAQUE_REF_PATTERN.test(target.ref) || target.ref.length > MAX_REF_CHARS) fail('ref must be an opaque snapshot ref', `${path}.ref`);
  return { ref: target.ref };
}

function validateChoice(value: unknown, path: string): WorkflowSelectChoice {
  if (typeof value === 'string') {
    if (value.length === 0 || value.length > 1_000) fail('choice string is invalid or too long', path);
    return value;
  }
  const choice = record(value, path);
  assertKeys(choice, ['value', 'label'], path);
  const hasValue = choice.value !== undefined;
  const hasLabel = choice.label !== undefined;
  if (hasValue === hasLabel) fail('choice requires exactly one of value or label', path);
  const selected = hasValue ? choice.value : choice.label;
  if (typeof selected !== 'string' || selected.length === 0 || selected.length > 1_000) fail('choice is invalid or too long', path);
  return hasValue ? { value: selected } : { label: selected };
}

function validateCondition(value: unknown, path: string): WorkflowWaitCondition {
  const condition = record(value, path);
  assertKeys(condition, ['ref', 'state'], path);
  if (typeof condition.ref !== 'string' || !OPAQUE_REF_PATTERN.test(condition.ref) || condition.ref.length > MAX_REF_CHARS) fail('condition ref must be an opaque snapshot ref', `${path}.ref`);
  const state = optionalEnum(condition.state, ['visible', 'hidden', 'enabled'] as const, `${path}.state`);
  if (state === undefined) fail('condition state is required', `${path}.state`);
  return { ref: condition.ref, state };
}

function validateUrl(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) fail('url must be a bounded absolute HTTP(S) URL', path);
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('url must be an absolute HTTP(S) URL without credentials', path);
  } catch {
    fail('url must be an absolute HTTP(S) URL', path);
  }
  return value;
}

function validateWaitDuration(value: unknown, path: string): number {
  const result = boundedInteger(value, 1, MAX_WAIT_DURATION_MS, -1);
  if (result < 1) fail(`duration must be an integer from 1 to ${MAX_WAIT_DURATION_MS}`, path);
  return result;
}

function optionalTimeout(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  const result = boundedInteger(value, 1, MAX_ACTION_TIMEOUT_MS, -1);
  if (result < 1) fail(`timeoutMs must be an integer from 1 to ${MAX_ACTION_TIMEOUT_MS}`, path);
  return result;
}

function optionalRevision(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail('revision must be a non-negative safe integer', path);
  return value;
}
function optionalTabId(value: unknown, path: string): string | undefined {
  const tabId = optionalString(value, path);
  if (tabId === undefined) return undefined;
  if (tabId.length > 100 || /[\u0000-\u001f\u007f]/u.test(tabId)) fail('tabId must be a bounded opaque string', path);
  return tabId;
}

function optionalBoundedInteger(value: unknown, minimum: number, maximum: number, path: string): number | undefined {
  if (value === undefined) return undefined;
  const result = boundedInteger(value, minimum, maximum, -1);
  if (result < minimum) fail(`value must be an integer from ${minimum} to ${maximum}`, path);
  return result;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) fail('value must be a non-empty string', path);
  return value;
}

function optionalEnum<T extends string>(value: unknown, allowed: readonly T[], path: string): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) fail('value is not supported', path);
  return value as T;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isSafeInteger(value)) return fallback;
  if (value < minimum || value > maximum) return fallback;
  return value;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected an object', path);
  return value as Record<string, unknown>;
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail(`unsupported field "${key}"`, `${path}.${key}`);
  }
}

function fail(
  message: string,
  path: string,
  code: 'INVALID_WORKFLOW' | 'WORKFLOW_STEP_LIMIT_EXCEEDED' = 'INVALID_WORKFLOW',
): never {
  throw new WorkflowValidationError(message, path, code);
}

function isWriteStep(step: WorkflowStep): boolean {
  return step.op === 'open' || step.op === 'click' || step.op === 'type' || step.op === 'select' || step.op === 'scroll';
}

function adapterTarget(target: WorkflowTarget): WorkflowTarget {
  if (typeof target === 'string') return target;
  // BrowserSession accepts a string ref, whereas MCP JSON commonly represents
  // a ref as { ref }. Convert only that safe form; never pass selector-like
  // compatibility fields through this boundary.
  if (target.ref !== undefined) return target.ref;
  return target;
}

function safeRevision(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function resultRevision(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const recordValue = value as Record<string, unknown>;
  return safeRevision(recordValue.pageRevision) ?? safeRevision(recordValue.pageGeneration) ?? safeRevision(recordValue.generation);
}

function safeOpaque(value: unknown, max = 100): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, max);
  return cleaned.length > 0 ? cleaned : undefined;
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    return `${url.origin}${url.pathname}`.slice(0, 2_048);
  } catch {
    return undefined;
  }
}

function safeTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const title = value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 500);
  return title || undefined;
}

function safeContent(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').slice(0, MAX_SNAPSHOT_BYTES);
}

function rawRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function safeStepSummary(step: WorkflowStep, raw: unknown, revision?: number): WorkflowStepSummary {
  const value = rawRecord(raw);
  const rawRevision = revision ?? resultRevision(raw);
  switch (step.op) {
    case 'open': {
      const url = safeUrl(value.url) ?? safeUrl(step.url);
      const title = safeTitle(value.title);
      return {
        kind: 'open',
        ...(url !== undefined ? { url } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(rawRevision !== undefined ? { pageRevision: rawRevision } : {}),
      };
    }
    case 'click': {
      const ref = safeOpaque(value.ref ?? (typeof step.target === 'string' ? step.target : step.target.ref));
      return { kind: 'click', ...(ref !== undefined ? { ref } : {}), ...(rawRevision !== undefined ? { pageRevision: rawRevision } : {}) };
    }
    case 'type': {
      const ref = safeOpaque(value.ref ?? (typeof step.target === 'string' ? step.target : step.target.ref));
      const length = typeof value.length === 'number' && Number.isSafeInteger(value.length) && value.length >= 0 ? value.length : step.text.length;
      return { kind: 'type', ...(ref !== undefined ? { ref } : {}), length, ...(rawRevision !== undefined ? { pageRevision: rawRevision } : {}) };
    }
    case 'select': {
      const ref = safeOpaque(value.ref ?? (typeof step.target === 'string' ? step.target : step.target.ref));
      return { kind: 'select', ...(ref !== undefined ? { ref } : {}), ...(rawRevision !== undefined ? { pageRevision: rawRevision } : {}) };
    }
    case 'scroll': {
      const amount = typeof value.amount === 'number' && [1, 2, 3].includes(value.amount) ? value.amount as 1 | 2 | 3 : step.amount ?? 1;
      const direction = value.direction === 'up' || value.direction === 'down' || value.direction === 'left' || value.direction === 'right'
        ? value.direction
        : step.direction;
      return { kind: 'scroll', direction, amount, ...(rawRevision !== undefined ? { pageRevision: rawRevision } : {}) };
    }
    case 'wait': {
      const waitedMs = typeof value.waitedMs === 'number' && Number.isFinite(value.waitedMs) && value.waitedMs >= 0 ? Math.min(MAX_WAIT_DURATION_MS, Math.floor(value.waitedMs)) : undefined;
      const conditionMet = typeof value.conditionMet === 'boolean' ? value.conditionMet : undefined;
      return { kind: 'wait', ...(waitedMs !== undefined ? { waitedMs } : {}), ...(conditionMet !== undefined ? { conditionMet } : {}), ...(rawRevision !== undefined ? { pageRevision: rawRevision } : {}) };
    }
    case 'snapshot': {
      const snapshot = raw as Partial<SemanticSnapshot>;
      const snapshotId = safeOpaque(snapshot && snapshot.snapshotId, 128);
      const tabId = safeOpaque(snapshot && snapshot.tabId, 100);
      const content = safeContent(snapshot && snapshot.content);
      const contentBytes = typeof snapshot?.contentBytes === 'number' && Number.isSafeInteger(snapshot.contentBytes) && snapshot.contentBytes >= 0
        ? Math.min(MAX_SNAPSHOT_BYTES, snapshot.contentBytes)
        : content === undefined ? undefined : Buffer.byteLength(content, 'utf8');
      const format = snapshot?.format === 'compact' || snapshot?.format === 'structured' ? snapshot.format : undefined;
      const truncated = snapshot?.truncated && typeof snapshot.truncated === 'object'
        ? Boolean((snapshot.truncated as { content?: unknown }).content)
        : undefined;
      return {
        ...(tabId !== undefined ? { tabId } : {}),
        kind: 'snapshot',
        ...(snapshotId !== undefined ? { snapshotId } : {}),
        ...(rawRevision !== undefined ? { pageRevision: rawRevision } : {}),
        ...(format !== undefined ? { format } : {}),
        ...(content !== undefined ? { content } : {}),
        ...(contentBytes !== undefined ? { contentBytes } : {}),
        ...(truncated !== undefined ? { truncated } : {}),
      };
    }
  }
}

function normalizeStatus(value: unknown): NormalizedStatus {
  const status = rawRecord(value);
  const challenge = rawRecord(status.challenge);
  const interrupts = rawRecord(status.interrupts);
  const state = typeof status.state === 'string' ? status.state : undefined;
  const tabId = safeOpaque(status.tabId, 100);
  const pageRevision = safeRevision(status.pageRevision) ?? safeRevision(status.pageGeneration);
  const latestInterruptSequence = safeRevision(interrupts.latestSequence);
  const interruptTotal = safeRevision(interrupts.total);
  const recentInterruptTypes = Array.isArray(interrupts.recent)
    ? interrupts.recent
      .map((event) => rawRecord(event).type)
      .filter((type): type is string => typeof type === 'string')
    : [];
  return {
    ...(state !== undefined ? { state } : {}),
    ...(tabId !== undefined ? { tabId } : {}),
    ...(pageRevision !== undefined ? { pageRevision } : {}),
    challengeDetected: challenge.detected === true || state === 'PAUSED_CHALLENGE',
    ...(latestInterruptSequence !== undefined ? { latestInterruptSequence } : {}),
    ...(recentInterruptTypes.length > 0 ? { recentInterruptTypes } : {}),
    ...(interruptTotal !== undefined ? { interruptTotal } : {}),
  };
}

function isInterruptCode(code: string): boolean {
  return /(?:POPUP|DIALOG|DOWNLOAD|INTERRUPT|PAGE_CRASHED|CONTEXT_CLOSED)/iu.test(code);
}

function classifyFailure(error: unknown): ClassifiedFailure {
  const value = rawRecord(error);
  const code = typeof value.code === 'string' ? value.code : 'INTERNAL';
  const retryable = value.retryable === true;
  const detailsValue = rawRecord(value.details);
  const expectedPageRevision = safeRevision(detailsValue.expectedPageRevision);
  const actualPageRevision = safeRevision(detailsValue.actualPageRevision);
  const details = code === 'PAGE_REVISION_MISMATCH' && (expectedPageRevision !== undefined || actualPageRevision !== undefined)
    ? {
      ...(expectedPageRevision !== undefined ? { expectedPageRevision } : {}),
      ...(actualPageRevision !== undefined ? { actualPageRevision } : {}),
    }
    : undefined;
  if (error instanceof WorkflowTimeoutError || code === 'WORKFLOW_TIMEOUT' || code === 'ACTION_TIMEOUT') {
    return { code, reason: 'timeout', retryable: true, ...(details && Object.keys(details).length > 0 ? { details } : {}) };
  }
  if (code === 'SESSION_PAUSED_CHALLENGE' || /challenge/iu.test(code)) return { code, reason: 'challenge', retryable, ...(details && Object.keys(details).length > 0 ? { details } : {}) };
  if (code === 'PAGE_REVISION_MISMATCH') return { code, reason: 'revision_mismatch', retryable: true, ...(details && Object.keys(details).length > 0 ? { details } : {}) };
  if (isInterruptCode(code)) return { code, reason: 'interrupt', retryable, ...(details && Object.keys(details).length > 0 ? { details } : {}) };
  return { code, reason: 'error', retryable, ...(details && Object.keys(details).length > 0 ? { details } : {}) };
}

function safeErrorMessage(code: string): string {
  switch (code) {
    case 'SESSION_PAUSED_CHALLENGE': return 'Automation paused for human challenge handling.';
    case 'PAGE_REVISION_MISMATCH': return 'The page changed; obtain a fresh snapshot.';
    case 'WORKFLOW_TIMEOUT':
    case 'ACTION_TIMEOUT': return 'The workflow deadline was exceeded.';
    case 'TARGET_AMBIGUOUS': return 'The target was ambiguous.';
    case 'TARGET_NOT_FOUND': return 'The target was not found.';
    case 'NAVIGATION_DENIED':
    case 'PRIVATE_NETWORK_DENIED': return 'Navigation was denied by policy.';
    default: return 'The workflow step failed.';
  }
}

function errorSummary(failure: ClassifiedFailure): WorkflowErrorSummary {
  return {
    code: failure.code,
    retryable: failure.retryable,
    message: safeErrorMessage(failure.code),
    ...(failure.details ? { details: failure.details } : {}),
  };
}

function statusStopReason(
  before: NormalizedStatus | undefined,
  after: NormalizedStatus | undefined,
  stopOn: ReadonlySet<WorkflowStopTrigger>,
): WorkflowStopReason | undefined {
  if (!after) return undefined;
  if (after.challengeDetected && !before?.challengeDetected) return 'challenge';
  if (after.state === 'HUMAN_TAKEOVER' || after.state === 'ERROR') return 'interrupt';
  const sequenceChanged = after.latestInterruptSequence !== undefined
    && before?.latestInterruptSequence !== undefined
    && after.latestInterruptSequence > before.latestInterruptSequence;
  const totalChanged = after.interruptTotal !== undefined
    && before?.interruptTotal !== undefined
    && after.interruptTotal > before.interruptTotal;
  if (!sequenceChanged && !totalChanged) return undefined;
  const latestType = after.recentInterruptTypes?.at(-1);
  const defaultsStopOnInterrupts = stopOn.size === 0;
  if (latestType === 'DIALOG_BLOCKED') {
    return defaultsStopOnInterrupts || stopOn.has('dialog') || stopOn.has('interrupt') ? 'interrupt' : undefined;
  }
  if (latestType === 'DOWNLOAD_BLOCKED') {
    return defaultsStopOnInterrupts || stopOn.has('download') || stopOn.has('interrupt') ? 'interrupt' : undefined;
  }
  // Popup admission, page crashes, takeover transitions, and unknown
  // interrupt types remain mandatory safety stops.
  return 'interrupt';
}

function rawStopReason(
  value: unknown,
  stopOn: ReadonlySet<WorkflowStopTrigger> = new Set(),
): WorkflowStopReason | undefined {
  const raw = rawRecord(value);
  const defaultsStopOnInterrupts = stopOn.size === 0;
  if (raw.challenge === true || raw.challengeDetected === true) return 'challenge';
  const interruptType = typeof raw.interruptType === 'string' ? raw.interruptType : undefined;
  if (interruptType === 'DIALOG_BLOCKED') {
    return defaultsStopOnInterrupts || stopOn.has('dialog') || stopOn.has('interrupt') ? 'interrupt' : undefined;
  }
  if (interruptType === 'DOWNLOAD_BLOCKED') {
    return defaultsStopOnInterrupts || stopOn.has('download') || stopOn.has('interrupt') ? 'interrupt' : undefined;
  }
  if (interruptType !== undefined || raw.interrupted === true || raw.interrupt !== undefined) return 'interrupt';
  const nested = normalizeStatus(raw.status);
  if (nested.challengeDetected) return 'challenge';
  if (nested.latestInterruptSequence !== undefined || nested.interruptTotal !== undefined) {
    // A standalone result may contain an interrupt projection without a
    // baseline. Only an explicit blocked/interrupted marker is actionable.
    if (raw.blocked === true || raw.interrupted === true) {
      const latestType = nested.recentInterruptTypes?.at(-1);
      if (latestType === 'DIALOG_BLOCKED') {
        return defaultsStopOnInterrupts || stopOn.has('dialog') || stopOn.has('interrupt') ? 'interrupt' : undefined;
      }
      if (latestType === 'DOWNLOAD_BLOCKED') {
        return defaultsStopOnInterrupts || stopOn.has('download') || stopOn.has('interrupt') ? 'interrupt' : undefined;
      }
      return 'interrupt';
    }
  }
  return undefined;
}

function navigationDetected(before: NormalizedStatus | undefined, after: NormalizedStatus | undefined, raw: unknown): boolean {
  const beforeRevision = before?.pageRevision;
  const afterRevision = after?.pageRevision ?? resultRevision(raw);
  return beforeRevision !== undefined && afterRevision !== undefined && beforeRevision !== afterRevision;
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  const recordValue = value as Record<string, unknown>;
  return `{${Object.keys(recordValue).sort().map((key) => `${JSON.stringify(key)}:${stableJson(recordValue[key])}`).join(',')}}`;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function cloneResult(value: WorkflowResult): WorkflowResult {
  return JSON.parse(JSON.stringify(value)) as WorkflowResult;
}

/**
 * Executes a validated, finite workflow. Runtime action errors are represented
 * in the result so callers receive a useful step timeline; malformed workflow
 * data still throws WorkflowValidationError before the adapter is touched.
 */
export class WorkflowExecutor {
  private readonly adapter: WorkflowAdapter;
  private readonly now: () => number;
  private readonly limits: WorkflowLimits;
  private readonly cache = new Map<string, WorkflowCacheEntry>();

  public constructor(adapter: WorkflowAdapter, options: { now?: () => number; limits?: WorkflowLimits } = {}) {
    this.adapter = adapter;
    this.now = options.now ?? Date.now;
    this.limits = resolveWorkflowLimits(options.limits);
  }

  public run(workflow: WorkflowDefinition, options: WorkflowExecutionOptions = {}): Promise<WorkflowResult> {
    const normalized = normalizeWorkflow(workflow, {
      ...(options.maxDurationMs !== undefined ? { maxDurationMs: options.maxDurationMs } : {}),
      ...(options.maxResultBytes !== undefined ? { maxResultBytes: options.maxResultBytes } : {}),
      limits: this.limits,
    });
    const actionId = options.actionId ?? normalized.actionId;
    if (options.actionId !== undefined && !ACTION_ID_PATTERN.test(options.actionId)) fail('actionId must be a UUID', 'options.actionId');
    const expectedPageRevision = options.expectedPageRevision ?? normalized.expectedPageRevision;
    const expectedTabId = options.expectedTabId ?? normalized.expectedTabId;
    if (options.expectedPageRevision !== undefined) optionalRevision(options.expectedPageRevision, 'options.expectedPageRevision');
    if (options.expectedTabId !== undefined) optionalTabId(options.expectedTabId, 'options.expectedTabId');
    const maxDurationMs = options.maxDurationMs ?? normalized.maxDurationMs;
    const maxResultBytes = options.maxResultBytes ?? normalized.maxResultBytes;
    if (options.maxDurationMs !== undefined) {
      const checked = boundedInteger(options.maxDurationMs, 1, this.limits.maxDurationMs, -1);
      if (checked < 1) fail(`maxDurationMs must be an integer from 1 to ${this.limits.maxDurationMs}`, 'options.maxDurationMs');
    }
    if (options.maxResultBytes !== undefined) {
      const checked = boundedInteger(options.maxResultBytes, MIN_WORKFLOW_RESULT_BYTES, this.limits.maxResultBytes, -1);
      if (checked < MIN_WORKFLOW_RESULT_BYTES) fail(`maxResultBytes must be an integer from ${MIN_WORKFLOW_RESULT_BYTES} to ${this.limits.maxResultBytes}`, 'options.maxResultBytes');
    }

    const request = {
      steps: normalized.steps,
      ...(expectedPageRevision !== undefined ? { expectedPageRevision } : {}),
      ...(expectedTabId !== undefined ? { expectedTabId } : {}),
      maxDurationMs,
      maxResultBytes,
      stopOn: [...normalized.stopOn].sort(),
    };
    const now = this.now();
    this.pruneCache(now);
    if (actionId !== undefined) {
      const requestFingerprint = fingerprint(request);
      const existing = this.cache.get(actionId);
      if (existing) {
        if (existing.fingerprint !== requestFingerprint) {
          return Promise.reject(new WorkflowActionIdConflictError());
        }
        return existing.result.then(cloneResult);
      }
      const result = this.runUncached(normalized, {
        ...(actionId !== undefined ? { actionId } : {}),
        ...(expectedPageRevision !== undefined ? { expectedPageRevision } : {}),
        ...(expectedTabId !== undefined ? { expectedTabId } : {}),
        maxDurationMs,
        maxResultBytes,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      this.cache.set(actionId, { fingerprint: requestFingerprint, expiresAt: now + WORKFLOW_CACHE_TTL_MS, result });
      while (this.cache.size > MAX_WORKFLOW_CACHE_ENTRIES) {
        const oldest = this.cache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
      return result.then(cloneResult);
    }
    return this.runUncached(normalized, {
      ...(expectedPageRevision !== undefined ? { expectedPageRevision } : {}),
      ...(expectedTabId !== undefined ? { expectedTabId } : {}),
      maxDurationMs,
      maxResultBytes,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  }

  public execute(workflow: WorkflowDefinition, options: WorkflowExecutionOptions = {}): Promise<WorkflowResult> {
    return this.run(workflow, options);
  }

  public clearCache(): void {
    this.cache.clear();
  }

  private async runUncached(workflow: NormalizedWorkflow, options: Required<Pick<WorkflowExecutionOptions, 'maxDurationMs' | 'maxResultBytes'>> & WorkflowExecutionOptions): Promise<WorkflowResult> {
    const startedAt = this.now();
    const deadline = startedAt + options.maxDurationMs;
    const reports: WorkflowStepResult[] = [];
    const firstWriteIndex = workflow.steps.findIndex(isWriteStep);
    const initialStatus = await this.readStatus(deadline, options.signal);
    if (options.expectedTabId !== undefined && initialStatus?.tabId !== undefined && initialStatus.tabId !== options.expectedTabId) {
      return boundResult({
        ok: false,
        status: 'stopped',
        stopReason: 'revision_mismatch',
        steps: [],
        completedSteps: 0,
        elapsedMs: Math.max(0, this.now() - startedAt),
        resultBytes: 0,
        truncated: false,
      }, options.maxResultBytes);
    }
    if (options.expectedPageRevision !== undefined && initialStatus?.pageRevision !== undefined && initialStatus.pageRevision !== options.expectedPageRevision) {
      return boundResult({
        ok: false,
        status: 'stopped',
        stopReason: 'revision_mismatch',
        steps: [],
        completedSteps: 0,
        elapsedMs: Math.max(0, this.now() - startedAt),
        resultBytes: 0,
        truncated: false,
      }, options.maxResultBytes);
    }
    if (initialStatus?.challengeDetected) {
      return boundResult({
        ok: false,
        status: 'stopped',
        stopReason: 'challenge',
        steps: [],
        completedSteps: 0,
        elapsedMs: Math.max(0, this.now() - startedAt),
        resultBytes: 0,
        truncated: false,
      }, options.maxResultBytes);
    }

    let previousStatus = initialStatus;
    let stopReason: WorkflowStopReason = 'completed';
    for (let index = 0; index < workflow.steps.length; index += 1) {
      const step = workflow.steps[index];
      if (step === undefined) break;
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        stopReason = 'timeout';
        break;
      }
      const stepStartedAt = this.now();
      const guards = index === firstWriteIndex
        ? {
          ...(options.actionId !== undefined ? { actionId: options.actionId } : {}),
          ...(options.expectedPageRevision !== undefined ? { expectedPageRevision: options.expectedPageRevision } : {}),
          ...(options.expectedTabId !== undefined ? { expectedTabId: options.expectedTabId } : {}),
        }
        : {};
      try {
        const raw = await this.withDeadline((signal) => this.invoke(step, guards, signal), deadline, options.signal);
        const afterStatus = await this.readStatus(deadline, options.signal);
        const revision = afterStatus?.pageRevision ?? resultRevision(raw);
        const summary = safeStepSummary(step, raw, revision);
        const report: WorkflowStepResult = {
          index,
          op: step.op,
          status: 'success',
          ok: true,
          elapsedMs: Math.max(0, this.now() - stepStartedAt),
          ...(revision !== undefined ? { pageRevision: revision } : {}),
          summary,
        };
        reports.push(report);

        const runtimeStop = statusStopReason(previousStatus, afterStatus, workflow.stopOn) ?? rawStopReason(raw, workflow.stopOn);
        if (runtimeStop) {
          stopReason = runtimeStop;
          break;
        }
        if (workflow.stopOn.has('navigation') && navigationDetected(previousStatus, afterStatus, raw)) {
          stopReason = 'navigation';
          break;
        }
        previousStatus = afterStatus ?? previousStatus;
      } catch (error) {
        const failure = classifyFailure(error);
        reports.push({
          index,
          op: step.op,
          status: failure.reason === 'interrupt' ? 'interrupted' : 'error',
          ok: false,
          elapsedMs: Math.max(0, this.now() - stepStartedAt),
          ...(failure.details?.actualPageRevision !== undefined ? { pageRevision: failure.details.actualPageRevision } : {}),
          error: errorSummary(failure),
        });
        stopReason = failure.reason;
        break;
      }
    }

    const result: WorkflowResult = {
      ok: stopReason === 'completed' && reports.length === workflow.steps.length,
      status: stopReason === 'completed' && reports.length === workflow.steps.length ? 'completed' : 'stopped',
      stopReason,
      steps: reports,
      completedSteps: reports.filter((report) => report.status === 'success').length,
      elapsedMs: Math.max(0, this.now() - startedAt),
      resultBytes: 0,
      truncated: false,
    };
    return boundResult(result, options.maxResultBytes);
  }

  private async readStatus(deadline: number, signal?: AbortSignal): Promise<NormalizedStatus | undefined> {
    const status = this.adapter.status;
    if (!status) return undefined;
    try {
      const result = await this.withDeadline(async () => await status.call(this.adapter), deadline, signal);
      return normalizeStatus(result);
    } catch {
      // Status is diagnostic. The high-level action's own gate remains the
      // source of truth if a status projection is temporarily unavailable.
      return undefined;
    }
  }

  private async invoke(
    step: WorkflowStep,
    guards: { actionId?: string; expectedPageRevision?: number; expectedTabId?: string },
    signal: AbortSignal,
  ): Promise<unknown> {
    switch (step.op) {
      case 'open':
        return this.adapter.open(step.url, {
          ...(step.waitUntil !== undefined ? { waitUntil: step.waitUntil } : {}),
          ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
          ...guards,
          signal,
        });
      case 'click':
        return this.adapter.click(adapterTarget(step.target), {
          ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
          ...guards,
          signal,
        });
      case 'type':
        return this.adapter.type(adapterTarget(step.target), step.text, {
          ...(step.clearFirst !== undefined ? { clearFirst: step.clearFirst } : step.clear !== undefined ? { clearFirst: step.clear } : {}),
          ...(step.submit !== undefined ? { submit: step.submit } : {}),
          ...(step.sensitive !== undefined ? { sensitive: step.sensitive } : {}),
          ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
          ...guards,
          signal,
        });
      case 'select': {
        const target = adapterTarget(step.target);
        if (step.values !== undefined) {
          let result: unknown;
          for (const [index, value] of step.values.entries()) {
            result = await this.adapter.select(target, { value }, {
              ...(index === 0 ? guards : {}),
              ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
              signal,
            });
          }
          return result;
        }
        return this.adapter.select(target, step.choice ?? (step.value !== undefined ? { value: step.value } : { label: step.label! }), {
          ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
          ...guards,
          signal,
        });
      }
      case 'scroll':
        return this.adapter.scroll(step.direction, step.amount ?? 1, step.target === undefined ? undefined : adapterTarget(step.target), {
          ...guards,
          signal,
        });
      case 'wait':
        return this.adapter.wait({
          ...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
          ...(step.condition !== undefined ? { condition: step.condition } : {}),
          ...(step.target !== undefined ? { target: adapterTarget(step.target) } : {}),
          ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
          signal,
        });
      case 'snapshot':
        return this.adapter.snapshot({
          ...(step.maxNodes !== undefined ? { maxNodes: step.maxNodes } : {}),
          ...(step.maxChars !== undefined ? { maxChars: step.maxChars } : {}),
          ...(step.maxBytes !== undefined ? { maxBytes: step.maxBytes } : {}),
          ...(step.includeText !== undefined ? { includeText: step.includeText } : {}),
          ...(step.compact !== undefined ? { format: step.compact ? 'compact' : 'structured' } : {}),
          ...(step.format !== undefined ? { format: step.format } : {}),
          signal,
        });
    }
  }

  private async withDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, deadline: number, parentSignal?: AbortSignal): Promise<T> {
    const remaining = deadline - this.now();
    if (remaining <= 0) throw new WorkflowTimeoutError();
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    if (parentSignal?.aborted) throw new WorkflowTimeoutError();
    parentSignal?.addEventListener('abort', onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new WorkflowTimeoutError());
        }, remaining);
      });
      return await Promise.race([operation(controller.signal), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onAbort);
    }
  }

  private pruneCache(now: number): void {
    for (const [actionId, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(actionId);
    }
  }
}

const EXECUTOR_BY_ADAPTER = new WeakMap<object, WorkflowExecutor>();

/**
 * Convenience API. The executor is retained per adapter so an outer
 * actionId remains idempotent even when callers use this function directly;
 * adapters should therefore be scoped to one browser session.
 */
export function executeWorkflow(
  adapter: WorkflowAdapter,
  workflow: WorkflowDefinition,
  options: WorkflowExecutionOptions = {},
): Promise<WorkflowResult> {
  let executor = EXECUTOR_BY_ADAPTER.get(adapter);
  if (!executor) {
    executor = new WorkflowExecutor(adapter);
    EXECUTOR_BY_ADAPTER.set(adapter, executor);
  }
  return executor.run(workflow, options);
}

function utf8(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function shortenContent(result: WorkflowResult, targetBytes: number): boolean {
  for (const step of result.steps) {
    const summary = step.summary;
    if (!summary || summary.kind !== 'snapshot' || typeof summary.content !== 'string' || summary.content.length === 0) continue;
    const currentBytes = Buffer.byteLength(summary.content, 'utf8');
    if (currentBytes <= targetBytes) continue;
    const bounded = Buffer.from(summary.content, 'utf8').subarray(0, Math.max(0, targetBytes)).toString('utf8').replace(/\uFFFD+$/u, '');
    summary.content = bounded;
    summary.contentBytes = Buffer.byteLength(bounded, 'utf8');
    summary.truncated = true;
    return true;
  }
  return false;
}

function removeOptionalFields(result: WorkflowResult): boolean {
  for (const step of result.steps) {
    const summary = step.summary;
    if (summary?.kind === 'snapshot') {
      if (summary.content !== undefined) {
        delete summary.content;
        delete summary.contentBytes;
        summary.truncated = true;
        return true;
      }
      if (summary.snapshotId !== undefined) {
        delete summary.snapshotId;
        return true;
      }
    }
    if (summary?.kind === 'open') {
      if (summary.title !== undefined) {
        delete summary.title;
        return true;
      }
      if (summary.url !== undefined) {
        delete summary.url;
        return true;
      }
    }
    if (step.error?.message !== undefined) {
      delete step.error.message;
      return true;
    }
  }
  return false;
}

function boundResult(input: WorkflowResult, maxBytes: number): WorkflowResult {
  let result = input;
  let bytes = measuredResultBytes(result);
  while (bytes > maxBytes) {
    const changed = shortenContent(result, Math.max(0, Math.floor(maxBytes / 4))) || removeOptionalFields(result);
    if (changed) {
      result.truncated = true;
      bytes = measuredResultBytes(result);
      continue;
    }
    if (result.steps.length > 1) {
      result.steps.pop();
      result.completedSteps = result.steps.filter((step) => step.status === 'success').length;
      result.truncated = true;
      bytes = measuredResultBytes(result);
      continue;
    }
    break;
  }
  if (bytes > maxBytes) {
    // The configured minimum leaves enough room for this compact shape. Keep
    // this defensive fallback for embedders that bypass validation.
    const fallback = {
      ok: result.ok,
      status: result.status,
      stopReason: result.stopReason,
      steps: [],
      resultBytes: 0,
    } as unknown as WorkflowResult;
    measuredResultBytes(fallback);
    return fallback;
  }
  result.resultBytes = bytes;
  // The measurement helper reaches a fixed point for the decimal byte count;
  // this final assignment keeps the public field equal to the actual JSON
  // representation rather than the representation with resultBytes=0.
  measuredResultBytes(result);
  return result;
}

function measuredResultBytes(result: WorkflowResult): number {
  let count = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    result.resultBytes = count;
    const measured = utf8(result);
    if (measured === count) return measured;
    count = measured;
  }
  result.resultBytes = count;
  return utf8(result);
}

export default WorkflowExecutor;
