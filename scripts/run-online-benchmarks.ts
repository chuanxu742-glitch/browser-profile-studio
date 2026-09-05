import { SessionManager } from '../src/browser/session-manager.js';
import { UrlPolicy } from '../src/policy/url-policy.js';
import { ChallengePolicy } from '../src/challenge/policy.js';
import { runBenchmarkSuite, type BenchmarkSite } from './benchmark-results.js';

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
    url: 'https://amiunique.org/fingerprint',
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
  console.log('公开测试靶场巡检：加载页面不等于检测通过');
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
        'localhost',
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
        '*.cdnjs.cloudflare.com',
        'cdnjs.cloudflare.com',
        '*.jsdelivr.net',
        'cdn.jsdelivr.net',
        '*.unpkg.com',
        'unpkg.com',
        '*.gstatic.com',
        'fonts.gstatic.com',
        '*.googleapis.com',
        'fonts.googleapis.com',
        '*.google.com',
        '*.googletagmanager.com',
        '*.google-analytics.com',
        '*.githubusercontent.com',
        'raw.githubusercontent.com',
        '*.bootstrapcdn.com',
        '*.fontawesome.com',
        '*.jquery.com',
        'code.jquery.com',
        '127.0.0.1',
        'localhost',
      ],
      allowHttp: true,
      allowPrivateNetwork: true,
      allowSyntheticTunnel: true,
    }),
    challengePolicy: new ChallengePolicy(),
  });

  await runBenchmarkSuite(manager, BENCHMARK_SITES, 'online', 987654);
}

runBenchmarks().catch((err) => {
  console.error('Fatal error during benchmark run:', err);
  process.exitCode = 1;
});
