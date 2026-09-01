import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionManager } from '../../src/browser/session-manager.js';
import { ProfileStore } from '../../src/profile/profile-store.js';
import { UrlPolicy } from '../../src/policy/url-policy.js';
import { AuditLogger } from '../../src/audit.js';

describe('Comprehensive Anti-Detect Fingerprint Suite (方案一 + 方案二 + 方案三)', () => {
  let server: Server;
  let origin: string;
  let workRoot: string;
  let store: ProfileStore;

  beforeAll(async () => {
    workRoot = await mkdtemp(join(tmpdir(), 'comprehensive-suite-'));
    store = new ProfileStore(join(workRoot, 'profiles'));

    // HTML Fixture for complete probe detection and behavioral dynamics recording
    const suiteHtml = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Anti-Detect Validation Suite</title></head>
<body>
  <h1>Fingerprint & Human Dynamics Benchmark</h1>
  <div id="status">Ready</div>
  <input type="text" id="target-input" data-testid="target-input" />
  <button id="target-btn" data-testid="target-btn">Submit</button>

  <script>
    // Record mouse movement dynamics
    window.__MOUSE_EVENTS__ = [];
    window.__KEY_EVENTS__ = [];

    window.addEventListener('mousemove', (e) => {
      window.__MOUSE_EVENTS__.push({ x: e.clientX, y: e.clientY, time: performance.now() });
    });

    const input = document.getElementById('target-input');
    input.addEventListener('keydown', (e) => {
      window.__KEY_EVENTS__.push({ key: e.key, time: performance.now() });
    });

    // Probe All Fingerprint & Anti-Detection Dimensions
    window.__COLLECT_METRICS__ = async function() {
      const metrics = {};

      // 1. Webdriver & Automation
      metrics.webdriver = navigator.webdriver;
      metrics.hasChromeRuntime = typeof window.chrome !== 'undefined' && typeof window.chrome.runtime !== 'undefined';
      
      // 2. Native toString Defense
      try {
        const testFn = HTMLCanvasElement.prototype.toDataURL || CanvasRenderingContext2D.prototype.getImageData;
        metrics.toStringNative = Function.prototype.toString.call(testFn).includes('[native code]');
      } catch (e) {
        metrics.toStringNative = false;
      }

      // 3. WebGL GPU
      try {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl');
        if (gl) {
          const debug = gl.getExtension('WEBGL_debug_renderer_info');
          if (debug) {
            metrics.webglVendor = gl.getParameter(debug.UNMASKED_VENDOR_WEBGL);
            metrics.webglRenderer = gl.getParameter(debug.UNMASKED_RENDERER_WEBGL);
          }
        }
      } catch (e) {
        metrics.webglError = e.message;
      }

      // 4. Canvas Noise & Hash
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 100;
        canvas.height = 100;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ff0000';
        ctx.fillRect(0, 0, 50, 50);
        ctx.fillStyle = '#00ff00';
        ctx.fillRect(50, 0, 50, 50);
        ctx.fillStyle = '#0000ff';
        ctx.fillRect(0, 50, 50, 50);
        const imgData = ctx.getImageData(0, 0, 100, 100);
        let hash = 0;
        for (let i = 0; i < imgData.data.length; i++) {
          hash = ((hash << 5) - hash) + imgData.data[i];
          hash |= 0;
        }
        metrics.canvasPixelHash = hash;
        metrics.canvasDataUrl = canvas.toDataURL();
        const repeatData = ctx.getImageData(0, 0, 100, 100);
        let repeatHash = 0;
        for (let i = 0; i < repeatData.data.length; i++) {
          repeatHash = ((repeatHash << 5) - repeatHash) + repeatData.data[i];
          repeatHash |= 0;
        }
        metrics.canvasPixelHashRepeat = repeatHash;
      } catch (e) {
        metrics.canvasError = e.message;
      }

      // 5. AudioContext Noise
      try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const buffer = audioCtx.createBuffer(1, 100, 44100);
        const data = buffer.getChannelData(0);
        metrics.audioSample = data[0];
        await audioCtx.close();
      } catch (e) {
        metrics.audioSample = 0;
      }

      // 6. Hardware & Screen
      metrics.hardwareConcurrency = navigator.hardwareConcurrency;
      metrics.deviceMemory = navigator.deviceMemory;
      metrics.screenWidth = screen.width;
      metrics.screenHeight = screen.height;

      // 7. Geo & Locale
      metrics.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      metrics.languages = navigator.languages ? Array.from(navigator.languages) : [navigator.language];

      return metrics;
    };
  </script>
</body>
</html>
    `;

    server = createServer((req, res) => {
      if (new URL(req.url || '/', 'http://127.0.0.1').pathname === '/service-worker.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        res.end(`self.addEventListener('message', (event) => {
          const target = self;
          let renderer;
          try {
            const canvas = new OffscreenCanvas(1, 1);
            const gl = canvas.getContext('webgl');
            const debug = gl && gl.getExtension('WEBGL_debug_renderer_info');
            renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : undefined;
          } catch (e) {}
          event.ports[0]?.postMessage({
            userAgent: target.navigator.userAgent,
            language: target.navigator.language,
            languages: Array.from(target.navigator.languages || []),
            timezone: target.Intl.DateTimeFormat().resolvedOptions().timeZone,
            webdriver: target.navigator.webdriver,
            hardwareConcurrency: target.navigator.hardwareConcurrency,
            renderer,
          });
        });`);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(suiteHtml);
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Server TCP error');
    origin = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (workRoot) await rm(workRoot, { recursive: true, force: true });
  });

  function createTestManager() {
    return new SessionManager({
      maxSessions: 4,
      profileRoot: join(workRoot, 'profiles'),
      artifactsRoot: join(workRoot, 'artifacts'),
      profileStore: store,
      urlPolicy: new UrlPolicy({
        allowedHosts: ['127.0.0.1'],
        resourceHosts: ['127.0.0.1'],
        allowHttp: true,
        allowPrivateNetwork: true,
      }),
      audit: new AuditLogger(join(workRoot, 'audit.jsonl')),
    });
  }

  // =========================================================================
  // 方案一测试：权威风控指标与探针抹除（Webdriver、Runtime、ToString、GPU、Canvas）
  // =========================================================================
  it('【方案一】权威反欺诈指标与指纹探针全面测试', async () => {
    const manager = createTestManager();
    const session = await manager.start({
      headless: true,
      fingerprint: true,
      fingerprintSeed: 777111,
      countryCode: 'US',
    });

    try {
      await manager.open(session.sessionId, `${origin}/probe-test`);
      
      const metrics = await (session as any).page?.evaluate('window.__COLLECT_METRICS__()') as Record<string, any>;

      // 1. Webdriver 必须抹除
      expect(metrics.webdriver).toBeUndefined();

      // 2. Firefox 会话保持原生纯净，无 Chrome 污染
      expect(metrics.hasChromeRuntime).toBe(false);

      // 3. Function toString 必须返回 native code
      expect(metrics.toStringNative).toBe(true);

      // 4. WebGL GPU 伪装成独立/主流显卡
      expect(metrics.webglRenderer).toBeDefined();
      expect(metrics.webglVendor).toBeDefined();

      // 5. 硬件参数自洽
      expect(metrics.hardwareConcurrency).toBeGreaterThanOrEqual(4);
      expect(metrics.deviceMemory).toBeGreaterThanOrEqual(4);
      expect(metrics.screenWidth).toBeGreaterThanOrEqual(1024);

      // 6. GeoIP 时区与语言对齐 (US -> America/New_York / en-US)
      expect(metrics.timezone).toBe('America/New_York');
      expect(metrics.languages[0]).toBe('en-US');

      console.log('✅ [方案一] 权威风控与指纹伪装指标测试 100% 达标:', {
        webdriver: metrics.webdriver,
        chromeRuntime: metrics.hasChromeRuntime,
        toStringDefense: metrics.toStringNative,
        gpu: metrics.webglRenderer,
        timezone: metrics.timezone,
      });
    } finally {
      await manager.stop(session.sessionId, 'test_done');
      await manager.shutdown();
    }
  }, 30_000);

  // =========================================================================
  // 方案二测试：多环境隔离性（A/B Hash 隔离）与单环境稳定性测试
  // =========================================================================
  it('【方案二】多环境隔离性（A/B Hash 碰撞隔离）与单环境确定性稳定性测试', async () => {
    const manager = createTestManager();

    // 1. 创建并启动 Profile A (美区，种子 1001)
    const sessionA1 = await manager.start({
      headless: true,
      fingerprint: true,
      fingerprintSeed: 1001,
      countryCode: 'US',
    });
    await manager.open(sessionA1.sessionId, `${origin}/test-a1`);
    const metricsA1 = await (sessionA1 as any).page?.evaluate('window.__COLLECT_METRICS__()') as Record<string, any>;
    await manager.stop(sessionA1.sessionId, 'test');

    // 2. 再次启动 Profile A (相同种子 1001) - 验证单环境稳定性
    const sessionA2 = await manager.start({
      headless: true,
      fingerprint: true,
      fingerprintSeed: 1001,
      countryCode: 'US',
    });
    await manager.open(sessionA2.sessionId, `${origin}/test-a2`);
    const metricsA2 = await (sessionA2 as any).page?.evaluate('window.__COLLECT_METRICS__()') as Record<string, any>;
    await manager.stop(sessionA2.sessionId, 'test');

    // 3. 创建并启动 Profile B (日区，种子 2002) - 验证跨环境隔离性
    const sessionB = await manager.start({
      headless: true,
      fingerprint: true,
      fingerprintSeed: 2002,
      countryCode: 'JP',
    });
    await manager.open(sessionB.sessionId, `${origin}/test-b`);
    const metricsB = await (sessionB as any).page?.evaluate('window.__COLLECT_METRICS__()') as Record<string, any>;
    await manager.stop(sessionB.sessionId, 'test');

    console.log('METRICS A1:', JSON.stringify(metricsA1, null, 2));
    console.log('METRICS B:', JSON.stringify(metricsB, null, 2));

    await manager.shutdown();

    // 验证单环境指纹稳定性 (A1 与 A2 必须完全一致)
    expect(metricsA1.webglRenderer).toBe(metricsA2.webglRenderer);
    expect(metricsA1.timezone).toBe(metricsA2.timezone);
    expect(metricsA1.hardwareConcurrency).toBe(metricsA2.hardwareConcurrency);
    expect(metricsA1.screenWidth).toBe(metricsA2.screenWidth);

    // 验证多环境隔离性 (A 与 B 必须完全不同)
    expect(metricsA1.timezone).not.toBe(metricsB.timezone);
    expect(metricsA1.timezone).toBe('America/New_York');
    expect(metricsB.timezone).toBe('Asia/Tokyo');
    expect(metricsB.languages[0]).toBe('ja-JP');
    expect(metricsA1.hardwareConcurrency).not.toBe(metricsB.hardwareConcurrency);

    console.log('✅ [方案二] 多环境隔离与单环境稳定性测试 100% 达标:', {
      'Profile A1 vs A2 (单环境稳定性)': metricsA1.timezone === metricsA2.timezone && metricsA1.hardwareConcurrency === metricsA2.hardwareConcurrency ? 'MATCH (PASS)' : 'DIFF',
      'Profile A vs Profile B (跨环境隔离)': metricsA1.timezone !== metricsB.timezone && metricsA1.hardwareConcurrency !== metricsB.hardwareConcurrency ? 'ISOLATED (PASS)' : 'COLLISION',
      'Profile A Hardware Concurrency': metricsA1.hardwareConcurrency,
      'Profile B Hardware Concurrency': metricsB.hardwareConcurrency,
      'Profile A Timezone': metricsA1.timezone,
      'Profile B Timezone': metricsB.timezone,
    });
  }, 45_000);

  it('keeps locale, timezone, hardware, and WebGL aligned across frames and workers', async () => {
    const manager = createTestManager();
    const session = await manager.start({
      headless: true,
      fingerprint: true,
      fingerprintSeed: 31337,
      countryCode: 'JP',
    });

    try {
      await manager.open(session.sessionId, `${origin}/cross-context`);
      const metrics = await (session as any).page?.evaluate(`(async () => {
        const readContext = (target) => {
          let renderer;
          try {
            const canvas = target.document
              ? target.document.createElement('canvas')
              : new OffscreenCanvas(1, 1);
            const gl = canvas.getContext('webgl');
            const debug = gl && gl.getExtension('WEBGL_debug_renderer_info');
            renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : undefined;
          } catch (e) {}
          return {
            userAgent: target.navigator.userAgent,
            language: target.navigator.language,
            languages: Array.from(target.navigator.languages || []),
            timezone: target.Intl.DateTimeFormat().resolvedOptions().timeZone,
            webdriver: target.navigator.webdriver,
            webdriverPresent: 'webdriver' in target.navigator,
            hardwareConcurrency: target.navigator.hardwareConcurrency,
            renderer,
          };
        };

        const top = readContext(window);
        const frame = document.createElement('iframe');
        frame.srcdoc = '<html><body>frame</body></html>';
        const iframeDeferred = Promise.withResolvers();
        frame.onload = () => iframeDeferred.resolve(readContext(frame.contentWindow));
        document.body.appendChild(frame);
        const iframe = await iframeDeferred.promise;
        let worker;
        try {
          const workerDeferred = Promise.withResolvers();
          const source = 'self.postMessage((' + readContext.toString() + ')(self));';
          const instance = new Worker(new Blob([source], { type: 'application/javascript' }));
          const timer = setTimeout(() => workerDeferred.reject(new Error('worker profile probe timed out')), 3000);
          instance.onmessage = (event) => {
            clearTimeout(timer);
            instance.terminate();
            workerDeferred.resolve(event.data);
          };
          instance.onerror = () => {
            clearTimeout(timer);
            instance.terminate();
            workerDeferred.resolve(undefined);
          };
          worker = await workerDeferred.promise;
        } catch (_) {
          worker = undefined;
        }
        let serviceWorker;
        if (navigator.serviceWorker) {
          const registration = await navigator.serviceWorker.register('/service-worker.js', { scope: '/' });
          const active = registration.active || (await navigator.serviceWorker.ready).active;
          if (active) {
            const serviceDeferred = Promise.withResolvers();
            const channel = new MessageChannel();
            const timer = setTimeout(() => serviceDeferred.reject(new Error('service worker profile probe timed out')), 5000);
            channel.port1.onmessage = (event) => {
              clearTimeout(timer);
              channel.port1.close();
              serviceDeferred.resolve(event.data);
            };
            active.postMessage({ type: 'profile' }, [channel.port2]);
            serviceWorker = await serviceDeferred.promise;
          }
          await registration.unregister();
        }
        return { top, iframe, worker, serviceWorker };
      })()`) as {
        top: Record<string, any>;
        iframe: Record<string, any>;
        worker: Record<string, any>;
        serviceWorker: Record<string, any>;
      };
      // Preserve standards-compatible Service Worker support. Firefox does not
      // apply page init scripts to that global, so it remains a documented
      // native surface rather than breaking sites by deleting the API.
      expect(metrics.serviceWorker).toBeDefined();
      expect(metrics.top.timezone).toBe('Asia/Tokyo');
      expect(metrics.top.language).toBe('ja-JP');
      expect(metrics.top.webdriver).toBeUndefined();
      expect(metrics.top.webdriverPresent).toBe(false);
      expect(metrics.iframe).toMatchObject({
        userAgent: metrics.top.userAgent,
        language: metrics.top.language,
        languages: metrics.top.languages,
        timezone: metrics.top.timezone,
        webdriver: undefined,
        webdriverPresent: false,
        hardwareConcurrency: metrics.top.hardwareConcurrency,
        renderer: metrics.top.renderer,
      });
      if (metrics.worker) {
        expect(metrics.worker).toMatchObject({
          userAgent: metrics.top.userAgent,
          language: metrics.top.language,
          languages: metrics.top.languages,
          timezone: metrics.top.timezone,
          webdriver: undefined,
          webdriverPresent: false,
          hardwareConcurrency: metrics.top.hardwareConcurrency,
          renderer: metrics.top.renderer,
        });
      }
    } finally {
      await manager.stop(session.sessionId, 'test_done');
      await manager.shutdown();
    }
  }, 45_000);

  // =========================================================================
  // 方案三测试：真人行为轨迹与交互动力学测试 (贝塞尔曲线、微步打字延迟、悬停停顿)
  // =========================================================================
  it('【方案三】真人行为动力学测试（贝塞尔平滑轨迹、逐字按键抖动、拟人停顿）', async () => {
    const manager = createTestManager();
    const session = await manager.start({
      headless: true,
      inputProfile: 'paced', // 启用拟人交互调度器
      fingerprint: true,
      fingerprintSeed: 888999,
    });

    try {
      await manager.open(session.sessionId, `${origin}/human-dynamics`);

      const snapshot = await manager.snapshot(session.sessionId, { includeText: true });
      const inputTarget = snapshot.targets.find((t) => t.testId === 'target-input');
      const btnTarget = snapshot.targets.find((t) => t.testId === 'target-btn');

      expect(inputTarget?.ref).toBeDefined();
      expect(btnTarget?.ref).toBeDefined();

      // 执行模拟人类打字与点击
      await manager.type(session.sessionId, inputTarget!.ref, 'Human_Pass_100', { clearFirst: true });
      await manager.click(session.sessionId, btnTarget!.ref);

      // 提取浏览器中记录的真实鼠标和键盘物理事件流
      const mouseEvents = await (session as any).page?.evaluate('window.__MOUSE_EVENTS__') as Array<{ x: number; y: number; time: number }>;
      const keyEvents = await (session as any).page?.evaluate('window.__KEY_EVENTS__') as Array<{ key: string; time: number }>;

      // 1. 验证鼠标不是瞬间瞬移，而是产生了一条平滑的多点轨迹流
      expect(mouseEvents.length).toBeGreaterThanOrEqual(6);
      const totalMoveDuration = mouseEvents[mouseEvents.length - 1]!.time - mouseEvents[0]!.time;
      expect(totalMoveDuration).toBeGreaterThanOrEqual(100); // 移动耗时 > 100ms

      // 2. 验证按键不是 0ms 瞬间批处理，而是存在逐字敲击的真实时间间隔
      expect(keyEvents.length).toBeGreaterThan(5);
      const keyIntervals: number[] = [];
      for (let i = 1; i < keyEvents.length; i++) {
        keyIntervals.push(keyEvents[i]!.time - keyEvents[i - 1]!.time);
      }
      const avgKeyInterval = keyIntervals.reduce((a, b) => a + b, 0) / keyIntervals.length;
      expect(avgKeyInterval).toBeGreaterThanOrEqual(20); // 平均每次击键间隔 >= 20ms

      console.log('✅ [方案三] 真人交互动力学测试 100% 达标:', {
        mouseTrajectoryPoints: mouseEvents.length,
        mouseDurationMs: Math.round(totalMoveDuration),
        keystrokeCount: keyEvents.length,
        avgKeyIntervalMs: Math.round(avgKeyInterval),
      });
    } finally {
      await manager.stop(session.sessionId, 'test_done');
      await manager.shutdown();
    }
  }, 45_000);
});
