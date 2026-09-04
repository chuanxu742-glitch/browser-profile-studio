import { resolve } from 'node:path';

const candidateEndpoints = [
  process.env.CONTROL_PLANE_URL,
  'http://127.0.0.1:8081',
  'http://127.0.0.1:3000',
].filter(Boolean) as string[];

const token = process.env.CONTROL_PLANE_TOKEN?.trim() || process.env.STUDIO_ACCESS_TOKEN?.trim();
const headers: Record<string, string> = { 'content-type': 'application/json' };
if (token) headers.authorization = `Bearer ${token}`;

async function probeService(): Promise<{ endpoint: string; isStudio: boolean }> {
  for (const ep of candidateEndpoints) {
    const clean = ep.replace(/\/$/, '');
    try {
      const ping = await fetch(`${clean}/ping`, { signal: AbortSignal.timeout(1000) });
      if (ping.ok) {
        const json = await ping.json().catch(() => ({})) as any;
        return { endpoint: clean, isStudio: json?.data?.service === 'antigravity-studio-bridge' };
      }
    } catch {
      // probe next
    }
  }
  throw new Error('未检测到运行中的控制面 (8081) 或 Studio (3000)。请先启动服务：npm run studio 或 npm run start:control-plane');
}

async function main() {
  console.log('================================================================');
  console.log('🌐【Antigravity Browser Bridge - 宿主浏览器拉取与管理工具】');
  console.log('    参考 OpenCLI 架构：免退出浏览器 · 免解密 DPAPI · 即插即用');
  console.log('================================================================\n');

  const { endpoint, isStudio } = await probeService();
  console.log(`⚡ 已连接本地服务引擎: ${endpoint} (${isStudio ? 'Studio 模式' : '控制面模式'})`);

  const browsersUrl = isStudio ? `${endpoint}/api/v1/bridge/browsers` : `${endpoint}/api/browsers`;
  const res = await fetch(browsersUrl, { headers });
  if (!res.ok) throw new Error(`获取浏览器列表失败：HTTP ${res.status}`);

  const data = await res.json() as any;
  const items = (isStudio ? data?.data?.items : data?.items) || [];
  const bridgeBrowsers = items.filter((b: any) => b.mode === 'bridge');

  if (bridgeBrowsers.length === 0) {
    console.log('\n⚠️ 当前暂无在线的 Bridge 宿主浏览器。');
    console.log('👉 使用方法：');
    console.log('  1. 打开常用 Chrome / Edge 浏览器，访问 chrome://extensions 开启【开发者模式】');
    console.log(`  2. 点击【加载已解压的扩展程序】，选择目录: ${resolve(process.cwd(), 'browser-bridge-extension')}`);
    console.log('  3. 扩展将自动连接本地服务并在此处列出，即可免登录直接接管操作！\n');
    return;
  }

  console.log(`\n✅ 发现 ${bridgeBrowsers.length} 个已连接的宿主浏览器：\n`);

  for (const b of bridgeBrowsers) {
    console.log(`----------------------------------------------------------------`);
    console.log(`🌐 实例名称: ${b.name || b.id}  [ID: ${b.id}]  状态: ${b.state}`);
    if (b.contextId) console.log(`   Profile Context: ${b.contextId}`);
    if (b.bridgeConnectedAt) console.log(`   连接时间: ${new Date(b.bridgeConnectedAt).toLocaleString()}`);
    if (b.activeTab) console.log(`   当前页面: ${b.activeTab.title || b.activeTab.url}`);

    // 拉取该浏览器所有打开的标签页
    const tabsUrl = isStudio
      ? `${endpoint}/api/v1/bridge/browsers/${encodeURIComponent(b.id)}/tabs`
      : `${endpoint}/api/browsers/${encodeURIComponent(b.id)}/tabs`;

    try {
      const tabsRes = await fetch(tabsUrl, { headers });
      if (tabsRes.ok) {
        const tabsJson = await tabsRes.json() as any;
        const tabs = (isStudio ? tabsJson?.data?.tabs : tabsJson?.tabs) || [];
        console.log(`   📋 已打开标签页列表 (${tabs.length} 个)：`);
        for (const t of tabs) {
          const prefix = t.active ? '   👉 [活动]' : '      ';
          console.log(`${prefix} Tab #${t.tabId}: ${t.title || '无标题'} - ${t.url}`);
        }
      }
    } catch (err: any) {
      console.log(`   (拉取标签页提示: ${err.message})`);
    }
  }
  console.log('----------------------------------------------------------------\n');
}

main().catch((err) => {
  console.error('❌ 执行失败:', err.message);
  process.exit(1);
});
