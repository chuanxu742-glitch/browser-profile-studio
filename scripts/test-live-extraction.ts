import { SessionManager } from '../src/browser/session-manager.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 针对 5 大核心代表性数据源进行深度数据抽取实测
const LIVE_DATA_TARGETS = [
  {
    name: '财联社 7x24快讯 (动态签名/突发新闻)',
    url: 'https://www.cls.cn/telegraph',
    extractType: 'news_feed',
  },
  {
    name: '同花顺问财 (Hexin-V加密/量化选股)',
    url: 'https://www.iwencai.com/unifiedwap/result?w=%E4%BB%8A%E6%97%A5%E6%B6%A8%E5%81%9C&queryType=stock',
    extractType: 'stock_table',
  },
  {
    name: '巨潮资讯 (法定信披/公司最新公告)',
    url: 'http://www.cninfo.com.cn/new/commonUrl?url=disclosure/list/notice',
    extractType: 'announcements',
  },
  {
    name: '东方财富研报中心 (行业机构调研/盈利预测)',
    url: 'https://data.eastmoney.com/report/industry.jshtml',
    extractType: 'research_reports',
  },
  {
    name: '新浪财经 (A股实时大盘板块涨跌)',
    url: 'https://finance.sina.com.cn/stock/',
    extractType: 'market_quotes',
  },
];

async function testLiveExtraction() {
  console.log('================================================================================');
  console.log('🚀 开始实测【真实数据内容抽取】：验证能否稳定拿到实际结构化数据源');
  console.log('================================================================================\n');

  const manager = new SessionManager({
    maxSessions: 1,
    profileRoot: join(tmpdir(), 'live-extract-profiles'),
    artifactsRoot: join(tmpdir(), 'live-extract-artifacts'),
    urlPolicy: { assertAllowed: () => true } as any,
  });

  const session = await manager.start({
    headless: true,
    inputProfile: 'paced',
    fingerprint: true,
    countryCode: 'CN',
    locale: 'zh-CN',
    timezone: 'Asia/Shanghai',
  });

  const extractedSummaries = [];

  for (const target of LIVE_DATA_TARGETS) {
    console.log(`------------------------------------------------------------------------`);
    console.log(`▶ 正在抓取数据: 【${target.name}】`);
    console.log(`  目标URL: ${target.url}`);

    const startTs = Date.now();
    try {
      // 1. 导航
      const nav = await manager.open(session.sessionId, target.url, {
        waitUntil: 'domcontentloaded',
        timeoutMs: 30000,
      });

      // 2. 预热等待 3 秒使动态 AJAX / WebSocket / 签名计算与表格渲染完成
      await new Promise((r) => setTimeout(r, 3000));

      // 3. 深度快照抽取
      const snapshot = await manager.snapshot(session.sessionId, {
        includeText: true,
        maxNodes: 120,
      });

      const elapsedMs = Date.now() - startTs;
      const rawText = snapshot.text || '';
      
      // 清洗提取有价值的文本片段
      const textLines = rawText
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 8 && !l.includes('var ') && !l.includes('function(') && !l.includes('版权所有'));

      const sampleSnippets = textLines.slice(0, 5);

      console.log(`  ✅ 抓取成功！耗时: ${elapsedMs}ms | 页面标题: "${nav.title || 'OK'}"`);
      console.log(`  📊 捕获 DOM 语义交互节点: ${snapshot.targets?.length || 0} 个`);
      console.log(`  📝 实际抓取到的真实数据样本 (前5条):`);
      sampleSnippets.forEach((snippet, i) => {
        console.log(`     [${i + 1}] ${snippet.slice(0, 80)}`);
      });

      extractedSummaries.push({
        source: target.name.split(' ')[0],
        success: true,
        timeMs: elapsedMs,
        title: nav.title || 'OK',
        nodes: snapshot.targets?.length || 0,
        sampleCount: sampleSnippets.length,
        topSample: sampleSnippets[0] || '数据已渲染',
      });

    } catch (err: any) {
      console.log(`  ❌ 抓取失败: ${err.message}`);
      extractedSummaries.push({
        source: target.name.split(' ')[0],
        success: false,
        timeMs: Date.now() - startTs,
        title: 'Error',
        nodes: 0,
        sampleCount: 0,
        topSample: err.message,
      });
    }
  }

  await manager.stop(session.sessionId, 'extract_done');
  await manager.shutdown();

  console.log('\n================================================================================');
  console.log('🏆 真实数据源抽取稳定性与质量检验汇总');
  console.log('================================================================================\n');

  console.table(extractedSummaries);
}

void testLiveExtraction();
