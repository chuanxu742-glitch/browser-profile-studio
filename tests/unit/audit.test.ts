import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AuditLogger, sanitizeAuditEvent } from '../../src/audit.js';

describe('AuditLogger', () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })));
  });

  it('appends JSONL while omitting sensitive text and URL queries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'compliant-firefox-audit-'));
    directories.push(directory);
    const path = join(directory, 'audit.jsonl');
    const logger = new AuditLogger({ path, now: () => new Date('2026-08-30T00:00:00.000Z') });

    await logger.record({
      requestId: 'req-1',
      action: 'page_type',
      url: 'https://example.test/account?token=do-not-log',
      text: 'super-secret password',
      password: 'also-secret',
      cookie: 'session-cookie',
      target: { role: 'textbox', name: 'Email' },
      outcome: 'success',
    });
    await logger.flush();

    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(event.timestamp).toBe('2026-08-30T00:00:00.000Z');
    expect(event.url).toBe('https://example.test/account');
    expect(event.inputLength).toBe('super-secret password'.length);
    expect(JSON.stringify(event)).not.toContain('super-secret');
    expect(JSON.stringify(event)).not.toContain('also-secret');
    expect(JSON.stringify(event)).not.toContain('session-cookie');
    expect(JSON.stringify(event)).not.toContain('token=');
  });

  it('serializes concurrent records as complete, parseable lines', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'compliant-firefox-audit-'));
    directories.push(directory);
    const path = join(directory, 'nested', 'audit.jsonl');
    const logger = new AuditLogger(path);
    await Promise.all(
      Array.from({ length: 20 }, (_, index) => logger.record({ action: 'test', requestId: `req-${index}` })),
    );
    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(20);
    expect(lines.map((line) => JSON.parse(line).action)).toEqual(Array.from({ length: 20 }, () => 'test'));
  });

  it('can sanitize events deterministically without writing them', () => {
    const event = sanitizeAuditEvent(
      { url: 'https://example.test/?q=secret', text: 'hello' },
      () => new Date('2026-08-30T01:02:03.000Z'),
    );
    expect(event).toEqual({
      timestamp: '2026-08-30T01:02:03.000Z',
      url: 'https://example.test/',
      inputLength: 5,
    });
  });

  it('records only low-sensitivity target structure, never accessible names', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'compliant-firefox-audit-'));
    directories.push(directory);
    const path = join(directory, 'audit.jsonl');
    const logger = new AuditLogger(path);

    await logger.record({
      action: 'page_click',
      target: {
        role: 'button',
        tag: 'button',
        type: 'submit',
        inputType: 'password',
        name: 'Customer SSN 123-45-6789',
        accessibleName: 'Customer SSN 123-45-6789',
        text: 'do-not-record',
      },
    });
    const event = JSON.parse(await readFile(path, 'utf8')) as { target: Record<string, unknown> };
    expect(event.target).toEqual({ role: 'button', tag: 'button', type: 'submit', inputType: 'password' });
    expect(JSON.stringify(event)).not.toContain('Customer SSN');
    expect(JSON.stringify(event)).not.toContain('do-not-record');
  });

  it('drops generic secret, page-content, and server-path fields', () => {
    const event = sanitizeAuditEvent({
      authorization: 'Bearer super-secret',
      headers: { authorization: 'Bearer super-secret' },
      apiKey: 'api-secret',
      storageState: 'cookies-and-origins',
      pageText: 'private page text',
      responseBody: 'private response',
      profilePath: 'C:\\Users\\someone\\profile',
      workingDirectory: 'C:\\Users\\someone\\project',
      auditPath: 'C:\\logs\\audit.jsonl',
      traceId: 'tr_safe_correlation_id',
      action: 'page_open',
    }, () => new Date('2026-08-30T02:00:00.000Z'));

    expect(event).toEqual({
      timestamp: '2026-08-30T02:00:00.000Z',
      traceId: 'tr_safe_correlation_id',
      action: 'page_open',
    });
  });
});
