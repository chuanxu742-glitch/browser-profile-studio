import { LocalBrowserImporter } from '../src/migration/local-browser-importer.js';
import { ProfileStore } from '../src/profile/profile-store.js';
import { SiteBindingStore } from '../src/profile/site-binding.js';

async function main() {
  console.log('================================================================');
  console.log('🔗 启动【本机日常浏览器登录态平移与站点绑定向导】');
  console.log('================================================================\n');

  const profileStore = new ProfileStore('data/profiles');
  const bindingStore = new SiteBindingStore('data');
  await bindingStore.init();

  const importer = new LocalBrowserImporter(profileStore);
  const browsers = await importer.scan();

  if (browsers.length === 0) {
    console.log('❌ 未在系统默认路径检测到 Chrome、Edge 或 Firefox。');
    return;
  }

  console.log('📋 【已扫描到的本机可用浏览器 Profile】：');
  const candidates: Array<{ sourceId: string; browser: string; profile: string; inUse: boolean }> = [];
  for (const b of browsers) {
    for (const p of b.profiles) {
      candidates.push({
        sourceId: p.sourceId,
        browser: b.name,
        profile: p.name,
        inUse: p.inUse,
      });
    }
  }
  console.table(candidates);

  // 获取用户指定的 sourceId
  const sourceId = process.argv[2];
  const targetSite = process.argv[3] || '*.taobao.com';
  const customProfileName = process.argv[4] || 'taobao_dedicated_profile';

  if (!sourceId) {
    console.log('\n💡 使用说明：');
    console.log('   请完全退出日常浏览器（Chrome/Edge），然后在终端执行如下命令完成一键绑定：');
    console.log('   npx tsx scripts/bind-local-login.ts <sourceId> [站点域名模式] [专有Profile名称]\n');
    console.log('👉 示例（绑定默认 Chrome 至淘宝）：');
    console.log(`   npx tsx scripts/bind-local-login.ts ${candidates[0]?.sourceId || '<sourceId>'} *.taobao.com taobao_main_vip\n`);
    return;
  }

  console.log(`\n🚀 正在从源 Profile [${sourceId}] 平移全量登录态至 [${customProfileName}]...`);
  const result = await importer.importProfile({
    sourceId,
    confirmBrowserClosed: true,
  });

  console.log('🎉 登录凭证平移导入成功！');
  console.log(`   目标 Profile ID: ${result.profile.profileId}`);
  console.log(`   已迁移核心数据文件: ${result.copiedFiles} 个 (大小: ${(result.copiedBytes / 1024 / 1024).toFixed(1)} MB)`);

  console.log(`\n🔗 正在建立站点路由绑定：${targetSite} ➔ ${result.profile.profileId}`);
  const binding = await bindingStore.bind(targetSite, result.profile.profileId, `由本机 ${sourceId.slice(0, 8)} 导入的登录专有态`);
  console.log('✅ 站点专属绑定已生效：');
  console.table([binding]);

  console.log('\n🌟 绑定成功！今后当爬虫访问淘宝时，系统会自动以该真实买家身份运行，杜绝未登录拦截！');
}

main().catch((err) => {
  console.error('❌ 绑定失败:', err.message);
});
