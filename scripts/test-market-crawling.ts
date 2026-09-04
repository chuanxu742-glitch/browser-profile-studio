import { SessionManager } from '../src/browser/session-manager.js';
import { UrlPolicy } from '../src/policy/url-policy.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface CrawlTestResult {
  category: '电商平台' | '股市财经平台';
  targetName: string;
  targetUrl: string;
  status: 'SUCCESS' | 'CHALLENGE_PAUSED' | 'FAILED';
  pageTitle?: string;
  extractedSample?: any;
  durationMs: number;
  notes: string;
}

async function runMarketCrawlingTests() {
  console.log('================================================================');
  console.log('🛒 📈 启动主流电商平台与股市财经平台自动化爬取与伪装能力测试');
  console.log('================================================================\n');

  // 1. 配置合规的白名单策略
  const allowedHosts = [
    '*.jd.com',
    'jd.com',
    '*.dangdang.com',
    'dangdang.com',
    '*.eastmoney.com',
    'eastmoney.com',
    '*.sina.com.cn',
    'sina.com.cn',
    'finance.sina.com.cn',
    '*.xueqiu.com',
    'xueqiu.com',
    '*.qq.com',
    'qq.com',
    'finance.qq.com',
  ];

  const resourceHosts = [
    ...allowedHosts,
    '*.360buyimg.com',
    '*.dangdang.com',
    '*.eastmoney.com',
    '*.sinaimg.cn',
    '*.gtimg.cn',
  ];

  const urlPolicy = new UrlPolicy({
    allowedHosts,
    resourceHosts,
    allowHttp: true,
    allowSyntheticTunnel: true, // 放行开发机透明代理 198.18.0.0/15 Fake IP 网段
  });

  const manager = new SessionManager({
    maxSessions: 2,
    urlPolicy,
    profileRoot: join(tmpdir(), 'market-crawling-profiles'),
    artifactsRoot: join(tmpdir(), 'market-crawling-artifacts'),
  });

  const results: CrawlTestResult[] = [];

  const targets = [
    {
      category: '股市财经平台' as const,
      name: '东方财富网 - 行情与财经要闻',
      url: 'https://finance.eastmoney.com/',
      engine: 'chromium' as const,
      verifyKeyword: '东方财富',
      timeoutMs: 35000,
    },
    {
      category: '股市财经平台' as const,
      name: '雪球财经 - 热门股票社区与大盘',
      url: 'https://xueqiu.com/',
      engine: 'chromium' as const,
      verifyKeyword: '雪球',
      timeoutMs: 35000,
    },
    {
      category: '股市财经平台' as const,
      name: '新浪财经 - 股票行情市场频道',
      url: 'https://finance.sina.com.cn/stock/',
      engine: 'chromium' as const,
      verifyKeyword: '股票',
      timeoutMs: 35000,
    },
    {
      category: '电商平台' as const,
      name: '京东商城 - 电商门户首页',
      url: 'https://www.jd.com/',
      engine: 'chromium' as const,
      verifyKeyword: '京东',
      timeoutMs: 35000,
    },
    {
      category: '电商平台' as const,
      name: '当当图书 - 图书商城首页',
      url: 'http://book.dangdang.com/',
      engine: 'chromium' as const,
      verifyKeyword: '当当',
      timeoutMs: 35000,
    },
  ];

  for (const target of targets) {
    console.log(`\n▶ [${target.category}] 正在测试爬取目标: ${target.name}`);
    console.log(`   目标地址: ${target.url}`);
    const start = Date.now();
    let session = null;

    try {
      session = await manager.start({
        headless: true,
        engine: target.engine,
        inputProfile: 'paced',
        fingerprint: true,
        fingerprintSeed: 98765 + Math.floor(Math.random() * 10000),
        countryCode: 'CN',
        locale: 'zh-CN',
        timezone: 'Asia/Shanghai',
      });

      console.log(`   ⚙️ 指纹环境已初始化 (Session: ${session.sessionId}, 内核: ${target.engine})`);

      console.log(`   🌐 正在执行伪装导航与页面渲染...`);
      await manager.open(session.sessionId, target.url, { timeoutMs: target.timeoutMs || 35000 });

      const status = manager.status(session.sessionId);
      if (status.state === 'PAUSED_CHALLENGE') {
        console.log(`   ⚠️ 触发站点人机挑战保护，会话已挂起！`);
        results.push({
          category: target.category,
          targetName: target.name,
          targetUrl: target.url,
          status: 'CHALLENGE_PAUSED',
          durationMs: Date.now() - start,
          notes: '检测到挑战，策略安全挂起',
        });
        continue;
      }

      console.log(`   📸 正在提取页面语义快照与业务数据...`);
      const snapshot = await manager.snapshot(session.sessionId, { includeText: true });
      const title = snapshot.title || '（未命名）';
      console.log(`   📄 页面标题: "${title}"`);

      const sampleItems = snapshot.targets
        .filter((t) => t.role === 'link' && t.name && t.name.length > 4)
        .slice(0, 5)
        .map((t) => t.name);

      console.log(`   ✅ 爬取成功！采集到样本内容:`, sampleItems.slice(0, 3));

      results.push({
        category: target.category,
        targetName: target.name,
        targetUrl: target.url,
        status: 'SUCCESS',
        pageTitle: title,
        extractedSample: sampleItems,
        durationMs: Date.now() - start,
        notes: '页面完全渲染，未触发风控，成功提取关键数据',
      });
    } catch (err: any) {
      console.error(`   ❌ 爬取异常: ${err.message}`, err.cause?.message || err.cause || err.details || '');
      results.push({
        category: target.category,
        targetName: target.name,
        targetUrl: target.url,
        status: 'FAILED',
        durationMs: Date.now() - start,
        notes: `爬取失败: ${err.message} (${err.cause?.message || ''})`,
      });
    } finally {
      if (session) {
        await manager.stop(session.sessionId, 'test_completed').catch(() => undefined);
      }
    }
  }

  console.log('\n================================================================');
  console.log('📊 主流电商与股市平台爬取测试汇总报告');
  console.log('================================================================');
  console.table(
    results.map((r) => ({
      分类: r.category,
      目标平台: r.targetName,
      结果状态: r.status,
      耗时: `${r.durationMs}ms`,
      页面标题: (r.pageTitle || '').slice(0, 20),
      备注说明: r.notes,
    }))
  );
}

runMarketCrawlingTests().catch((e) => {
  console.error('Fatal test error:', e);
  process.exit(1);
});
