import { SessionManager } from '../src/browser/session-manager.js';
import { UrlPolicy } from '../src/policy/url-policy.js';
import { ChallengePolicy } from '../src/challenge/policy.js';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

interface BenchmarkSite {
  readonly name: string;
  readonly url: string;
  readonly category: string;
  readonly focus: string;
}

const BENCHMARK_SITES: readonly BenchmarkSite[] = [
  {
    name: 'SannySoft Bot Test',
    url: 'https://bot.sannysoft.com/',
    category: '⭐⭐⭐ 基础自动化特征检测',
    focus: 'WebDriver, Chrome Runtime, Permissions, Plugins',
  },
  {
    name: 'BrowserLeaks Canvas',
    url: 'https://browserleaks.com/canvas',
    category: '⭐⭐⭐⭐⭐ 硬件与底层渲染',
    focus: 'Canvas 2D 噪点签名, 图像哈希唯一性',
  },
  {
    name: 'BrowserLeaks WebRTC',
    url: 'https://browserleaks.com/webrtc',
    category: '⭐⭐⭐⭐⭐ 网络与 IP 防泄露',
    focus: 'WebRTC 本地 IP / 局域网 IP / mDNS 泄露防护',
  },
  {
    name: 'BrowserLeaks WebGL',
    url: 'https://browserleaks.com/webgl',
    category: '⭐⭐⭐⭐⭐ GPU 与驱动伪造',
    focus: 'UNMASKED_VENDOR / UNMASKED_RENDERER 显卡型号',
  },
  {
    name: 'CreepJS 原版',
    url: 'https://abrahamjuliot.github.io/creepjs/',
    category: '⭐⭐⭐⭐⭐ 深度原型链与指纹分析',
    focus: 'Lies 欺骗探测, Worker/Iframe 一致性, WebAudio',
  },
  {
    name: 'Pixelscan',
    url: 'https://pixelscan.net/',
    category: '⭐⭐⭐⭐ 真实设备画像一致性',
    focus: '自动化标记, 硬件与时区/语言综合自洽性',
  },
  {
    name: 'IPhey',
    url: 'https://iphey.com/',
    category: '⭐⭐⭐⭐ 多账号风控信誉度',
    focus: 'Browser / Location / Hardware 综合绿灯判定',
  },
  {
    name: 'EFF Cover Your Tracks',
    url: 'https://coveryourtracks.eff.org/',
    category: '⭐⭐⭐ 抗追踪与独特性',
    focus: '指纹信息熵、追踪器阻断',
  },
  {
    name: 'AmIUnique',
    url: 'https://amiunique.org/',
    category: '⭐⭐⭐ 样本库指纹分布',
    focus: '浏览器样本库对比、Canvas/Audio 特征',
  },
  {
    name: 'BrowserScan',
    url: 'https://www.browserscan.net/',
    category: '⭐⭐⭐⭐⭐ 指纹综合伪装打分',
    focus: '0~100% 综合伪装度评分、WebGPU、字体与硬件自洽度',
  },
  {
    name: 'DeviceInfo',
    url: 'https://www.deviceinfo.me/',
    category: '⭐⭐⭐⭐⭐ 硬件画像全景枚举',
    focus: '全景硬件枚举、CSS/Math 精度、媒体设备',
  },
];

async function runBenchmarks() {
  console.log('===============================================================');
  console.log('🧪 启动【公开测试靶场全量在线巡检】');
  console.log('===============================================================');

  const artifactsDir = join(process.cwd(), 'artifacts', 'benchmarks');
  await mkdir(artifactsDir, { recursive: true });

  const manager = new SessionManager({
    maxSessions: 2,
    urlPolicy: new UrlPolicy({
      allowedHosts: [
        '*.sannysoft.com',
        'bot.sannysoft.com',
        '*.browserleaks.com',
        'browserleaks.com',
        '*.github.io',
        'abrahamjuliot.github.io',
        '*.pixelscan.net',
        'pixelscan.net',
        '*.iphey.com',
        'iphey.com',
        '*.fingerprint.com',
        'fingerprint.com',
        '*.eff.org',
        'coveryourtracks.eff.org',
        '*.amiunique.org',
        'amiunique.org',
        '*.browserscan.net',
        'browserscan.net',
        '*.deviceinfo.me',
        'deviceinfo.me',
        '127.0.0.1',
      ],
      resourceHosts: [
        '*.sannysoft.com',
        'bot.sannysoft.com',
        '*.browserleaks.com',
        'browserleaks.com',
        '*.github.io',
        'abrahamjuliot.github.io',
        '*.pixelscan.net',
        'pixelscan.net',
        '*.iphey.com',
        'iphey.com',
        '*.fingerprint.com',
        'fingerprint.com',
        '*.eff.org',
        'coveryourtracks.eff.org',
        '*.amiunique.org',
        'amiunique.org',
        '*.browserscan.net',
        'browserscan.net',
        '*.deviceinfo.me',
        'deviceinfo.me',
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

  console.log('🚀 正在启动带有指纹伪装和拟人交互环境的浏览器会话...');
  const session = await manager.start({
    headless: true,
    inputProfile: 'paced',
    fingerprint: true,
    fingerprintSeed: 987654,
    countryCode: 'US',
  });

  const results: Array<{
    name: string;
    url: string;
    category: string;
    focus: string;
    status: 'SUCCESS' | 'TIMEOUT' | 'NETWORK_ERROR';
    details: string;
    screenshotPath?: string;
  }> = [];

  for (const site of BENCHMARK_SITES) {
    console.log(`\n🔍 [${site.category}] 正在测试: ${site.name} (${site.url})...`);
    try {
      // 访问测试站点
      await manager.open(session.sessionId, site.url, { timeoutMs: 45_000, waitUntil: 'domcontentloaded' });

      // 提取页面快照文本
      const snapshot = await manager.snapshot(session.sessionId, { includeText: true, maxChars: 3000 });
      
      // 截取页面屏幕证据
      const screenshot = await manager.screenshot(session.sessionId, { fullPage: false });
      const imgFileName = `${site.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}.png`;
      const imgFilePath = join(artifactsDir, imgFileName);
      await writeFile(imgFilePath, Buffer.from(screenshot.image.data, 'base64'));

      // 简单提取页面核心文本特征
      const snippet = snapshot.text
        ? snapshot.text.slice(0, 300).replace(/\s+/g, ' ').trim()
        : 'Page loaded successfully';

      console.log(`   ✅ 页面加载并检测成功! 截图已保存至: artifacts/benchmarks/${imgFileName}`);
      console.log(`   📝 页面内容摘要: ${snippet}`);

      results.push({
        name: site.name,
        url: site.url,
        category: site.category,
        focus: site.focus,
        status: 'SUCCESS',
        details: snippet,
        screenshotPath: imgFilePath,
      });
    } catch (error: any) {
      const msg = error?.message || String(error);
      console.log(`   ⚠️ 测试访问跳过/网络超时: ${msg}`);
      results.push({
        name: site.name,
        url: site.url,
        category: site.category,
        focus: site.focus,
        status: msg.includes('timeout') ? 'TIMEOUT' : 'NETWORK_ERROR',
        details: `网络连接受限: ${msg}`,
      });
    }
  }

  await manager.stop(session.sessionId, 'benchmark_finished');
  await manager.shutdown();

  // 输出巡检汇总表格
  console.log('\n===============================================================');
  console.log('📋 【公开测试靶场全量在线巡检结果汇总】');
  console.log('===============================================================');
  console.table(
    results.map((r) => ({
      靶场名称: r.name,
      评级与分类: r.category.slice(0, 10),
      核心检测重点: r.focus,
      测试状态: r.status,
    }))
  );

  return results;
}

runBenchmarks().catch((err) => {
  console.error('Fatal error during benchmark run:', err);
  process.exitCode = 1;
});
