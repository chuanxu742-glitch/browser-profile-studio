import { SessionManager } from '../src/browser/session-manager.js';
import { ProfileStore } from '../src/profile/index.js';
import { join } from 'node:path';

async function testVisualWindow() {
  console.log('================================================================');
  console.log('🚀 正在在桌面拉起【真实独立的指纹浏览器多开窗口】...');
  console.log('================================================================\n');

  const profileStore = new ProfileStore('data/profiles');
  await profileStore.init();

  const manager = new SessionManager({
    maxSessions: 8,
    profileRoot: join(process.cwd(), 'data', 'profiles'),
    artifactsRoot: join(process.cwd(), 'data', 'artifacts'),
    profileStore,
    urlPolicy: { assertAllowed: () => true } as any,
  });

  // 以真实桌面窗口模式启动环境
  const session = await manager.start({
    headless: false, // 桌面真实窗口
    fingerprint: true,
    inputProfile: 'paced',
    countryCode: 'CN',
    locale: 'zh-CN',
    timezone: 'Asia/Shanghai',
  });

  console.log(`✅ 独立指纹浏览器窗口已在桌面成功弹出！(Session ID: ${session.sessionId})`);

  // 打开欢迎与指纹就绪检测页
  const welcomeUrl = `http://127.0.0.1:3000/welcome.html?profileId=test-live-env&name=${encodeURIComponent('实机桌面指纹多开环境-01')}`;
  await manager.open(session.sessionId, welcomeUrl, { waitUntil: 'domcontentloaded', timeoutMs: 15000 }).catch(() => {});

  console.log(`📌 欢迎与指纹检测面板已在弹出的浏览器窗口中展示！`);
  console.log(`💡 提示：该窗口使用独立 Profile；请只登录你有权使用的账号，并遵守目标站点规则。`);
  
  // 保持 15 秒供用户在屏幕上查看
  await new Promise((r) => setTimeout(r, 15000));

  await manager.stop(session.sessionId, 'test_done');
  await manager.shutdown();
  console.log('🏁 测试完成，已安全关闭该测试窗口。');
}

void testVisualWindow();
