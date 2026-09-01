import { mkdir, open } from 'node:fs/promises';
import { dirname, isAbsolute, normalize, parse as parsePath } from 'node:path';

import {
  BrowserToolError,
  isBrowserToolError,
  sanitizeErrorDetails,
} from './domain.js';

export interface AuditEvent {
  readonly [key: string]: unknown;
}

export interface AuditLoggerOptions {
  /** Absolute, server-owned append-only JSONL path. */
  readonly path?: string;
  /** Alias matching AppConfig. */
  readonly auditPath?: string;
  readonly now?: () => Date;
  readonly maxEventBytes?: number;
}

const DEFAULT_MAX_EVENT_BYTES = 256 * 1024;

/**
 * Append-only JSONL audit writer. Writes are serialized so concurrent tool
 * calls cannot interleave records. The sanitizer intentionally keeps a small
 * metadata vocabulary and never persists input text, cookies or credentials.
 */
export class AuditLogger {
  readonly auditPath: string;

  private readonly now: () => Date;
  private readonly maxEventBytes: number;
  private pending: Promise<void> = Promise.resolve();

  constructor(pathOrOptions: string | AuditLoggerOptions) {
    const configuredPath =
      typeof pathOrOptions === 'string'
        ? pathOrOptions
        : pathOrOptions.path ?? pathOrOptions.auditPath;
    if (configuredPath === undefined || !configuredPath.trim()) {
      throw new BrowserToolError('INVALID_INPUT', 'An audit path is required.', {
        details: { field: 'auditPath', reason: 'missing' },
      });
    }
    if (configuredPath.includes('\0') || !isAbsolute(configuredPath)) {
      throw new BrowserToolError('INVALID_INPUT', 'The audit path must be absolute.', {
        details: { field: 'auditPath', reason: 'absolute-server-path-required' },
      });
    }
    const normalizedPath = normalize(configuredPath);
    if (normalizedPath === parsePath(normalizedPath).root) {
      throw new BrowserToolError('INVALID_INPUT', 'The audit path must identify a file.', {
        details: { field: 'auditPath', reason: 'root-path-not-allowed' },
      });
    }
    if (normalizedPath.length > 4_096) {
      throw new BrowserToolError('INVALID_INPUT', 'The audit path is too long.', {
        details: { field: 'auditPath', reason: 'path-too-long' },
      });
    }
    this.auditPath = normalizedPath;
    this.now = typeof pathOrOptions === 'string' ? () => new Date() : pathOrOptions.now ?? (() => new Date());
    this.maxEventBytes =
      typeof pathOrOptions === 'string'
        ? DEFAULT_MAX_EVENT_BYTES
        : pathOrOptions.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
    if (!Number.isSafeInteger(this.maxEventBytes) || this.maxEventBytes < 1_024 || this.maxEventBytes > 4 * 1024 * 1024) {
      throw new BrowserToolError('INVALID_INPUT', 'The audit event limit is invalid.', {
        details: { field: 'maxEventBytes', reason: 'outside-safe-range' },
      });
    }
  }

  /** Queue one sanitized event and resolve when it has reached disk. */
  record(event: AuditEvent): Promise<void> {
    const operation = this.pending.then(() => this.appendSanitized(event));
    // A failed record must not permanently poison later records, while the
    // failed caller still receives the original AUDIT_UNAVAILABLE rejection.
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  /** Wait for all records queued before this call. */
  async flush(): Promise<void> {
    await this.pending;
  }

  private async appendSanitized(event: AuditEvent): Promise<void> {
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      throw new BrowserToolError('INVALID_INPUT', 'An audit event must be an object.', {
        details: { field: 'event', reason: 'object-required' },
      });
    }

    let safeEvent: Record<string, unknown>;
    try {
      safeEvent = sanitizeAuditEvent(event, this.now);
    } catch {
      throw new BrowserToolError('AUDIT_UNAVAILABLE', 'The audit event could not be serialized.', {
        details: { reason: 'serialization-failed' },
      });
    }

    let line: string;
    try {
      line = JSON.stringify(safeEvent);
    } catch {
      throw new BrowserToolError('AUDIT_UNAVAILABLE', 'The audit event could not be serialized.', {
        details: { reason: 'serialization-failed' },
      });
    }
    if (Buffer.byteLength(line, 'utf8') > this.maxEventBytes) {
      throw new BrowserToolError('AUDIT_UNAVAILABLE', 'The audit event is too large.', {
        details: { reason: 'event-too-large' },
      });
    }

    try {
      await mkdir(dirname(this.auditPath), { recursive: true, mode: 0o700 });
      const handle = await open(this.auditPath, 'a', 0o600);
      try {
        await handle.writeFile(`${line}\n`, 'utf8');
      } finally {
        await handle.close();
      }
    } catch (error) {
      throw new BrowserToolError('AUDIT_UNAVAILABLE', 'The audit log is unavailable.', {
        details: { reason: 'write-failed' },
        cause: error,
      });
    }
  }
}

/** Sanitize an event before JSON encoding; exported for deterministic tests. */
export function sanitizeAuditEvent(
  event: AuditEvent,
  now: () => Date = () => new Date(),
): Record<string, unknown> {
  const sanitized = sanitizeErrorDetails(event);

  // Timestamp is generated by the trusted service clock. An event may supply
  // a timestamp for replay/import, but it is still represented as text only.
  const suppliedTimestamp = event.timestamp;
  const timestamp =
    typeof suppliedTimestamp === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(suppliedTimestamp)
      ? suppliedTimestamp
      : now().toISOString();
  delete sanitized.timestamp;

  return {
    timestamp,
    ...sanitized,
  };
}

/** Convert a thrown value to a safe audit error payload when needed by callers. */
export function serializeAuditError(error: unknown): Record<string, unknown> {
  if (isBrowserToolError(error)) return { ...error.serialize() };
  if (error instanceof Error) return { name: error.name };
  return sanitizeErrorDetails(error);
}
