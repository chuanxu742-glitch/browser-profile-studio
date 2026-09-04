import { describe, expect, it, afterEach, vi } from 'vitest';
import WebSocket from 'ws';
import { RestApiServer } from '../../src/api/server.js';
import type { SessionManager } from '../../src/browser/session-manager.js';

describe('Studio Bridge integration (OpenCLI mode)', () => {
  let server: RestApiServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
  });

  it('supports ping, auto-registration over /ws/bridge and pullTabs REST API', async () => {
    const dummyManager = {
      getStore: () => ({}),
      start: vi.fn(),
      stop: vi.fn(),
    } as unknown as SessionManager;

    server = new RestApiServer(dummyManager, {
      port: 0,
      host: '127.0.0.1',
      credentials: [{ token: 'test-token', role: 'owner', label: 'Test Admin' }],
      localBrowserImporter: { scan: vi.fn(), importProfile: vi.fn() } as any,
    });

    const { port, host } = await server.start();
    const baseUrl = `http://${host}:${port}`;
    const wsUrl = `ws://${host}:${port}`;

    // 1. 测试 /ping 端点免鉴权响应
    const pingRes = await fetch(`${baseUrl}/ping`);
    expect(pingRes.status).toBe(200);
    const pingData = await pingRes.json() as any;
    expect(pingData.success).toBe(true);
    expect(pingData.data.service).toBe('antigravity-studio-bridge');

    // 2. 模拟 Chrome 扩展通过 WebSocket 连接 /ws/bridge（零配置即插即用）
    const ws = new WebSocket(`${wsUrl}/ws/bridge`);

    let registeredBrowserId: string | null = null;
    const helloPromise = new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'hello') {
          registeredBrowserId = msg.browserId;
          resolve();
        } else if (msg.type === 'command' && msg.op === 'tabs.list') {
          // 收到服务端的拉取标签页命令，返回模拟的标签列表
          ws.send(JSON.stringify({
            type: 'response',
            requestId: msg.requestId,
            ok: true,
            result: [
              { tabId: 201, title: '百度一下', url: 'https://www.baidu.com', active: true },
              { tabId: 202, title: 'GitHub', url: 'https://github.com', active: false },
            ],
          }));
        } else if (msg.type === 'command' && msg.op === 'tabs.switch') {
          ws.send(JSON.stringify({
            type: 'response',
            requestId: msg.requestId,
            ok: true,
            result: { tabId: msg.tabId, title: 'GitHub', url: 'https://github.com' },
          }));
        }
      });
    });

    await new Promise<void>((resolve) => ws.on('open', resolve));

    // 扩展握手
    ws.send(JSON.stringify({
      type: 'ready',
      protocol: 'antigravity-bridge.v1',
      version: '0.1.0',
      contextId: 'ctx_desktop_chrome',
      profileName: '我的宿主Chrome',
      activeTab: { tabId: 201, title: '百度一下', url: 'https://www.baidu.com' },
    }));

    await helloPromise;
    expect(registeredBrowserId).toBeTruthy();

    const headers = {
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
    };

    // 3. 调用 REST 接口获取已连接浏览器列表
    const listRes = await fetch(`${baseUrl}/api/v1/bridge/browsers`, { headers });
    expect(listRes.status).toBe(200);
    const listJson = await listRes.json() as any;
    expect(listJson.success).toBe(true);
    expect(listJson.data.items).toHaveLength(1);
    expect(listJson.data.items[0].id).toBe(registeredBrowserId);
    expect(listJson.data.items[0].contextId).toBe('ctx_desktop_chrome');

    // 4. 调用 REST 接口拉取打开的所有标签页
    const tabsRes = await fetch(`${baseUrl}/api/v1/bridge/browsers/${registeredBrowserId}/tabs`, { headers });
    expect(tabsRes.status).toBe(200);
    const tabsJson = await tabsRes.json() as any;
    expect(tabsJson.success).toBe(true);
    expect(tabsJson.data.tabs).toHaveLength(2);
    expect(tabsJson.data.tabs[0].title).toBe('百度一下');
    expect(tabsJson.data.tabs[1].url).toBe('https://github.com');

    // 5. 绑定/切换到 Tab #202
    const bindRes = await fetch(`${baseUrl}/api/v1/bridge/browsers/${registeredBrowserId}/tabs/bind`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tabId: 202 }),
    });
    expect(bindRes.status).toBe(200);
    const bindJson = await bindRes.json() as any;
    expect(bindJson.success).toBe(true);

    ws.close();
  });
});
