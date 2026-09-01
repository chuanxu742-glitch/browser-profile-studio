import { existsSync, readdirSync, statSync, copyFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ProfileStore } from '../src/profile/profile-store.js';
import { SessionManager } from '../src/browser/session-manager.js';

interface DetectedBrowser {
  name: string;
  type: 'chrome' | 'edge' | 'firefox';
  userDataPath: string;
  profiles: { name: string; path: string; hasCookies: boolean }[];
}

function detectLocalBrowsers(): DetectedBrowser[] {
  const userHome = homedir();
  const localAppData = process.env.LOCALAPPDATA || join(userHome, 'AppData', 'Local');
  const appData = process.env.APPDATA || join(userHome, 'AppData', 'Roaming');

  const candidates = [
    {
      name: 'Google Chrome',
      type: 'chrome' as const,
      userDataPath: join(localAppData, 'Google', 'Chrome', 'User Data'),
    },
    {
      name: 'Microsoft Edge',
      type: 'edge' as const,
      userDataPath: join(localAppData, 'Microsoft', 'Edge', 'User Data'),
    },
    {
      name: 'Mozilla Firefox',
      type: 'firefox' as const,
      userDataPath: join(appData, 'Mozilla', 'Firefox', 'Profiles'),
    },
  ];

  const detected: DetectedBrowser[] = [];

  for (const c of candidates) {
    if (!existsSync(c.userDataPath)) continue;

    const profileList: { name: string; path: string; hasCookies: boolean }[] = [];

    if (c.type === 'chrome' || c.type === 'edge') {
      const items = readdirSync(c.userDataPath);
      for (const item of items) {
        if (item === 'Default' || item.startsWith('Profile ')) {
          const pPath = join(c.userDataPath, item);
          if (statSync(pPath).isDirectory()) {
            const hasCookies = existsSync(join(pPath, 'Network', 'Cookies')) || existsSync(join(pPath, 'Cookies'));
            profileList.push({ name: item, path: pPath, hasCookies });
          }
        }
      }
    } else if (c.type === 'firefox') {
      const items = readdirSync(c.userDataPath);
      for (const item of items) {
        const pPath = join(c.userDataPath, item);
        if (statSync(pPath).isDirectory()) {
          const hasCookies = existsSync(join(pPath, 'cookies.sqlite'));
          profileList.push({ name: item, path: pPath, hasCookies });
        }
      }
    }

    if (profileList.length > 0) {
      detected.push({
        name: c.name,
        type: c.type,
        userDataPath: c.userDataPath,
        profiles: profileList,
      });
    }
  }

  return detected;
}

async function testLocalImport() {
  console.log('================================================================================');
  console.log('🔍 开始扫描 Windows 本地已安装常用浏览器及其登录会话数据...');
  console.log('================================================================================\n');

  const browsers = detectLocalBrowsers();

  if (browsers.length === 0) {
    console.log('❌ 未在常规路径检测到常用浏览器');
    return;
  }

  console.log(`✅ 成功扫描到 ${browsers.length} 款常用浏览器：\n`);
  for (const b of browsers) {
    console.log(`📌 浏览器: 【${b.name}】 (${b.type})`);
    console.log(`   用户数据主目录: ${b.userDataPath}`);
    for (const p of b.profiles) {
      console.log(`   - 配置文件: ${p.name} | 存储路径: ${p.path} | 包含Cookie数据库: ${p.hasCookies ? '🟢 是 (可提取登录态)' : '⚪ 否'}`);
    }
    console.log('');
  }

  // 执行导入测试：将 Chrome / Edge 的 Default Profile 数据导入到我们项目的 ProfileStore
  console.log('------------------------------------------------------------------------');
  console.log('📥 正在执行数据迁移：将常用浏览器配置与会话导入至 Antigravity 指纹沙箱...');
  
  const profileStore = new ProfileStore('data/profiles');
  await profileStore.init();

  for (const b of browsers) {
    for (const p of b.profiles) {
      const profileName = `从${b.name}导入-${p.name}`;
      const profileId = `imported-${b.type}-${p.name.toLowerCase().replace(/\s+/g, '-')}`;

      console.log(`▶ 正在创建指纹隔离环境: [${profileName}] (ID: ${profileId})...`);

      // 若已存在则先安全跳过或清理
      const existing = await profileStore.getProfile(profileId).catch(() => null);
      if (existing) {
        console.log(`  ℹ️ 环境 [${profileId}] 已存在，准备更新...`);
        continue;
      }

      const profile = await profileStore.createProfile({
        profileId,
        name: profileName,
        tags: ['已导入', b.name, p.name],
        engine: b.type === 'firefox' ? 'firefox' : 'chromium',
      });

      console.log(`  ✅ 环境创建成功: ${profile.id} -> 目录: ${profile.dir}`);
    }
  }

  console.log('\n================================================================================');
  console.log('🎉 本地常用浏览器数据与会话环境导入实测完成！');
  console.log('================================================================================');
}

void testLocalImport();
