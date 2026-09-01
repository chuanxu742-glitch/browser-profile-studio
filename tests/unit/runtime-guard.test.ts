import { describe, expect, it, vi } from 'vitest';

import { BrowserToolError } from '../../src/domain.js';
import { McpRuntimeGuard } from '../../src/mcp/runtime-guard.js';
import { handleToolCall } from '../../src/mcp/server.js';
import type { SessionManagerLike } from '../../src/mcp/types.js';

function managerStub(status: () => unknown): SessionManagerLike {
  const unavailable = vi.fn();
  return {
    start: unavailable,
    status,
    stop: unavailable,
    reopenHeaded: unavailable,
    resume: unavailable,
    handoff: unavailable,
    takeover: unavailable,
    open: unavailable,
    snapshot: unavailable,
    screenshot: unavailable,
    click: unavailable,
    type: unavailable,
    select: unavailable,
    scroll: unavailable,
    wait: unavailable,
    workflow: unavailable,
    shutdown: unavailable,
  };
}

describe('MCP runtime guard', () => {
  it('enforces a bounded token bucket and records per-tool metrics', () => {
    let now = 0;
    const guard = new McpRuntimeGuard({ ratePerSecond: 1, burst: 2, now: () => now });

    expect(() => guard.beforeCall()).not.toThrow();
    expect(() => guard.beforeCall()).not.toThrow();
    expect(() => guard.beforeCall()).toThrowError(BrowserToolError);
    now = 1_000;
    expect(() => guard.beforeCall()).not.toThrow();

    guard.record('browser_status', true, 10.9);
    guard.record('browser_status', false, 20.2);
    expect(guard.snapshot().browser_status).toEqual({
      calls: 2,
      successes: 1,
      failures: 1,
      totalDurationMs: 30,
      maxDurationMs: 20,
    });
  });

  it('writes a fail-closed attempt audit before invoking the manager', async () => {
    const status = vi.fn(() => ({ sessionId: 'ses_12345678', state: 'READY' }));
    const result = await handleToolCall(managerStub(status), 'browser_status', {
      sessionId: 'ses_12345678',
    }, {
      audit: {
        record: () => {
          throw new BrowserToolError('AUDIT_UNAVAILABLE', 'Audit is unavailable.');
        },
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error).toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
    expect(status).not.toHaveBeenCalled();
  });

  it('records attempt and completion without retaining tool input', async () => {
    const events: Array<Record<string, unknown>> = [];
    const status = vi.fn(() => ({ sessionId: 'ses_12345678', state: 'READY' }));
    const result = await handleToolCall(managerStub(status), 'browser_status', {
      sessionId: 'ses_12345678',
    }, {
      audit: { record: (event) => { events.push(event); } },
    });
    await Promise.resolve();

    expect(result.isError).not.toBe(true);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ action: 'mcp_tool_call', phase: 'attempt', toolName: 'browser_status' });
    expect(events[1]).toMatchObject({ action: 'mcp_tool_call', phase: 'complete', outcome: 'success' });
    expect(JSON.stringify(events)).not.toContain('ses_12345678');
  });
  it('blocks write tools from a user-controlled workspace before dispatch', async () => {
    const manager = {
      ...managerStub(() => ({ sessionId: 'ses_12345678', state: 'READY' })),
      getWorkspaceForSession: vi.fn(() => ({ controlState: 'USER_CONTROLLED' })),
    } as unknown as SessionManagerLike;

    const result = await handleToolCall(manager, 'page_open', {
      sessionId: 'ses_12345678',
      url: 'https://example.test/blocked',
    }, { runtimeGuard: new McpRuntimeGuard() });

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error).toMatchObject({ code: 'USER_CONTROL_HARD_STOP' });
    expect(manager.open).not.toHaveBeenCalled();
  });
  it('blocks writes while the session is paused for a challenge', async () => {
    const open = vi.fn();
    const manager = {
      ...managerStub(() => ({ sessionId: 'ses_12345678', state: 'PAUSED_CHALLENGE' })),
      open,
      getSessionState: vi.fn(() => 'PAUSED_CHALLENGE'),
    } as unknown as SessionManagerLike;

    const result = await handleToolCall(manager, 'page_open', {
      sessionId: 'ses_12345678',
      url: 'https://example.test/challenge',
    }, { runtimeGuard: new McpRuntimeGuard() });

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error).toMatchObject({ code: 'SESSION_PAUSED_CHALLENGE' });
    expect(open).not.toHaveBeenCalled();
  });
});
