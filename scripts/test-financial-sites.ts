import { SessionManager } from '../src/browser/session-manager.js';
import type { UrlPolicyLike } from '../src/browser/browser-session.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface TargetSite {
  name: string;
  url: string;
  category: string;
  expectedFeature: string;
  sampleQuerySelector?: string;
}

const TARGET_SITES: TargetSite[] = [
  {
    name: '同花顺问财',
    url: 'https://www.iwencai.com/unifiedwap/home/index',
    category: '量化选股/资金流向',
    expectedFeature: '前端JS高度混淆、Hexin-V Cookie加密反爬、动态数据表格',
  },
  {
    name: '巨潮资讯',
    url: 'http://www.cninfo.com.cn/new/index',
    category: '官方公告/财报',
    expectedFeature: '法定信披API、AJAX动态加载、反爬频控',
  },
  {
    name: '迈博汇金',
    url: 'https://www.mybbond.com/',
    category: '券商研报聚合',
    expectedFeature: '研报列表、登录权限校验',
  },
  {
    name: '集思录',
    url: 'https://www.jisilu.cn/data/cbnew/#cb',
    category: 'ETF/转债/套利',
    expectedFeature: '动态表格、高频防爬、部分数据会员权限',
  },
  {
    name: '证券之星',
    url: 'https://www.stockstar.com/',
    category: '估值/财务/龙虎榜',
    expectedFeature: '门户资讯、静态+动态内容、广告弹窗',
  },
  {
    name: '星桥财经课',
    url: 'https://xingqiao-advisor.vercel.app/',
    category: '宏观/资产轮动',
    expectedFeature: 'Vercel/Next.js 单页应用、海外节点网络延迟',
  },
  {
    name: '国家统计局',
    url: 'https://www.stats.gov.cn/sj/zxfb/',
    category: '宏观大周期数据库',
    expectedFeature: '政务WAF/知道创宇/安全狗防护、JS质询/Cookie校验',
  },
  {
    name: '同花顺 iFinD',
    url: 'https://ifind.10jqka.com.cn/',
    category: '资金情绪/两融',
    expectedFeature: 'B端专业系统、强登录拦截、权限墙',
  },
  {
    name: '东方财富股吧',
    url: 'https://guba.eastmoney.com/',
    category: '散户情绪/题材发酵',
    expectedFeature: '高并发高频请求、滑动验证码、反爬IP黑名单',
  },
  {
    name: '萝卜投研',
    url: 'https://robo.datayes.com/',
    category: 'AI投研/机构预测',
    expectedFeature: '通联数据SPA、ECharts图表、登录态保护',
  },
];

interface TestResult {
  name: string;
  url: string;
  finalUrl?: string;
  browserSuccess: boolean;
  pageTitle?: string;
  textSnippet?: string;
  targetsCount?: number;
  challengeDetected: boolean;
  challengeCategory?: string;
  error?: string;
  stabilityRating: '优秀(免登录直通)' | '良好(需登录态注入)' | '需拟人/风控处理' | '访问受限';
  crawlingAdvice: string;
}

// 允许所有公共 HTTP/HTTPS 目标用于测试
const permissivePolicy: UrlPolicyLike = {
  assertAllowed(url: string) {
    if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('about:')) {
      throw new Error(`Protocol not allowed: ${url}`);
    }
    // 拦截私网/内网地址
    if (/localhost|127\.0\.0\.1|192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\./i.test(url)) {
      throw new Error(`Private network blocked: ${url}`);
    }
    return true;
  },
};

async function runBenchmark() {
  console.log('================================================================================');
  console.log('🚀 开始对已获授权的财经站点执行隔离浏览器渲染稳定性评测');
  console.log('================================================================================\n');

  const manager = new SessionManager({
    maxSessions: 1,
    profileRoot: join(tmpdir(), 'fin-benchmark-profiles'),
    artifactsRoot: join(tmpdir(), 'fin-benchmark-artifacts'),
    urlPolicy: permissivePolicy as any,
  });

  console.log('🛡️ 正在拉起全链路指纹伪装环境（Canvas微积分微扰、WebGL硬件参数对齐、WebDriver原型链剥离、真人体感输入调度）...');
  const session = await manager.start({
    headless: true,
    inputProfile: 'paced',
    fingerprint: true,
    fingerprintSeed: 998877,
    countryCode: 'CN',
    locale: 'zh-CN',
    timezone: 'Asia/Shanghai',
  });

  const results: TestResult[] = [];

  for (const site of TARGET_SITES) {
    console.log(`\n------------------------------------------------------------------------`);
    console.log(`▶ [${results.length + 1}/10] 正在测试: 【${site.name}】 -> ${site.url}`);
    console.log(`  业务层级: ${site.category}`);
    console.log(`  反爬特性: ${site.expectedFeature}`);

    let browserSuccess = false;
    let pageTitle: string | undefined;
    let finalUrl: string | undefined;
    let textSnippet: string | undefined;
    let targetsCount = 0;
    let challengeDetected = false;
    let challengeCategory: string | undefined;
    let errorMsg: string | undefined;

    try {
      const nav = await manager.open(session.sessionId, site.url, {
        waitUntil: 'domcontentloaded',
        timeoutMs: 30000,
      });

      pageTitle = nav.title;
      finalUrl = nav.url;

      // 允许动态 AJAX / 前端 SPA 加载 2.5 秒
      await new Promise((r) => setTimeout(r, 2500));

      const snapshot = await manager.snapshot(session.sessionId, {
        includeText: true,
        maxNodes: 80,
      });

      targetsCount = snapshot.targets?.length ?? 0;
      if (snapshot.text) {
        textSnippet = snapshot.text.replace(/\s+/g, ' ').trim().slice(0, 120) + '...';
      }

      const status = await manager.status(session.sessionId);
      challengeDetected = status.challenge?.detected ?? false;
      if (challengeDetected) {
        challengeCategory = status.challenge?.category;
      }

      browserSuccess = !challengeDetected && (Boolean(pageTitle) || targetsCount > 0);
      console.log(`  ✅ 加载完成 | 最终URL: ${finalUrl || site.url}`);
      console.log(`  📄 页面标题: "${pageTitle || '无标题'}"`);
      console.log(`  🎯 提取到语义交互节点数: ${targetsCount}`);
      console.log(`  📝 内容摘要: ${textSnippet || '无纯文本'}`);
      console.log(`  🛡️ 反爬/验证码状态: ${challengeDetected ? `⚠️ 触发挑战 (${challengeCategory})` : '🟢 未触发挑战 (指纹顺利通过)'}`);

    } catch (err: any) {
      errorMsg = err?.message || String(err);
      console.log(`  ❌ 发生异常: ${errorMsg}`);
    }

    // 评级与建议
    let stabilityRating: TestResult['stabilityRating'] = '优秀(免登录直通)';
    let crawlingAdvice = '';

    if (errorMsg) {
      if (errorMsg.includes('PAUSED_CHALLENGE') || errorMsg.includes('Challenge')) {
        stabilityRating = '需拟人/风控处理';
        crawlingAdvice = '目标站点启用了高强风控或验证码，建议开启真人动力学轨迹+人工接管（Handoff）或切换独立代理。';
      } else if (errorMsg.includes('TIMEOUT')) {
        stabilityRating = '访问受限';
        crawlingAdvice = '页面响应超时，可能存在海外网络延迟或政务防火墙拦截，需配置高速代理或延长超时阈值。';
      } else {
        stabilityRating = '访问受限';
        crawlingAdvice = `加载失败: ${errorMsg}`;
      }
    } else if (challengeDetected) {
      stabilityRating = '需拟人/风控处理';
      crawlingAdvice = `检测到 ${challengeCategory || '安全质询'}，建议利用项目的持久化 Profile 保留人工通过后的凭证。`;
    } else if (site.name.includes('iFinD') || site.name.includes('萝卜投研') || site.name.includes('星桥')) {
      stabilityRating = '良好(需登录态注入)';
      crawlingAdvice = '页面可以加载，但核心数据受登录鉴权或付费权限保护；只有在账号与数据访问均获授权时才可导入 Cookie 继续测试。';
    } else {
      stabilityRating = '优秀(免登录直通)';
      crawlingAdvice = '本次页面读取成功；单次结果不代表后续稳定性、检测通过率或站点授权，可在许可范围内继续做容量测试。';
    }

    results.push({
      name: site.name,
      url: site.url,
      finalUrl,
      browserSuccess,
      pageTitle,
      textSnippet,
      targetsCount,
      challengeDetected,
      challengeCategory,
      error: errorMsg,
      stabilityRating,
      crawlingAdvice,
    });
  }

  await manager.stop(session.sessionId, 'benchmark_finished');
  await manager.shutdown();

  console.log('\n================================================================================');
  console.log('🏆 10 大财经站点全维度爬取可行性与稳定性评估报告');
  console.log('================================================================================\n');

  console.table(
    results.map((r) => ({
      站点名称: r.name,
      渲染成功: r.browserSuccess ? '✅ 成功' : '❌ 失败',
      页面标题: (r.pageTitle || 'N/A').slice(0, 20),
      节点数: r.targetsCount,
      稳定度评级: r.stabilityRating,
      爬取实施建议: r.crawlingAdvice.slice(0, 35) + '...',
    }))
  );
}

void runBenchmark();
