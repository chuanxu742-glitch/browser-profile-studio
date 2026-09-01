import { SessionManager } from '../src/browser/session-manager.js';
import { UrlPolicy } from '../src/policy/url-policy.js';
import { ChallengePolicy } from '../src/challenge/policy.js';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

async function runScoreBenchmarks() {
  console.log('===============================================================');
  console.log('🧪 启动【BrowserScan & Whoer.net 量化评分专项实测】');
  console.log('===============================================================');

  const artifactsDir = join(process.cwd(), 'artifacts', 'benchmarks');
  await mkdir(artifactsDir, { recursive: true });

  const manager = new SessionManager({
    maxSessions: 1,
    urlPolicy: new UrlPolicy({
      allowedHosts: [
        '*.browserscan.net',
        'browserscan.net',
        '*.whoer.net',
        'whoer.net',
        '127.0.0.1',
      ],
      resourceHosts: [
        '*.browserscan.net',
        'browserscan.net',
        '*.whoer.net',
        'whoer.net',
        '*.cloudflare.com',
        '*.gstatic.com',
        '*.googleapis.com',
        '*.google.com',
        '127.0.0.1',
      ],
      allowHttp: true,
      allowPrivateNetwork: true,
    }),
    challengePolicy: new ChallengePolicy(),
  });

  // 使用与当前出口 IP 吻合的自洽环境
  const session = await manager.start({
    headless: true,
    inputProfile: 'paced',
    fingerprint: true,
    fingerprintSeed: 654321,
    countryCode: 'NL', // 对齐当前欧洲出口 IP 时区环境
  });

  try {
    // 1. 测试 BrowserScan (0~100% 综合伪装度评分)
    console.log('\n🔍 [1/2] 正在访问并评测: BrowserScan (https://www.browserscan.net/)...');
    await manager.open(session.sessionId, 'https://www.browserscan.net/', {
      timeoutMs: 45_000,
      waitUntil: 'domcontentloaded',
    });

    console.log('⏳ 等待 BrowserScan 前端指纹渲染与综合评分计算...');
    await new Promise((r) => setTimeout(r, 8000));

    const scanSnapshot = await manager.snapshot(session.sessionId, { includeText: true });
    const scanScreenshot = await manager.screenshot(session.sessionId, { fullPage: false });
    const scanImgPath = join(artifactsDir, 'browserscan_score.png');
    await writeFile(scanImgPath, Buffer.from(scanScreenshot.image.data, 'base64'));
    console.log(`✅ BrowserScan 测试完成！截屏已保存至: ${scanImgPath}`);
    console.log('📝 BrowserScan 页面摘要:', scanSnapshot.text ? scanSnapshot.text.slice(0, 400).replace(/\s+/g, ' ') : 'Loaded');

    // 2. 测试 Whoer.net (0~100% 匿名度评分)
    console.log('\n🔍 [2/2] 正在访问并评测: Whoer.net (https://whoer.net/)...');
    await manager.open(session.sessionId, 'https://whoer.net/', {
      timeoutMs: 45_000,
      waitUntil: 'domcontentloaded',
    });

    console.log('⏳ 等待 Whoer.net 匿名度与 DNS 泄漏检测计算...');
    await new Promise((r) => setTimeout(r, 6000));

    const whoerSnapshot = await manager.snapshot(session.sessionId, { includeText: true });
    const whoerScreenshot = await manager.screenshot(session.sessionId, { fullPage: false });
    const whoerImgPath = join(artifactsDir, 'whoer_score.png');
    await writeFile(whoerImgPath, Buffer.from(whoerScreenshot.image.data, 'base64'));
    console.log(`✅ Whoer.net 测试完成！截屏已保存至: ${whoerImgPath}`);
    console.log('📝 Whoer.net 页面摘要:', whoerSnapshot.text ? whoerSnapshot.text.slice(0, 400).replace(/\s+/g, ' ') : 'Loaded');

  } catch (err: any) {
    console.error('❌ 测试过程中发生异常:', err?.message || err);
  } finally {
    await manager.stop(session.sessionId, 'score_benchmarks_finished');
    await manager.shutdown();
  }
}

void runScoreBenchmarks();
