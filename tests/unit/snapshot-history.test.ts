import { describe, expect, it } from 'vitest';

import {
  SnapshotHistory,
  SnapshotHistoryError,
} from '../../src/browser/snapshot-history.js';
import type { SemanticNode, SemanticSnapshot } from '../../src/browser/semantic-snapshot.js';

function node(
  ref: string,
  fields: Partial<SemanticNode> = {},
): SemanticNode {
  return {
    ref,
    generation: 1,
    role: 'button',
    name: 'Save',
    tag: 'button',
    ...fields,
  };
}

function snapshot(
  revision: number,
  targets: SemanticNode[] = [],
  fields: Partial<SemanticSnapshot> = {},
): SemanticSnapshot {
  return {
    generation: revision,
    pageGeneration: revision,
    pageRevision: revision,
    targets,
    elements: targets,
    ...fields,
  };
}

describe('SnapshotHistory', () => {
  it('assigns an id and revision without mutating input, while retaining only a safe projection', () => {
    const original = snapshot(4, [node('ref_password', {
      role: 'textbox',
      name: 'Password',
      tag: 'input',
      type: 'password',
      value: 'never-store-this' as unknown as '<redacted>',
    })], {
      title: 'Private page',
      url: 'https://example.test/orders?token=secret',
      text: 'A body that must not be retained by history',
      content: 'A compact body that must not be retained by history',
    });
    const history = new SnapshotHistory({
      sessionId: 'ses_test_1234',
      idFactory: (sequence) => `snp_test_${sequence}`,
      now: () => 1_000,
    });

    const saved = history.record(original);
    const entry = history.require(saved.snapshotId!);

    expect(saved).not.toBe(original);
    expect(saved.snapshotId).toBe('snp_test_1');
    expect(saved.pageRevision).toBe(4);
    expect(original.snapshotId).toBeUndefined();
    expect(saved.targets[0]?.value).toBe('<redacted>');
    expect(entry.targets[0]?.value).toBe('<redacted>');
    expect(entry).not.toHaveProperty('title');
    expect(entry).not.toHaveProperty('url');
    expect(entry).not.toHaveProperty('text');
    expect(entry).not.toHaveProperty('content');
  });

  it('matches semantic targets when opaque refs are regenerated and reports added/removed/updated', () => {
    const history = new SnapshotHistory({ idFactory: (sequence) => `snp_${sequence}` });
    const first = history.record(snapshot(1, [
      node('old-save', { testId: 'save', enabled: true }),
      node('old-cancel', { testId: 'cancel', name: 'Cancel' }),
    ]));
    const current = snapshot(2, [
      node('new-save-ref', { testId: 'save', enabled: false }),
      node('new-delete-ref', { testId: 'delete', name: 'Delete' }),
    ]);

    const diff = history.diff(current, first.snapshotId!);

    expect(diff.sinceSnapshotId).toBe(first.snapshotId);
    expect(diff.pageRevisionChanged).toBe(true);
    expect(diff.added.map((target) => target.testId)).toEqual(['delete']);
    expect(diff.removed.map((target) => target.testId)).toEqual(['cancel']);
    expect(diff.updated).toHaveLength(1);
    expect(diff.updated[0]?.before.ref).toBe('old-save');
    expect(diff.updated[0]?.after.ref).toBe('new-save-ref');
    expect(diff.updated[0]?.changed).toEqual(['enabled']);
    expect(diff.changed).toBe(true);
  });

  it('detects omitted target text changes using a digest without retaining text', () => {
    const history = new SnapshotHistory({ idFactory: (sequence) => `snp_${sequence}` });
    const first = history.record(snapshot(1, [node('ref', { text: 'before' })]));
    const diff = history.diff(snapshot(1, [node('ref', { text: 'after' })]), first.snapshotId!);

    expect(diff.updated).toHaveLength(1);
    expect(diff.updated[0]?.changed).toEqual(['text']);
    expect(history.require(first.snapshotId!).targets[0]).not.toHaveProperty('text');
  });

  it('supports an atomic record-and-diff operation', () => {
    const history = new SnapshotHistory({ idFactory: (sequence) => `snp_${sequence}` });
    const first = history.record(snapshot(1, [node('ref', { checked: false })]));
    const result = history.recordWithDiff(snapshot(1, [node('ref', { checked: true })]), {
      sinceSnapshotId: first.snapshotId!,
    });

    expect(result.snapshot.snapshotId).toBe('snp_2');
    expect(result.diff?.updated[0]?.changed).toEqual(['checked']);
    expect(history.size).toBe(2);
  });

  it('returns stable errors for unknown, expired, and mismatched revisions', () => {
    let now = 100;
    const history = new SnapshotHistory({
      ttlMs: 10,
      idFactory: (sequence) => `snp_${sequence}`,
      now: () => now,
    });
    const first = history.record(snapshot(1));

    expect(() => history.diff(snapshot(1), 'snp_unknown')).toThrowError(
      expect.objectContaining({ code: 'SNAPSHOT_NOT_FOUND' }),
    );
    expect(() => history.diff(snapshot(2), first.snapshotId!, { requireSamePageRevision: true })).toThrowError(
      expect.objectContaining({ code: 'PAGE_REVISION_MISMATCH' }),
    );
    expect(() => history.diff(snapshot(1), first.snapshotId!, { expectedPageRevision: 9 })).toThrowError(
      expect.objectContaining({ code: 'PAGE_REVISION_MISMATCH' }),
    );

    now = 111;
    expect(() => history.diff(snapshot(1), first.snapshotId!)).toThrowError(
      expect.objectContaining({ code: 'SNAPSHOT_EXPIRED' }),
    );
  });

  it('evicts oldest entries by count and accounts for UTF-8 object bytes', () => {
    const history = new SnapshotHistory({
      maxSnapshots: 2,
      maxBytes: 10_000,
      idFactory: (sequence) => `snp_${sequence}`,
    });
    const first = history.record(snapshot(1, [node('a', { name: '一' })]));
    const second = history.record(snapshot(1, [node('b', { name: '二' })]));
    const third = history.record(snapshot(1, [node('c', { name: '三' })]));

    expect(history.size).toBe(2);
    expect(history.has(first.snapshotId!)).toBe(false);
    expect(history.has(second.snapshotId!)).toBe(true);
    expect(history.has(third.snapshotId!)).toBe(true);
    expect(history.bytes).toBeGreaterThan(0);
    expect(history.bytes).toBeLessThanOrEqual(10_000);
  });

  it('rejects a single entry larger than the object-size budget', () => {
    const history = new SnapshotHistory({
      maxBytes: 128,
      maxSnapshotBytes: 128,
      idFactory: (sequence) => `snp_${sequence}`,
    });
    expect(() => history.record(snapshot(1, [node('ref', { name: 'x'.repeat(200) })]))).toThrowError(
      expect.objectContaining({ code: 'RESOURCE_EXHAUSTED' }),
    );
    expect(history.size).toBe(0);
  });

  it('normalizes element aliases and enforces caller revision guards', () => {
    const history = new SnapshotHistory({ idFactory: (sequence) => `snp_${sequence}` });
    const aliased = snapshot(3, [], { targets: undefined as unknown as SemanticNode[], elements: [node('ref')] });
    const saved = history.record(aliased, { expectedPageRevision: 3 });

    expect(saved.targets).toHaveLength(1);
    expect(saved.elements).toBe(saved.targets);
    expect(() => history.record(snapshot(4), { expectedPageRevision: 3 })).toThrowError(
      expect.objectContaining({ code: 'PAGE_REVISION_MISMATCH' }),
    );
  });

  it('exposes its typed error class for integration-level handling', () => {
    const error = new SnapshotHistoryError('SNAPSHOT_NOT_FOUND', 'missing', { retryable: true });

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('SNAPSHOT_NOT_FOUND');
    expect(error.retryable).toBe(true);
  });
});
