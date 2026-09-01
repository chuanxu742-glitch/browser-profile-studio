import type { SchedulerLocatorLike } from '../input/scheduler.js';
import { HARD_AUTOMATION_LIMITS } from './automation-policy.js';

export type SemanticRole = string;

export interface SemanticTarget {
  role?: SemanticRole;
  name?: string;
  exact?: boolean;
  label?: string;
  testId?: string;
  /** Internal compatibility field; never accepted by the public MCP schema. */
  selector?: string;
}

export interface SemanticTargetMetadata {
  role: SemanticRole;
  name: string;
  tag: string;
  type?: string;
  testId?: string;
  frameId?: string;
  visible?: boolean;
  enabled?: boolean;
  editable?: boolean;
  checked?: boolean;
  required?: boolean;
  /** Deliberately never contains a value from an input control. */
  value?: '<redacted>';
  text?: string;
}

export interface SemanticNode extends SemanticTargetMetadata {
  ref: string;
  generation: number;
  frameGeneration?: number;
}

export interface SemanticSnapshot {
  /** Opaque identifier for this observation. It is never accepted as a target. */
  snapshotId?: string;
  /** Stable tab identity needed to bind observations to one isolated page. */
  tabId?: string;
  generation: number;
  pageGeneration?: number;
  /** Preferred public name for pageGeneration in the v2 observation contract. */
  pageRevision?: number;
  frameGeneration?: number;
  url?: string;
  title?: string;
  text?: string;
  textTruncated?: boolean;
  /** Compact, model-oriented representation of the safe semantic targets. */
  content?: string;
  contentBytes?: number;
  format?: 'structured' | 'compact';
  truncated?: {
    content: boolean;
    targets: boolean;
    reason?: 'max_bytes' | 'max_nodes';
  };
  targets: SemanticNode[];
  /** Alias used by clients that call the list `elements`. */
  elements: SemanticNode[];
}

export interface SnapshotBuildOptions {
  generation?: number;
  pageGeneration?: number;
  frameGeneration?: number;
  maxNodes?: number;
  maxChars?: number;
  maxBytes?: number;
  includeText?: boolean;
  format?: 'structured' | 'compact';
  frameId?: string;
}

export interface SnapshotCandidate {
  locator: SchedulerLocatorLike;
  metadata: SemanticTargetMetadata;
}

export function redactControlValue(metadata: SemanticTargetMetadata): SemanticTargetMetadata {
  const type = metadata.type?.toLowerCase();
  const sensitive = type === 'password' || type === 'hidden' || type === 'secret';
  const { value: _value, ...rest } = metadata;
  return sensitive || _value !== undefined ? { ...rest, value: '<redacted>' } : rest;
}

export function truncateText(value: string, maxChars: number): { value: string; truncated: boolean } {
  const safeMax = Math.max(0, Math.floor(maxChars));
  if (value.length <= safeMax) return { value, truncated: false };
  return { value: value.slice(0, safeMax), truncated: true };
}

export function createSemanticSnapshot(
  candidates: readonly SnapshotCandidate[],
  options: SnapshotBuildOptions = {},
): SemanticSnapshot {
  const maxNodes = Math.max(1, Math.min(2_000, Math.floor(options.maxNodes ?? 500)));
  const targets = candidates.slice(0, maxNodes).map(({ metadata }) => redactControlValue(metadata) as SemanticNode);
  const snapshot: SemanticSnapshot = {
    generation: options.generation ?? options.pageGeneration ?? 0,
    ...(options.pageGeneration !== undefined ? { pageGeneration: options.pageGeneration } : {}),
    ...(options.frameGeneration !== undefined ? { frameGeneration: options.frameGeneration } : {}),
    targets,
    elements: targets,
  };
  return snapshot;
}

export interface CompactSnapshotOptions {
  maxBytes?: number;
  format?: 'structured' | 'compact';
}

/**
 * Add the v2 model-oriented observation fields without removing the original
 * structured snapshot. The formatter uses only already-redacted metadata.
 */
export function addCompactSnapshotContent(
  snapshot: SemanticSnapshot,
  options: CompactSnapshotOptions = {},
): SemanticSnapshot {
  const maxBytes = Math.max(100, Math.min(HARD_AUTOMATION_LIMITS.snapshotMaxSnapshotBytes, Math.floor(options.maxBytes ?? 16_000)));
  const lines: string[] = [];
  if (snapshot.title) lines.push(`Page: ${singleLine(snapshot.title, 500)}`);
  if (snapshot.url) lines.push(`URL: ${singleLine(snapshot.url, 2_048)}`);
  if (lines.length > 0 && snapshot.targets.length > 0) lines.push('');
  for (const target of snapshot.targets) lines.push(formatTarget(target));
  if (snapshot.text) {
    if (lines.length > 0) lines.push('');
    lines.push('Text:');
    lines.push(compactText(snapshot.text));
  }

  const joined = lines.join('\n');
  const bounded = truncateUtf8(joined, maxBytes);
  // Target enumeration currently has no reliable "more available" signal;
  // do not claim truncation merely because the returned array hit a common
  // size. A future registry cursor can set this precisely.
  const targetsTruncated = false;
  const result: SemanticSnapshot = {
    ...snapshot,
    pageRevision: snapshot.pageGeneration ?? snapshot.generation,
    content: bounded.value,
    contentBytes: bounded.bytes,
    format: options.format ?? 'structured',
    truncated: {
      content: bounded.truncated,
      targets: targetsTruncated,
      ...(bounded.truncated
        ? { reason: 'max_bytes' as const }
        : targetsTruncated
          ? { reason: 'max_nodes' as const }
          : {}),
    },
  };
  if (options.format === 'compact') {
    // The compact content already carries the safe refs and page text. Avoid
    // returning the same information three times in MCP structuredContent.
    result.targets = [];
    result.elements = result.targets;
    delete result.text;
    delete result.textTruncated;
  }
  return result;
}

function formatTarget(target: SemanticNode): string {
  const ref = singleLine(target.ref, 100);
  const role = singleLine(target.role || target.tag || 'generic', 64);
  const name = singleLine(target.name || target.text || '', 500);
  const attributes: string[] = [];
  if (target.type) attributes.push(`type=${JSON.stringify(singleLine(target.type, 64))}`);
  if (target.required) attributes.push('required');
  if (target.checked !== undefined) attributes.push(`checked=${String(target.checked)}`);
  if (target.enabled === false) attributes.push('disabled');
  if (target.editable) attributes.push('editable');
  const suffix = attributes.length > 0 ? ` ${attributes.join(' ')}` : '';
  return `${ref} [${role}]${name ? ` ${JSON.stringify(name)}` : ''}${suffix}`;
}

function singleLine(value: string, maxChars: number): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

function compactText(value: string): string {
  return value
    .split(/\r?\n/u)
    .map((line) => singleLine(line, 10_000))
    .filter(Boolean)
    .join('\n');
}

export function truncateUtf8(value: string, maxBytes: number): { value: string; bytes: number; truncated: boolean } {
  const safeMax = Math.max(0, Math.floor(maxBytes));
  const originalBytes = Buffer.byteLength(value, 'utf8');
  if (originalBytes <= safeMax) return { value, bytes: originalBytes, truncated: false };
  if (safeMax === 0) return { value: '', bytes: 0, truncated: true };
  const bytes = Buffer.from(value, 'utf8').subarray(0, safeMax);
  let bounded = bytes.toString('utf8');
  // Buffer may end in the middle of a multibyte sequence. Node replaces that
  // suffix with U+FFFD; remove it so the byte contract remains exact.
  bounded = bounded.replace(/\uFFFD+$/u, '');
  return { value: bounded, bytes: Buffer.byteLength(bounded, 'utf8'), truncated: true };
}
