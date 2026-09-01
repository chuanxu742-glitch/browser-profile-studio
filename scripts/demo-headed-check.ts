import { SessionManager } from '../src/browser/session-manager.js';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function main() {
  console.log('====================================================');
  console.log('🚀 启动【指纹浏览器 - 真实有头窗口可视化演示】');
  console.log('====================================================');

  // 1. 启动本地可视化测试靶场服务
  const fixturePath = join(process.cwd(), 'tests', 'fixtures', 'pages', 'fingerprint-check.html');
  const html = await readFile(fixturePath, 'utf-8');

  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as any;
  const origin = `http://127.0.0.1:${addr.port}`;

  // 2. 初始化 SessionManager 并以【有头模式 headless: false】拉起真实窗口
  const manager = new SessionManager({
    maxSessions: 1,
    profileRoot: join(tmpdir(), 'headed-demo-profiles'),
    artifactsRoot: join(tmpdir(), 'headed-demo-artifacts'),
  });

  console.log('🌐 正在为您拉起真实的浏览器窗口（请观察您的屏幕桌面）...');
  const session = await manager.start({
    headless: false, // 弹出真实可视化桌面窗口
    inputProfile: 'paced', // 启用真实人类输入调度
    fingerprint: true, // 启用确定性 Profile 环境配置；不代表检测通过保证
    fingerprintSeed: 888666,
    countryCode: 'US',
  });

  console.log('📄 正在导航至指纹探针与行为检测靶场...');
  await manager.open(session.sessionId, `${origin}/benchmark`);

  console.log('🖱️ 正在执行【模拟真人贝塞尔曲线鼠标移动】与【自然打字输入】...');
  const snapshot = await manager.snapshot(session.sessionId, { includeText: true });
  const input = snapshot.targets.find((t) => t.testId === 'username-input');
  const submit = snapshot.targets.find((t) => t.testId === 'submit-button');

  if (input && submit) {
    await manager.type(session.sessionId, input.ref, 'Live_Headed_Demonstration', { clearFirst: true });
    await manager.click(session.sessionId, submit.ref);
  }

  console.log('📸 正在捕获指纹检测结果高清快照...');
  const screenshot = await manager.screenshot(session.sessionId);
  console.log('✅ 演示执行完成！窗口将保持开启 10 秒供您查看...');

  await new Promise((r) => setTimeout(r, 10000));

  await manager.stop(session.sessionId, 'demo_done');
  await manager.shutdown();
  server.close();
  console.log('🎉 演示结束。');
}

void main();
