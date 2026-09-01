import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { BrowserPool } from '../../src/control-plane/browser-pool.js';
import type { SessionManager } from '../../src/browser/session-manager.js';

describe('BrowserPool control-plane integration', () => {
  it('starts managed Chromium instances and supports safe mode changes', async () => {
    const start = vi.fn(async () => ({ sessionId: 'ses_pool_test' }));
    const stop = vi.fn(async () => undefined);
    const pool = new BrowserPool({ start, stop } as unknown as SessionManager);
    const instance = await pool.add({ name: 'managed', engine: 'chromium', start: false });
    expect(instance.state).toBe('STOPPED');
    const configured = pool.configure(instance.id, { mode: 'cdp', cdpEndpoint: 'http://127.0.0.1:9222' });
    expect(configured.mode).toBe('cdp');
    await pool.start(instance.id);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ engine: 'chromium', cdpEndpoint: 'http://127.0.0.1:9222/' }));
  });

  it('performs request-id Bridge RPC and rejects unsafe operations', async () => {
    const pool = new BrowserPool({ start: vi.fn(), stop: vi.fn() } as unknown as SessionManager);
    const instance = await pool.add({ name: 'bridge', mode: 'bridge', start: false });
    const socket = Object.assign(new EventEmitter(), { readyState: 1, send: vi.fn() });
    pool.attachBridge(instance.id, socket as never);
    const call = pool.bridgeCall(instance.id, { op: 'snapshot' });
    const command = JSON.parse(socket.send.mock.calls[1]![0] as string) as { requestId: string };
    socket.emit('message', JSON.stringify({ type: 'response', requestId: command.requestId, ok: true, result: { revision: 1 } }));
    await expect(call).resolves.toEqual({ revision: 1 });
    await expect(pool.bridgeCall(instance.id, { op: 'script', code: 'alert(1)' })).rejects.toThrow('BRIDGE_OPERATION_DENIED');
  });
});
