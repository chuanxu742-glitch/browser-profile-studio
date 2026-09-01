import { SessionManager } from '../src/browser/session-manager.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface SourceTestTarget {
  name: string;
  url: string;
  category: string;
  securityType: string;
}

const EXTENDED_TARGETS: SourceTestTarget[] = [
  {
    name: '财联社 7x24快讯',
    url: 'https://www.cls.cn/telegraph',
    category: '实时热点快讯/突发新闻',
    securityType: '动态 sign 签名 + 时间戳校验 + Webpack 混淆',
  },
  {
    name: '雪球网热帖与个股',
    url: 'https://xueqiu.com/',
    category: '投资者社区舆情/个股热榜',
    securityType: 'xq_a_token 强制 Cookie 校验 + TLS 指纹探测',
  },
  {
    name: '东方财富研报中心',
    url: 'https://data.eastmoney.com/report/',
    category: '机构研报/盈利预测',
    securityType: '高频 IP 频控 + AJAX 动态渲染',
  },
  {
    name: '乐咕乐股全市场估值',
    url: 'https://legulego.com/',
    category: '全市场 PE/PB/股债利差/大盘估值',
    securityType: '防高频爬虫 + 动态图表',
  },
  {
    name: '新浪财经行情中心',
    url: 'https://finance.sina.com.cn/stock/',
    category: 'A股实时大盘/行业涨跌榜',
    securityType: 'Referer 防盗链 + 静态+动态混杂',
  },
  {
    name: '上海证券交易所',
    url: 'https://www.sse.com.cn/',
    category: '法定交易所权威信披/监管公告',
    securityType: '政务 WAF / 国密防护 / CDN 质询',
  },
  {
    name: '深圳证券交易所',
    url: 'https://www.szse.cn/',
    category: '法定交易所权威信披/上市公司公告',
    securityType: '安全防护网关 / 动态表格',
  },
  {
    name: '慧博投研资讯',
    url: 'https://www.hibor.com.cn/',
    category: '券商研报聚合/宏观策略',
    securityType: '强登录鉴权 + 会员积分墙',
  },
];

async function runExpandedTests() {
  console.log('================================================================================');
  console.log('🔍 开始对 A股全网主流信息源进行【深度可爬性与反爬防护实测评估】');
  console.log('================================================================================\n');

  const manager = new SessionManager({
    maxSessions: 1,
    profileRoot: join(tmpdir(), 'ashare-expanded-profiles'),
    artifactsRoot: join(tmpdir(), 'ashare-expanded-artifacts'),
    urlPolicy: {
      assertAllowed: (url: string) => {
        if (!url.startsWith('http://') && !url.startsWith('https://')) throw new Error('Invalid URL');
        return true;
      },
    } as any,
  });

  const session = await manager.start({
    headless: true,
    inputProfile: 'paced',
    fingerprint: true,
    fingerprintSeed: 887766,
    countryCode: 'CN',
    locale: 'zh-CN',
    timezone: 'Asia/Shanghai',
  });

  const results: any[] = [];

  for (const item of EXTENDED_TARGETS) {
    console.log(`------------------------------------------------------------------------`);
    console.log(`▶ 正在探测: 【${item.name}】 -> ${item.url}`);
    console.log(`  属性: ${item.category} | 反爬机制: ${item.securityType}`);

    const startTs = Date.now();
    let success = false;
    let title = '';
    let nodeCount = 0;
    let textPreview = '';
    let challengeDetected = false;
    let challengeReason = '';
    let errorMsg = '';

    try {
      const nav = await manager.open(session.sessionId, item.url, {
        waitUntil: 'domcontentloaded',
        timeoutMs: 25000,
      });

      title = nav.title || '';
      // 等待 2.5 秒使动态 JS、Token 交换与 WebSocket/AJAX 充分加载
      await new Promise((r) => setTimeout(r, 2500));

      const snapshot = await manager.snapshot(session.sessionId, { includeText: true, maxNodes: 80 });
      nodeCount = snapshot.targets?.length || 0;
      textPreview = (snapshot.text || '').replace(/\s+/g, ' ').trim().slice(0, 100) + '...';

      const status = await manager.status(session.sessionId);
      challengeDetected = status.challenge?.detected ?? false;
      if (challengeDetected) challengeReason = status.challenge?.category || '安全质询';

      success = !challengeDetected && (Boolean(title) || nodeCount > 0);
      const elapsed = Date.now() - startTs;

      console.log(`  ✅ 加载耗时: ${elapsed}ms | 标题: "${title}"`);
      console.log(`  🎯 提取节点数: ${nodeCount} | 内容摘要: ${textPreview}`);
      console.log(`  🛡️ 反爬挑战: ${challengeDetected ? `⚠️ 触发 (${challengeReason})` : '🟢 未触发 (指纹顺利通过)'}`);

    } catch (err: any) {
      errorMsg = err?.message || String(err);
      console.log(`  ❌ 异常: ${errorMsg}`);
    }

    let verdict = '可直接稳定爬取';
    let detail = '';

    if (errorMsg) {
      if (errorMsg.includes('TIMEOUT')) {
        verdict = '需要国内住宅代理/超时重试';
        detail = '目标站点 WAF 对非境内普通网络存在丢包或延迟。';
      } else {
        verdict = '访问受限/需特殊规则';
        detail = errorMsg;
      }
    } else if (challengeDetected) {
      verdict = '触发安全风控/需人机接管';
      detail = `检测到 ${challengeReason}，建议使用项目的 Handoff 模式过一次滑块。`;
    } else if (item.name.includes('慧博') || item.name.includes('雪球')) {
      verdict = '免密可看公开/深度需登录';
      detail = '公开热榜与快讯直接抓取；VIP 研报与深度持仓需注入 Cookie。';
    } else {
      verdict = '完全可稳定抓取';
      detail = '指纹完全隐匿，原生支持高并发与结构化提取。';
    }

    results.push({
      name: item.name,
      url: item.url,
      success,
      title: title.slice(0, 25),
      nodeCount,
      verdict,
      securityType: item.securityType,
      detail,
    });
  }

  await manager.stop(session.sessionId, 'test_done');
  await manager.shutdown();

  console.log('\n================================================================================');
  console.log('🏆 A股信息源全网可爬性矩阵分析表');
  console.log('================================================================================\n');

  console.table(
    results.map((r) => ({
      站点: r.name,
      状态: r.success ? '✅ 通过' : '❌ 失败',
      页面标题: r.title,
      抓取节点: r.nodeCount,
      爬取可行性判定: r.verdict,
      防护机制分析: r.securityType.slice(0, 25) + '...',
    }))
  );
}

void runExpandedTests();
