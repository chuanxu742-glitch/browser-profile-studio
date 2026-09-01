import { SessionManager } from '../src/browser/session-manager.js';
import { UrlPolicy } from '../src/policy/url-policy.js';
import { ChallengePolicy } from '../src/challenge/policy.js';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

async function testAmIUnique() {
  console.log('====================================================');
  console.log('🧪 专项测试：AmIUnique (https://amiunique.org/)');
  console.log('====================================================');

  const artifactsDir = join(process.cwd(), 'artifacts', 'benchmarks');
  await mkdir(artifactsDir, { recursive: true });

  const manager = new SessionManager({
    maxSessions: 1,
    urlPolicy: new UrlPolicy({
      allowedHosts: ['*.amiunique.org', 'amiunique.org', '127.0.0.1'],
      resourceHosts: ['*.amiunique.org', 'amiunique.org', '*.cloudflare.com', '*.gstatic.com', '*.googleapis.com', '127.0.0.1'],
      allowHttp: true,
      allowPrivateNetwork: true,
    }),
    challengePolicy: new ChallengePolicy(),
  });

  const session = await manager.start({
    headless: true,
    inputProfile: 'paced',
    fingerprint: true,
    fingerprintSeed: 123456,
    countryCode: 'US',
  });

  try {
    console.log('🌐 正在连接并导航至 AmIUnique 主页 (超时放宽至 45s)...');
    await manager.open(session.sessionId, 'https://amiunique.org/', { timeoutMs: 45_000 });

    console.log('📸 捕获主页快照...');
    const snapshot = await manager.snapshot(session.sessionId, { includeText: true });
    console.log('📝 页面内容摘要:', snapshot.text ? snapshot.text.slice(0, 300).replace(/\s+/g, ' ') : 'Loaded');

    const screenshot = await manager.screenshot(session.sessionId, { fullPage: false });
    const imgPath = join(artifactsDir, 'amiunique.png');
    await writeFile(imgPath, Buffer.from(screenshot.image.data, 'base64'));
    console.log(`✅ AmIUnique 测试成功！截屏已保存至: ${imgPath}`);
  } catch (err: any) {
    console.error('❌ AmIUnique 测试失败:', err?.message || err);
  } finally {
    await manager.stop(session.sessionId, 'amiunique_done');
    await manager.shutdown();
  }
}

void testAmIUnique();
