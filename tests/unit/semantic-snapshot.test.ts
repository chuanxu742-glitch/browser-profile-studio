import { describe, expect, it } from 'vitest';

import {
  addCompactSnapshotContent,
  truncateUtf8,
  type SemanticSnapshot,
} from '../../src/browser/semantic-snapshot.js';

describe('semantic snapshot v2', () => {
  it('adds a compact, redacted model view while preserving structured targets', () => {
    const snapshot: SemanticSnapshot = {
      generation: 7,
      pageGeneration: 7,
      title: 'Orders\nDashboard',
      url: 'https://example.test/orders',
      targets: [{
        ref: 'ref_safe_1',
        generation: 7,
        role: 'textbox',
        name: 'Search orders',
        tag: 'input',
        type: 'search',
        editable: true,
        value: '<redacted>',
      }],
      elements: [],
    };
    snapshot.elements = snapshot.targets;

    const result = addCompactSnapshotContent(snapshot, { maxBytes: 4_000, format: 'structured' });

    expect(result.pageRevision).toBe(7);
    expect(result.format).toBe('structured');
    expect(result.content).toContain('ref_safe_1 [textbox] "Search orders"');
    expect(result.content).not.toContain('<redacted>');
    expect(result.targets).toBe(snapshot.targets);
    expect(result.contentBytes).toBe(Buffer.byteLength(result.content!, 'utf8'));
  });

  it('does not duplicate structured arrays and page text in compact mode', () => {
    const snapshot: SemanticSnapshot = {
      generation: 1,
      pageGeneration: 1,
      text: 'Order 42\nReady',
      targets: [{ ref: 'ref_1', generation: 1, role: 'button', name: 'Open', tag: 'button' }],
      elements: [],
    };
    snapshot.elements = snapshot.targets;

    const result = addCompactSnapshotContent(snapshot, { format: 'compact' });

    expect(result.content).toContain('ref_1 [button] "Open"');
    expect(result.content).toContain('Order 42\nReady');
    expect(result.targets).toEqual([]);
    expect(result.elements).toBe(result.targets);
    expect(result).not.toHaveProperty('text');
  });

  it('enforces the UTF-8 byte budget without returning a broken code point', () => {
    const result = truncateUtf8('ab😀cd', 5);

    expect(result.truncated).toBe(true);
    expect(result.value).toBe('ab');
    expect(result.bytes).toBe(2);
    expect(Buffer.byteLength(result.value, 'utf8')).toBeLessThanOrEqual(5);
  });
});
