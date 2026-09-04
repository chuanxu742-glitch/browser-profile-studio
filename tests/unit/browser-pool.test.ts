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
    socket.emit('message', JSON.stringify({ type: 'ready', version: '0.1.0' }));
    expect(pool.get(instance.id)).toMatchObject({ state: 'READY', bridgeVersion: '0.1.0' });
    const call = pool.bridgeCall(instance.id, { op: 'snapshot' });
    const command = JSON.parse(socket.send.mock.calls[1]![0] as string) as { requestId: string };
    socket.emit('message', JSON.stringify({ type: 'response', requestId: command.requestId, ok: true, result: { revision: 1 } }));
    await expect(call).resolves.toEqual({ revision: 1 });
    await expect(pool.bridgeCall(instance.id, { op: 'script', code: 'alert(1)' })).rejects.toThrow('BRIDGE_OPERATION_DENIED');
  });

  it('applies the server URL policy before Bridge navigation is dispatched', async () => {
    const assertAllowed = vi.fn(async (url: string) => {
      if (url.includes('blocked.example')) throw new Error('URL_HOST_NOT_ALLOWED');
    });
    const pool = new BrowserPool({ start: vi.fn(), stop: vi.fn() } as unknown as SessionManager, { bridgeUrlPolicy: { assertAllowed } });
    const instance = await pool.add({ name: 'policy-bridge', mode: 'bridge', start: false });
    const socket = Object.assign(new EventEmitter(), { readyState: 1, send: vi.fn() });
    pool.attachBridge(instance.id, socket as never);
    await expect(pool.bridgeCall(instance.id, { op: 'navigate', url: 'https://blocked.example/' })).rejects.toThrow('URL_HOST_NOT_ALLOWED');
    expect(socket.send).toHaveBeenCalledTimes(1);
  });

  it('auto-registers incoming Bridge connection and supports pulling tabs (OpenCLI mode)', async () => {
    const pool = new BrowserPool({ start: vi.fn(), stop: vi.fn() } as unknown as SessionManager);
    const socket = Object.assign(new EventEmitter(), { readyState: 1, send: vi.fn() });

    // 1. 未预先创建实例，直接连入 /ws/bridge
    pool.attachOrAutoRegisterBridge(socket as never);

    // 模拟扩展上报握手
    socket.emit('message', JSON.stringify({
      type: 'ready',
      protocol: 'antigravity-bridge.v1',
      version: '0.1.0',
      contextId: 'ctx_work_chrome',
      profileName: '我的工作Chrome',
      activeTab: { tabId: 101, title: '淘宝首页', url: 'https://www.taobao.com' },
    }));

    const list = pool.list();
    const registered = list.find((item) => item.contextId === 'ctx_work_chrome');
    expect(registered).toBeDefined();
    expect(registered?.state).toBe('READY');
    expect(registered?.mode).toBe('bridge');
    expect(registered?.activeTab?.title).toBe('淘宝首页');

    // 2. 拉取标签页测试 (pullTabs)
    const pullPromise = pool.pullTabs(registered!.id);
    const commandCall = socket.send.mock.calls.find((c: any[]) => String(c[0]).includes('"op":"tabs.list"'));
    expect(commandCall).toBeDefined();
    const command = JSON.parse(commandCall![0] as string) as { requestId: string };

    socket.emit('message', JSON.stringify({
      type: 'response',
      requestId: command.requestId,
      ok: true,
      result: [
        { tabId: 101, title: '淘宝首页', url: 'https://www.taobao.com', active: false },
        { tabId: 102, title: '知乎热榜', url: 'https://www.zhihu.com/hot', active: true },
      ],
    }));

    const pulledTabs = await pullPromise;
    expect(pulledTabs).toHaveLength(2);
    expect(pulledTabs[1]?.title).toBe('知乎热榜');
    // 活跃标签页应已自动更新为知乎热榜
    expect(pool.get(registered!.id).activeTab?.title).toBe('知乎热榜');

    // 3. 切换标签页 (switchTab)
    const switchPromise = pool.switchTab(registered!.id, 101);
    const switchCall = socket.send.mock.calls.find((c: any[]) => String(c[0]).includes('"op":"tabs.switch"'));
    expect(switchCall).toBeDefined();
    const switchCmd = JSON.parse(switchCall![0] as string) as { requestId: string };

    socket.emit('message', JSON.stringify({
      type: 'response',
      requestId: switchCmd.requestId,
      ok: true,
      result: { tabId: 101, title: '淘宝首页', url: 'https://www.taobao.com' },
    }));

    await expect(switchPromise).resolves.toMatchObject({ tabId: 101 });
    expect(pool.get(registered!.id).activeTab?.tabId).toBe(101);
  });
});
