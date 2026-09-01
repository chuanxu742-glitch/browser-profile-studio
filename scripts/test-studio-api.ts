import { RestApiServer } from '../src/api/server.js';
import { SessionManager } from '../src/browser/session-manager.js';
import { ProfileStore } from '../src/profile/index.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function testStudioApi() {
  console.log('🧪 开始对 Browser Studio 控制台及 REST API 进行集成自测...');

  const tmpRoot = join(tmpdir(), 'studio-api-test');
  const profileStore = new ProfileStore(join(tmpRoot, 'profiles'));
  await profileStore.init();

  const manager = new SessionManager({
    maxSessions: 5,
    profileRoot: join(tmpRoot, 'profiles'),
    artifactsRoot: join(tmpRoot, 'artifacts'),
    profileStore,
    urlPolicy: { assertAllowed: () => true } as any,
  });

  const apiServer = new RestApiServer(manager, {
    port: 0, // 随机可用端口
    host: '127.0.0.1',
    publicDir: join(process.cwd(), 'public'),
  });

  const { port, host } = await apiServer.start();
  const baseUrl = `http://${host}:${port}`;
  console.log(`✅ 测试服务器已启动: ${baseUrl}`);

  try {
    // 1. 测试静态页面获取
    const htmlResp = await fetch(`${baseUrl}/`);
    console.log(`[1] GET / -> HTTP ${htmlResp.status} (${htmlResp.headers.get('content-type')})`);
    if (!htmlResp.ok) throw new Error('Failed to serve index.html');

    const cssResp = await fetch(`${baseUrl}/style.css`);
    console.log(`[2] GET /style.css -> HTTP ${cssResp.status}`);

    const jsResp = await fetch(`${baseUrl}/app.js`);
    console.log(`[3] GET /app.js -> HTTP ${jsResp.status}`);

    // 2. 测试创建环境
    const createResp = await fetch(`${baseUrl}/api/v1/profiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '自测环境-问财量化A1',
        engine: 'firefox',
        tags: ['A股', '选股'],
        geo: { countryCode: 'CN', timezone: 'Asia/Shanghai' },
      }),
    });
    const createJson = await createResp.json();
    console.log(`[4] POST /api/v1/profiles ->`, createJson.code, `ProfileId: ${createJson.data?.profileId}`);
    if (!createJson.success) throw new Error('Create profile failed');

    const pid = createJson.data.profileId;

    // 3. 测试获取列表
    const listResp = await fetch(`${baseUrl}/api/v1/profiles`);
    const listJson = await listResp.json();
    console.log(`[5] GET /api/v1/profiles -> 找到 ${listJson.data?.length} 个环境`);

    // 4. 测试 Cookie 注入与读取
    await fetch(`${baseUrl}/api/v1/profiles/${pid}/cookies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cookies: [
          { name: 'hexin-v', value: 'fake_v_token_123456', domain: '.10jqka.com.cn', path: '/' },
        ],
      }),
    });

    const cookieResp = await fetch(`${baseUrl}/api/v1/profiles/${pid}/cookies?format=json`);
    const cookieJson = await cookieResp.json();
    console.log(`[6] GET /api/v1/profiles/${pid}/cookies -> Cookie数量: ${cookieJson.data?.length}`);

    console.log('\n🎉 本次控制台前端与 API 路由自测通过；仍需结合目标环境做持续稳定性验证。');
  } finally {
    await apiServer.stop();
    await manager.shutdown();
  }
}

void testStudioApi();
