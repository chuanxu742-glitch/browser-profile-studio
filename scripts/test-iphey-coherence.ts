import { SessionManager } from '../src/browser/session-manager.js';
import { UrlPolicy } from '../src/policy/url-policy.js';
import { ChallengePolicy } from '../src/challenge/policy.js';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

async function testIpheyCoherence() {
  console.log('====================================================');
  console.log('🧪 IPhey 满分自洽性专项评测 (IP + 时区 + 原生引擎对齐)');
  console.log('====================================================');

  const artifactsDir = join(process.cwd(), 'artifacts', 'benchmarks');
  await mkdir(artifactsDir, { recursive: true });

  const manager = new SessionManager({
    maxSessions: 1,
    urlPolicy: new UrlPolicy({
      allowedHosts: ['*.iphey.com', 'iphey.com', '127.0.0.1'],
      resourceHosts: ['*.iphey.com', 'iphey.com', '*.cloudflare.com', '*.gstatic.com', '*.googleapis.com', '127.0.0.1'],
      allowHttp: true,
      allowPrivateNetwork: true,
    }),
    challengePolicy: new ChallengePolicy(),
  });

  // 根据当前出口 IP 93.179.101.229 自动对齐至欧洲时区 (NL: Europe/Amsterdam)
  console.log('🌐 启动指纹会话（时区与出口 IP 严格对齐: Europe/Amsterdam）...');
  const session = await manager.start({
    headless: true,
    inputProfile: 'paced',
    fingerprint: true,
    fingerprintSeed: 888123,
    countryCode: 'NL', // 对齐当前 IP 归属地
  });

  try {
    console.log('🚀 正在导航至 IPhey (https://iphey.com/)...');
    await manager.open(session.sessionId, 'https://iphey.com/', { timeoutMs: 45_000, waitUntil: 'domcontentloaded' });

    // 等待 IPhey 前端指纹和信誉分计算完成
    console.log('⏳ 等待 IPhey 实时信誉分计算...');
    await new Promise((r) => setTimeout(r, 6000));

    const snapshot = await manager.snapshot(session.sessionId, { includeText: true });
    console.log('📝 IPhey 检测文本:\n', snapshot.text ? snapshot.text.slice(0, 500) : 'Loaded');

    const screenshot = await manager.screenshot(session.sessionId, { fullPage: false });
    const imgPath = join(artifactsDir, 'iphey_coherence_passed.png');
    await writeFile(imgPath, Buffer.from(screenshot.image.data, 'base64'));
    console.log(`✅ IPhey 专项评测完成！截屏已保存至: ${imgPath}`);
  } catch (err: any) {
    console.error('❌ IPhey 测试异常:', err?.message || err);
  } finally {
    await manager.stop(session.sessionId, 'iphey_done');
    await manager.shutdown();
  }
}

void testIpheyCoherence();
