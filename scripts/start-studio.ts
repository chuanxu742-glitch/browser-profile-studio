import { SessionManager } from '../src/browser/session-manager.js';
import { RestApiServer } from '../src/api/server.js';
import { ProfileStore } from '../src/profile/index.js';
import { spawn, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SecretVault } from '../src/security/secret-vault.js';
import { ProxyPoolStore } from '../src/proxy/pool-store.js';
import { RpaService } from '../src/rpa/service.js';
import { AuditLogger } from '../src/audit.js';
import type { StudioCredential, StudioRole } from '../src/api/server.js';
import { TeamAccessStore } from '../src/team/access-store.js';
import { loadOrCreatePlatformSecret } from '../src/security/platform-secret.js';
import { ExternalRuntimeRegistry } from '../src/platform/provider-registry.js';
import { ManagedExtensionStore } from '../src/extension/managed-extension-store.js';

function launchDesktopWindow(targetUrl: string) {
  const possiblePaths = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.LOCALAPPDATA}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ];

  let launcherExe: string | null = null;
  for (const p of possiblePaths) {
    if (p && existsSync(p)) {
      launcherExe = p;
      break;
    }
  }

  if (launcherExe) {
    console.log(`🚀 正在以【独立原生 App 模式】弹出桌面软件窗口...`);
    const appArgs = [
      `--app=${targetUrl}`,
      '--window-size=1366,860',
      '--disable-extensions',
      '--no-first-run',
      '--no-default-browser-check',
    ];
    try {
      const child = spawn(launcherExe, appArgs, { detached: true, stdio: 'ignore' });
      child.unref();
      console.log(`✅ 桌面软件主窗口已成功弹出！(引擎: ${launcherExe})`);
    } catch (e: any) {
      console.warn('窗口弹出警告，降级启动:', e.message);
      try { execSync(`cmd /c start "" "${targetUrl}"`, { stdio: 'ignore' }); } catch (_) {}
    }
  } else {
    try { execSync(`cmd /c start "" "${targetUrl}"`, { stdio: 'ignore' }); } catch (_) {}
  }
}

async function main() {
  console.log('================================================================');
  console.log('👑 启动【Antigravity Browser Studio - 本地隔离浏览器工作台】');
  console.log('================================================================\n');

  const dataDir = join(process.cwd(), 'data');
  const profileDir = join(dataDir, 'profiles');
  const artifactsDir = join(dataDir, 'artifacts');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const masterSecret = process.env.STUDIO_MASTER_KEY || await loadOrCreatePlatformSecret(join(dataDir, '.studio-master-key'));
  const ownerToken = process.env.STUDIO_ACCESS_TOKEN || await loadOrCreatePlatformSecret(join(dataDir, '.studio-access-token'));
  const bootstrapToken = randomBytes(24).toString('base64url');
  const vault = new SecretVault(masterSecret);
  const audit = new AuditLogger(join(dataDir, 'studio-audit.jsonl'));

  const urlPolicy = {
    assertAllowed(url: string) {
      if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('about:')) {
        throw new Error(`Protocol not allowed: ${url}`);
      }
      return true;
    },
  };

  const profileStore = new ProfileStore(profileDir, { vault });
  await profileStore.init();
  const extensionStore = new ManagedExtensionStore(join(dataDir, 'extensions'));
  await extensionStore.init();

  const manager = new SessionManager({
    maxSessions: 32,
    persistentProfile: true,
    profileRoot: profileDir,
    artifactsRoot: artifactsDir,
    profileStore,
    urlPolicy: urlPolicy as any,
    audit,
    extensionStore,
  });
  const proxyPool = new ProxyPoolStore(join(dataDir, 'proxy-pool.json'), vault);
  const rpa = new RpaService(manager, join(dataDir, 'rpa-state.json'));
  const teamAccess = new TeamAccessStore(join(dataDir, 'team-access.json'));
  await teamAccess.init();
  const externalRuntimes = new ExternalRuntimeRegistry();

  const configuredPort = Number(process.env.STUDIO_PORT ?? 3000);
  const PORT = Number.isInteger(configuredPort) && configuredPort >= 1 && configuredPort <= 65535 ? configuredPort : 3000;
  const HOST = '127.0.0.1';
  const targetUrl = `http://${HOST}:${PORT}/?bootstrap=${encodeURIComponent(bootstrapToken)}`;

  const apiServer = new RestApiServer(manager, {
    port: PORT,
    host: HOST,
    publicDir: join(process.cwd(), 'public'),
    credentials: loadCredentials(ownerToken),
    bootstrapToken,
    allowedOrigins: [`http://${HOST}:${PORT}`],
    audit,
    proxyPool,
    rpa,
    teamAccess,
    externalRuntimes,
    extensionStore,
  });

  try {
    const { port, host } = await apiServer.start();
    console.log(`⚡ 核心后台引擎已就绪: http://${host}:${port}`);
    launchDesktopWindow(targetUrl);
  } catch (err: any) {
    if (err.code === 'EADDRINUSE') {
      try {
        const response = await fetch(`http://${HOST}:${PORT}/api/v1/health`, { signal: AbortSignal.timeout(2_000) });
        const health = await response.json() as any;
        if (!response.ok || health?.data?.name !== 'Browser Profile Isolation Studio API') throw new Error('Port is occupied by another service');
        console.log(`ℹ️ 核心后台引擎已在运行中 (http://${HOST}:${PORT})，正在为您唤起桌面窗口...`);
        launchDesktopWindow(`http://${HOST}:${PORT}/`);
        await rpa.shutdown();
        await manager.shutdown();
        return;
      } catch (verificationError) {
        console.error(`端口 ${PORT} 已被其他服务占用，请设置 STUDIO_PORT 后重试。`, verificationError);
        await rpa.shutdown();
        await manager.shutdown();
        process.exitCode = 1;
        return;
      }
    } else {
      console.error('启动异常:', err);
      await rpa.shutdown();
      await manager.shutdown();
      process.exitCode = 1;
      return;
    }
  }

  console.log('\n💡 提示：按 Ctrl+C 可停止服务。保持此窗口运行以提供环境隔离与受控自动化服务。');

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await rpa.shutdown().catch(() => undefined);
    await apiServer.stop().catch(() => undefined);
    await manager.shutdown().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  // 永久保活守护
  setInterval(() => {}, 1000 * 60 * 60);
}

function loadCredentials(ownerToken: string): StudioCredential[] {
  const result: StudioCredential[] = [{ token: ownerToken, role: 'owner', label: 'local-owner' }];
  const raw = process.env.STUDIO_USERS_JSON?.trim();
  if (!raw) return result;
  const parsed = JSON.parse(raw) as Array<{ token: string; role: StudioRole; label?: string }>;
  for (const value of parsed) {
    if (typeof value.token !== 'string' || value.token.length < 32 || !['viewer', 'operator', 'manager', 'owner'].includes(value.role)) continue;
    result.push({ token: value.token, role: value.role, ...(value.label ? { label: value.label } : {}) });
  }
  return result;
}

void main();
