import { createHash, randomUUID } from 'node:crypto';

import type { SemanticNode, SemanticSnapshot } from './semantic-snapshot.js';

/**
 * Errors raised by the short-lived snapshot history.
 *
 * `SNAPSHOT_NOT_FOUND` intentionally has one stable meaning for callers: the
 * requested base snapshot is not available anymore.  A separate
 * `SNAPSHOT_EXPIRED` code is used only when this history can prove that the
 * identifier was previously retained and then expired.  Callers that do not
 * need that distinction can handle both codes identically.
 */
export type SnapshotHistoryErrorCode =
  | 'SNAPSHOT_NOT_FOUND'
  | 'SNAPSHOT_EXPIRED'
  | 'SNAPSHOT_ID_CONFLICT'
  | 'PAGE_REVISION_MISMATCH'
  | 'INVALID_SNAPSHOT'
  | 'RESOURCE_EXHAUSTED';

export class SnapshotHistoryError extends Error {
  public readonly code: SnapshotHistoryErrorCode;
  public readonly retryable: boolean;
  public readonly details: Record<string, unknown> | undefined;

  public constructor(
    code: SnapshotHistoryErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'SnapshotHistoryError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

/** A caller-controlled id generator is useful for deterministic tests. */
export type SnapshotIdFactory = (sequence: number, pageRevision: number) => string;

export interface SnapshotHistoryOptions {
  /** Optional server-owned session label included in generated opaque ids. */
  sessionId?: string;
  /** Maximum number of snapshots retained for this history. */
  maxSnapshots?: number;
  /** Absolute retention time for each snapshot, in milliseconds. */
  ttlMs?: number;
  /** Aggregate UTF-8 size of retained history entries. */
  maxBytes?: number;
  /** Maximum UTF-8 size of one retained entry. Defaults to 256 KiB. */
  maxSnapshotBytes?: number;
  /** Maximum semantic nodes retained from one input snapshot. */
  maxNodes?: number;
  /** Injectable wall clock for deterministic tests. */
  now?: () => number;
  /** Optional deterministic id generator. Generated ids remain validated. */
  idFactory?: SnapshotIdFactory;
}

export interface SnapshotRecordOptions {
  /** Override the input's id. Existing valid ids are preserved by default. */
  snapshotId?: string;
  /** Override the input's page revision. */
  pageRevision?: number;
  /** Reject before retaining when the input revision differs. */
  expectedPageRevision?: number;
}

export interface SnapshotDiffOptions {
  /** Reject when the current snapshot's revision differs from this value. */
  expectedPageRevision?: number;
  /** Optional strict mode for callers that require one revision. */
  requireSamePageRevision?: boolean;
}

export interface SnapshotHistoryEntry {
  snapshotId: string;
  tabId?: string;
  pageRevision: number;
  createdAt: number;
  expiresAt: number;
  /** UTF-8 size of the bounded internal representation. */
  bytes: number;
  /** Safe target projection only; page body/content is deliberately absent. */
  targets: SemanticNode[];
}

export interface SnapshotNodeUpdate {
  /** Stable semantic node identity used for matching. */
  key: string;
  before: SemanticNode;
  after: SemanticNode;
  /** Fields that changed, excluding opaque ref and generation bookkeeping. */
  changed: Array<SnapshotNodeField>;
}

export type SnapshotNodeField =
  | 'role'
  | 'name'
  | 'tag'
  | 'type'
  | 'testId'
  | 'frameId'
  | 'visible'
  | 'enabled'
  | 'editable'
  | 'checked'
  | 'required'
  | 'value'
  | 'text';

export interface SnapshotDiff {
  /** Identifier of the base observation supplied through `sinceSnapshotId`. */
  sinceSnapshotId: string;
  /** Identifier of the current observation, if it already had one. */
  snapshotId: string;
  tabId?: string;
  fromPageRevision: number;
  pageRevision: number;
  pageRevisionChanged: boolean;
  added: SemanticNode[];
  removed: SemanticNode[];
  updated: SnapshotNodeUpdate[];
  changed: boolean;
}

export interface SnapshotRecordResult {
  snapshot: SemanticSnapshot;
  diff?: SnapshotDiff;
}

interface StoredNode {
  node: SemanticNode;
  /** Hashes let us compare omitted text without retaining the text itself. */
  textDigest?: string;
}

interface StoredEntry {
  snapshotId: string;
  tabId?: string;
  pageRevision: number;
  generation: number;
  createdAt: number;
  expiresAt: number;
  bytes: number;
  nodes: StoredNode[];
}

const DEFAULT_MAX_SNAPSHOTS = 32;
const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_SNAPSHOT_BYTES = 256 * 1024;
const DEFAULT_MAX_NODES = 500;

const HARD_MAX_SNAPSHOTS = 512;
const HARD_MAX_TTL_MS = 24 * 60 * 60_000;
const HARD_MAX_BYTES = 16 * 1024 * 1024;
const HARD_MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const HARD_MAX_NODES = 2_000;

const MAX_ID_LENGTH = 200;
const MAX_NODE_STRING_LENGTH = 256;
const MAX_NAME_LENGTH = 200;
const MAX_REF_LENGTH = 200;

const NODE_FIELDS: readonly SnapshotNodeField[] = [
  'role',
  'name',
  'tag',
  'type',
  'testId',
  'frameId',
  'visible',
  'enabled',
  'editable',
  'checked',
  'required',
  'value',
  'text',
];

const STRING_NODE_FIELDS: readonly SnapshotNodeField[] = [
  'role',
  'name',
  'tag',
  'type',
  'testId',
  'frameId',
  'text',
];

/**
 * Per-session bounded history for semantic snapshots.
 *
 * The history is intentionally an in-memory, per-instance component.  It does
 * not write to disk, Redis, audit logs, or any other shared store.  Retained
 * entries contain only bounded semantic target metadata and a digest for
 * omitted text; page URL, title, body text, compact content, and raw control
 * values are never retained.
 */
export class SnapshotHistory {
  private readonly sessionId: string | undefined;
  private readonly maxSnapshots: number;
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  private readonly maxSnapshotBytes: number;
  private readonly maxNodes: number;
  private readonly now: () => number;
  private readonly idFactory: SnapshotIdFactory | undefined;
  private readonly entries = new Map<string, StoredEntry>();
  private readonly expiredIds = new Map<string, number>();
  private totalBytes = 0;
  private sequence = 0;

  public constructor(options: SnapshotHistoryOptions = {}) {
    this.sessionId = options.sessionId;
    this.maxSnapshots = boundedInteger(options.maxSnapshots, 1, HARD_MAX_SNAPSHOTS, DEFAULT_MAX_SNAPSHOTS);
    this.ttlMs = boundedInteger(options.ttlMs, 1, HARD_MAX_TTL_MS, DEFAULT_TTL_MS);
    this.maxBytes = boundedInteger(options.maxBytes, 1, HARD_MAX_BYTES, DEFAULT_MAX_BYTES);
    this.maxSnapshotBytes = boundedInteger(
      options.maxSnapshotBytes,
      1,
      Math.min(HARD_MAX_SNAPSHOT_BYTES, this.maxBytes),
      Math.min(DEFAULT_MAX_SNAPSHOT_BYTES, this.maxBytes),
    );
    this.maxNodes = boundedInteger(options.maxNodes, 1, HARD_MAX_NODES, DEFAULT_MAX_NODES);
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory;
  }

  public get size(): number {
    this.prune();
    return this.entries.size;
  }

  public get bytes(): number {
    this.prune();
    return this.totalBytes;
  }

  public get capacity(): number {
    return this.maxSnapshots;
  }

  public get byteCapacity(): number {
    return this.maxBytes;
  }

  public has(snapshotId: string): boolean {
    this.prune();
    return this.entries.has(snapshotId);
  }

  /** Remove all retained observations and expiry tombstones. */
  public clear(): void {
    this.entries.clear();
    this.expiredIds.clear();
    this.totalBytes = 0;
  }

  /** Eagerly remove expired observations and return the number removed. */
  public prune(): number {
    const now = this.readNow();
    let removed = 0;
    for (const [snapshotId, entry] of this.entries) {
      if (entry.expiresAt > now) continue;
      this.entries.delete(snapshotId);
      this.totalBytes -= entry.bytes;
      this.expiredIds.set(snapshotId, now);
      removed += 1;
    }
    // Tombstones are bounded too. They only exist to give an expired id a
    // stable error once; retaining them forever would defeat history bounds.
    for (const [snapshotId, expiredAt] of this.expiredIds) {
      if (expiredAt + this.ttlMs > now) continue;
      this.expiredIds.delete(snapshotId);
    }
    while (this.expiredIds.size > Math.min(HARD_MAX_SNAPSHOTS, this.maxSnapshots * 2)) {
      const oldest = this.expiredIds.keys().next().value as string | undefined;
      if (!oldest) break;
      this.expiredIds.delete(oldest);
    }
    // Floating point cannot be involved in the accounting, but keep the
    // invariant explicit in case a future entry format changes.
    if (this.totalBytes < 0) this.totalBytes = 0;
    return removed;
  }

  /**
   * Retain a bounded observation and return it with a generated/preserved id
   * and normalized `pageRevision`. The input object is never mutated.
   */
  public record(snapshot: SemanticSnapshot, options: SnapshotRecordOptions = {}): SemanticSnapshot {
    return this.retainPrepared(this.prepareSnapshot(snapshot, options));
  }

  private retainPrepared(prepared: { snapshot: SemanticSnapshot; pageRevision: number; storedNodes: StoredNode[]; entryBytes: number }): SemanticSnapshot {
    const now = this.readNow();
    this.prune();
    const existing = this.entries.get(prepared.snapshot.snapshotId!);
    if (existing) {
      if (
        existing.tabId !== prepared.snapshot.tabId
        || existing.pageRevision !== prepared.pageRevision
        || !sameStoredNodes(existing.nodes, prepared.storedNodes)
      ) {
        throw new SnapshotHistoryError(
          'SNAPSHOT_ID_CONFLICT',
          'The snapshot id is already associated with a different observation',
          { details: { snapshotId: prepared.snapshot.snapshotId } },
        );
      }
      // Re-recording an identical observation is safe and idempotent. Refresh
      // neither its age nor its position; TTL remains tied to original capture.
      return clonePublicSnapshot(prepared.snapshot);
    }

    const entry: StoredEntry = {
      snapshotId: prepared.snapshot.snapshotId!,
      ...(prepared.snapshot.tabId !== undefined ? { tabId: prepared.snapshot.tabId } : {}),
      pageRevision: prepared.pageRevision,
      generation: prepared.snapshot.generation,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      bytes: prepared.entryBytes,
      nodes: prepared.storedNodes,
    };

    if (entry.bytes > this.maxSnapshotBytes || entry.bytes > this.maxBytes) {
      throw new SnapshotHistoryError(
        'RESOURCE_EXHAUSTED',
        'The snapshot exceeds the configured history object-size limit',
        {
          retryable: false,
          details: {
            snapshotBytes: entry.bytes,
            maxSnapshotBytes: this.maxSnapshotBytes,
            maxBytes: this.maxBytes,
          },
        },
      );
    }

    while (this.entries.size >= this.maxSnapshots || this.totalBytes + entry.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.evict(oldest);
    }
    this.entries.set(entry.snapshotId, entry);
    this.totalBytes += entry.bytes;
    this.expiredIds.delete(entry.snapshotId);
    return clonePublicSnapshot(prepared.snapshot);
  }

  /** Synonym suitable for callers that use storage terminology. */
  public save = this.record.bind(this);

  /** Synonym suitable for callers that use observation terminology. */
  public remember = this.record.bind(this);

  /**
   * Read a safe retained entry. A fresh object is returned so callers cannot
   * mutate history state or retain references to internal arrays.
   */
  public get(snapshotId: string): SnapshotHistoryEntry | undefined {
    this.prune();
    const entry = this.entries.get(snapshotId);
    if (!entry) return undefined;
    return cloneEntry(entry);
  }

  /** Read a required base entry using stable, typed error semantics. */
  public require(snapshotId: string): SnapshotHistoryEntry {
    const entry = this.get(snapshotId);
    if (entry) return entry;
    if (this.expiredIds.has(snapshotId)) {
      throw new SnapshotHistoryError('SNAPSHOT_EXPIRED', 'The base snapshot has expired', {
        retryable: true,
        details: { snapshotId },
      });
    }
    throw new SnapshotHistoryError('SNAPSHOT_NOT_FOUND', 'The base snapshot was not found', {
      retryable: true,
      details: { snapshotId },
    });
  }

  /**
   * Diff an unretained/current observation against a retained base. Different
   * page revisions are valid and are reported in the result; strict callers
   * can opt into rejection with `requireSamePageRevision` or
   * `expectedPageRevision`.
   */
  public diff(
    currentSnapshot: SemanticSnapshot,
    sinceSnapshotId: string,
    options: SnapshotDiffOptions = {},
  ): SnapshotDiff {
    const current = this.prepareSnapshot(currentSnapshot, {}).snapshot;
    const base = this.requireEntry(sinceSnapshotId);
    this.assertRevision(current.pageRevision!, options.expectedPageRevision, 'expectedPageRevision');
    if (options.requireSamePageRevision === true && current.pageRevision !== base.pageRevision) {
      throw new SnapshotHistoryError(
        'PAGE_REVISION_MISMATCH',
        'The current snapshot belongs to a different page revision',
        {
          retryable: true,
          details: {
            expectedPageRevision: base.pageRevision,
            actualPageRevision: current.pageRevision,
            sinceSnapshotId,
          },
        },
      );
    }
    return makeDiff(current, base, sinceSnapshotId);
  }

  /** Explicitly named alias for integrations that prefer `getDiff`. */
  public getDiff = this.diff.bind(this);

  /** Explicit strict alias for revision-sensitive callers. */
  public diffSameRevision(currentSnapshot: SemanticSnapshot, sinceSnapshotId: string): SnapshotDiff {
    return this.diff(currentSnapshot, sinceSnapshotId, { requireSamePageRevision: true });
  }

  /**
   * Retain the current observation and, when requested, return its diff in one
   * operation. The base is resolved before insertion so an unknown base does
   * not leave a surprising new entry behind.
   */
  public recordWithDiff(
    snapshot: SemanticSnapshot,
    options: SnapshotRecordOptions & { sinceSnapshotId?: string; diff?: SnapshotDiffOptions } = {},
  ): SnapshotRecordResult {
    const baseId = options.sinceSnapshotId;
    const base = baseId === undefined ? undefined : this.requireEntry(baseId);
    const prepared = this.prepareSnapshot(snapshot, options);
    if (base) {
      const diffOptions = options.diff;
      this.assertRevision(prepared.pageRevision, diffOptions?.expectedPageRevision, 'expectedPageRevision');
      if (diffOptions?.requireSamePageRevision === true && prepared.pageRevision !== base.pageRevision) {
        throw new SnapshotHistoryError(
          'PAGE_REVISION_MISMATCH',
          'The current snapshot belongs to a different page revision',
          {
            retryable: true,
            details: {
              expectedPageRevision: base.pageRevision,
              actualPageRevision: prepared.pageRevision,
              sinceSnapshotId: baseId,
            },
          },
        );
      }
    }
    const saved = this.retainPrepared(prepared);
    return {
      snapshot: saved,
      ...(baseId !== undefined
        ? { diff: this.diff(saved, baseId, options.diff) }
        : {}),
    };
  }

  /** Alias for integrations that model this as an observation operation. */
  public observe = this.recordWithDiff.bind(this);

  private requireEntry(snapshotId: string): StoredEntry {
    this.prune();
    const entry = this.entries.get(snapshotId);
    if (entry) return entry;
    if (this.expiredIds.has(snapshotId)) {
      throw new SnapshotHistoryError('SNAPSHOT_EXPIRED', 'The base snapshot has expired', {
        retryable: true,
        details: { snapshotId },
      });
    }
    throw new SnapshotHistoryError('SNAPSHOT_NOT_FOUND', 'The base snapshot was not found', {
      retryable: true,
      details: { snapshotId },
    });
  }

  private prepareSnapshot(
    input: SemanticSnapshot,
    options: SnapshotRecordOptions,
  ): { snapshot: SemanticSnapshot; pageRevision: number; storedNodes: StoredNode[]; entryBytes: number } {
    assertSnapshotShape(input);
    const pageRevision = options.pageRevision
      ?? input.pageRevision
      ?? input.pageGeneration
      ?? input.generation;
    assertRevisionValue(pageRevision, 'pageRevision');
    this.assertRevision(pageRevision, options.expectedPageRevision, 'expectedPageRevision');

    const suppliedId = options.snapshotId ?? input.snapshotId;
    const snapshotId = suppliedId === undefined
      ? this.nextSnapshotId(pageRevision)
      : validateSnapshotId(suppliedId);
    const rawTargets = Array.isArray(input.targets)
      ? input.targets
      : Array.isArray(input.elements)
        ? input.elements
        : [];
    const limitedTargets = rawTargets.slice(0, this.maxNodes);
    const normalizedNodes = limitedTargets.map((node, index) => normalizeStoredNode(node, input.generation, index));
    // The response may retain the already-visible, bounded target text for
    // compatibility. The history entry itself drops that field below and
    // keeps only a digest, so body/target text is never retained in history.
    const publicTargets = normalizedNodes.map(({ node }) => cloneNode(node));
    const storedNodes = normalizedNodes.map(({ node, textDigest }) => ({
      node: withoutNodeText(node),
      ...(textDigest ? { textDigest } : {}),
    }));
    const snapshot = normalizePublicSnapshot(input, snapshotId, pageRevision, publicTargets, rawTargets.length > limitedTargets.length, this.maxSnapshotBytes);
    const entryBytes = byteLength(JSON.stringify({
      snapshotId,
      ...(snapshot.tabId !== undefined ? { tabId: snapshot.tabId } : {}),
      pageRevision,
      generation: snapshot.generation,
      targets: storedNodes.map((stored) => ({
        node: stored.node,
        ...(stored.textDigest ? { textDigest: stored.textDigest } : {}),
      })),
    }));
    return { snapshot, pageRevision, storedNodes, entryBytes };
  }

  private assertRevision(actual: number, expected: number | undefined, field: string): void {
    if (expected === undefined) return;
    assertRevisionValue(expected, field);
    if (actual !== expected) {
      throw new SnapshotHistoryError(
        'PAGE_REVISION_MISMATCH',
        'The page revision does not match the expected revision',
        {
          retryable: true,
          details: { expectedPageRevision: expected, actualPageRevision: actual },
        },
      );
    }
  }

  private nextSnapshotId(pageRevision: number): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const sequence = ++this.sequence;
      const generated = this.idFactory
        ? this.idFactory(sequence, pageRevision)
        : defaultSnapshotId(this.sessionId, sequence, pageRevision);
      const id = validateSnapshotId(generated);
      if (!this.entries.has(id)) return id;
    }
    throw new SnapshotHistoryError('RESOURCE_EXHAUSTED', 'Could not allocate a unique snapshot id');
  }

  private evict(snapshotId: string): void {
    const entry = this.entries.get(snapshotId);
    if (!entry) return;
    this.entries.delete(snapshotId);
    this.totalBytes -= entry.bytes;
    if (this.totalBytes < 0) this.totalBytes = 0;
  }

  private readNow(): number {
    const value = this.now();
    if (!Number.isFinite(value)) throw new SnapshotHistoryError('INVALID_SNAPSHOT', 'The history clock returned an invalid time');
    return value;
  }
}

/** Factory alias for dependency-injection sites. */
export const createSnapshotHistory = (options: SnapshotHistoryOptions = {}): SnapshotHistory => new SnapshotHistory(options);

function assertSnapshotShape(input: SemanticSnapshot): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new SnapshotHistoryError('INVALID_SNAPSHOT', 'A semantic snapshot object is required');
  }
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
    throw new SnapshotHistoryError('INVALID_SNAPSHOT', 'Snapshot generation must be a non-negative integer');
  }
  if (input.pageGeneration !== undefined) assertRevisionValue(input.pageGeneration, 'pageGeneration');
  if (input.pageRevision !== undefined) assertRevisionValue(input.pageRevision, 'pageRevision');
  if (input.frameGeneration !== undefined) assertRevisionValue(input.frameGeneration, 'frameGeneration');
  if (!Array.isArray(input.targets) && !Array.isArray(input.elements)) {
    throw new SnapshotHistoryError('INVALID_SNAPSHOT', 'Snapshot targets must be an array');
  }
}

function assertRevisionValue(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SnapshotHistoryError('INVALID_SNAPSHOT', `${field} must be a non-negative integer`);
  }
}

function validateSnapshotId(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_LENGTH || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new SnapshotHistoryError('INVALID_SNAPSHOT', 'snapshotId must be a bounded opaque string');
  }
  return value;
}
function validateTabId(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 100 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new SnapshotHistoryError('INVALID_SNAPSHOT', 'tabId must be a bounded opaque string');
  }
  return value;
}

function defaultSnapshotId(sessionId: string | undefined, sequence: number, pageRevision: number): string {
  const sessionPart = sessionId && /^[A-Za-z0-9_-]{1,100}$/u.test(sessionId) ? sessionId : 'session';
  let suffix: string;
  try {
    suffix = randomUUID().replace(/-/gu, '').slice(0, 16);
  } catch {
    suffix = `${Date.now().toString(36)}${sequence.toString(36)}`;
  }
  return `snp_${sessionPart}_${pageRevision.toString(36)}_${sequence.toString(36)}_${suffix}`;
}
function normalizePublicSnapshot(
  input: SemanticSnapshot,
  snapshotId: string,
  pageRevision: number,
  targets: SemanticNode[],
  targetsTruncated: boolean,
  maxSnapshotBytes: number,
): SemanticSnapshot {
  const result: SemanticSnapshot = {
    generation: input.generation,
    ...(input.tabId !== undefined ? { tabId: validateTabId(input.tabId) } : {}),
    ...(input.pageGeneration !== undefined ? { pageGeneration: input.pageGeneration } : {}),
    pageRevision,
    ...(input.frameGeneration !== undefined ? { frameGeneration: input.frameGeneration } : {}),
    snapshotId,
    targets,
    elements: targets,
  };
  if (typeof input.url === 'string') result.url = boundedText(input.url, 2_048);
  if (typeof input.title === 'string') result.title = boundedText(input.title, 500);
  if (typeof input.text === 'string') {
    const bounded = truncateUtf8(input.text, 100_000);
    result.text = bounded.value;
    if (input.textTruncated === true || bounded.truncated) result.textTruncated = true;
  } else if (input.textTruncated === true) {
    result.textTruncated = true;
  }
  if (typeof input.content === 'string') {
    const bounded = truncateUtf8(input.content, maxSnapshotBytes);
    result.content = bounded.value;
    result.contentBytes = bounded.bytes;
  }
  if (input.format === 'structured' || input.format === 'compact') result.format = input.format;
  if (input.truncated && typeof input.truncated === 'object') {
    result.truncated = {
      content: input.truncated.content === true,
      targets: input.truncated.targets === true || targetsTruncated,
      ...(input.truncated.reason === 'max_bytes' || input.truncated.reason === 'max_nodes'
        ? { reason: input.truncated.reason }
        : targetsTruncated ? { reason: 'max_nodes' as const } : {}),
    };
  } else if (targetsTruncated) {
    result.truncated = { content: false, targets: true, reason: 'max_nodes' };
  }
  return result;
}

function normalizeStoredNode(input: SemanticNode, generation: number, index: number): StoredNode {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new SnapshotHistoryError('INVALID_SNAPSHOT', `Snapshot target ${index} is invalid`);
  }
  if (typeof input.ref !== 'string' || input.ref.length === 0 || input.ref.length > MAX_REF_LENGTH) {
    throw new SnapshotHistoryError('INVALID_SNAPSHOT', `Snapshot target ${index} has an invalid ref`);
  }
  const safeGeneration = input.generation === undefined ? generation : input.generation;
  assertRevisionValue(safeGeneration, `target[${index}].generation`);
  const node: SemanticNode = {
    ref: boundedText(input.ref, MAX_REF_LENGTH),
    generation: safeGeneration,
    role: boundedText(typeof input.role === 'string' ? input.role : 'generic', MAX_NAME_LENGTH),
    name: boundedText(typeof input.name === 'string' ? input.name : '', MAX_NAME_LENGTH),
    tag: boundedText(typeof input.tag === 'string' ? input.tag : 'unknown', MAX_NAME_LENGTH),
  };
  for (const field of STRING_NODE_FIELDS) {
    const value = input[field];
    if (typeof value === 'string' && value.length > 0) {
      (node as unknown as Record<string, unknown>)[field] = boundedText(
        value,
        field === 'name' ? MAX_NAME_LENGTH : MAX_NODE_STRING_LENGTH,
      );
    }
  }
  for (const field of ['visible', 'enabled', 'editable', 'checked', 'required'] as const) {
    const value = input[field];
    if (typeof value === 'boolean') (node as unknown as Record<string, unknown>)[field] = value;
  }
  // Never retain a caller-provided value. The marker is useful to indicate
  // that a control has a value while remaining independent of the value.
  const sensitiveType = typeof input.type === 'string' && /^(password|hidden|secret)$/iu.test(input.type);
  if ('value' in input || sensitiveType) node.value = '<redacted>';
  const textDigest = typeof input.text === 'string' && input.text.length > 0 ? sha256(input.text) : undefined;
  return { node, ...(textDigest ? { textDigest } : {}) };
}

function clonePublicSnapshot(snapshot: SemanticSnapshot): SemanticSnapshot {
  const targets = snapshot.targets.map((target) => cloneNode(target));
  const clone: SemanticSnapshot = {
    ...snapshot,
    targets,
    elements: targets,
  };
  if (snapshot.truncated) clone.truncated = { ...snapshot.truncated };
  return clone;
}

function cloneEntry(entry: StoredEntry): SnapshotHistoryEntry {
  const targets = entry.nodes.map(({ node }) => cloneNode(node));
  return {
    snapshotId: entry.snapshotId,
    ...(entry.tabId !== undefined ? { tabId: entry.tabId } : {}),
    pageRevision: entry.pageRevision,
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
    bytes: entry.bytes,
    targets,
  };
}

function cloneNode(node: SemanticNode): SemanticNode {
  return { ...node };
}

function withoutNodeText(node: SemanticNode): SemanticNode {
  const clone = cloneNode(node);
  delete clone.text;
  return clone;
}

function makeDiff(current: SemanticSnapshot, base: StoredEntry, sinceSnapshotId: string): SnapshotDiff {
  const currentNodes = current.targets.map((node, index) => normalizeStoredNode(node, current.generation, index));
  const oldByRef = new Map<string, Array<{ stored: StoredNode; index: number }>>();
  const oldBySemantic = new Map<string, Array<{ stored: StoredNode; index: number }>>();
  base.nodes.forEach((stored, index) => {
    addMapValue(oldByRef, stored.node.ref, { stored, index });
    addMapValue(oldBySemantic, semanticKey(stored.node), { stored, index });
  });
  const used = new Set<number>();
  const added: SemanticNode[] = [];
  const updated: SnapshotNodeUpdate[] = [];
  for (const currentStored of currentNodes) {
    const candidates = [
      ...(oldByRef.get(currentStored.node.ref) ?? []),
      ...(oldBySemantic.get(semanticKey(currentStored.node)) ?? []),
    ];
    const match = candidates.find((candidate) => !used.has(candidate.index));
    if (!match) {
      added.push(cloneNode(currentStored.node));
      continue;
    }
    used.add(match.index);
    const changed = changedFields(match.stored, currentStored);
    if (changed.length > 0) {
      updated.push({
        key: semanticKey(currentStored.node),
        before: cloneNode(match.stored.node),
        after: cloneNode(currentStored.node),
        changed,
      });
    }
  }
  const removed = base.nodes
    .filter((_stored, index) => !used.has(index))
    .map(({ node }) => cloneNode(node));
  return {
    sinceSnapshotId,
    snapshotId: current.snapshotId!,
    ...(current.tabId !== undefined ? { tabId: current.tabId } : {}),
    fromPageRevision: base.pageRevision,
    pageRevision: current.pageRevision!,
    pageRevisionChanged: base.pageRevision !== current.pageRevision,
    added,
    removed,
    updated,
    changed: added.length > 0 || removed.length > 0 || updated.length > 0,
  };
}

function addMapValue<T>(map: Map<string, T[]>, key: string, value: T): void {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}

function semanticKey(node: SemanticNode): string {
  const frame = node.frameId ?? 'main';
  if (node.testId) return `test:${frame}:${node.testId}`;
  return [
    'semantic',
    frame,
    node.role,
    node.tag,
    node.name,
    node.type ?? '',
  ].map((part) => encodeURIComponent(part)).join(':');
}

function changedFields(before: StoredNode, after: StoredNode): SnapshotNodeField[] {
  const changed: SnapshotNodeField[] = [];
  for (const field of NODE_FIELDS) {
    if (field === 'text') {
      if (before.textDigest !== after.textDigest) changed.push(field);
      continue;
    }
    if (before.node[field] !== after.node[field]) changed.push(field);
  }
  return changed;
}

function sameStoredNodes(left: readonly StoredNode[], right: readonly StoredNode[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const other = right[index];
    if (!other || entry.textDigest !== other.textDigest) return false;
    return NODE_FIELDS.every((field) => field === 'text' || entry.node[field] === other.node[field]) &&
      entry.node.ref === other.node.ref && entry.node.generation === other.node.generation;
  });
}

function boundedText(value: string, maxLength: number): string {
  // Bound work as well as retained output when an adapter hands us an
  // unexpectedly large string. Four times the output budget leaves room for
  // whitespace normalization without scanning unbounded page data.
  return value.slice(0, maxLength * 4)
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxLength);
}

function truncateUtf8(value: string, maxBytes: number): { value: string; bytes: number; truncated: boolean } {
  const originalBytes = byteLength(value);
  if (originalBytes <= maxBytes) return { value, bytes: originalBytes, truncated: false };
  const bytes = Buffer.from(value, 'utf8').subarray(0, maxBytes);
  let bounded = bytes.toString('utf8').replace(/\uFFFD+$/u, '');
  return { value: bounded, bytes: byteLength(bounded), truncated: true };
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function sha256(value: string): string {
  // Only the one-way digest is retained; the original text is not. This is
  // used to detect changes in omitted target text and is never exposed.
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function boundedInteger(value: number | undefined, minimum: number, maximum: number, fallback: number): number {
  return value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

export default SnapshotHistory;
