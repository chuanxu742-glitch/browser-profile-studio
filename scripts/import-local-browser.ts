import { LocalBrowserImporter } from '../src/migration/local-browser-importer.js';
import { ProfileStore } from '../src/profile/profile-store.js';

async function main(): Promise<void> {
  const importer = new LocalBrowserImporter(new ProfileStore('data/profiles'));
  const browsers = await importer.scan();
  if (browsers.length === 0) {
    console.log('未在系统默认路径检测到 Chrome、Edge 或 Firefox Profile。');
    return;
  }

  console.log('检测到的本机浏览器 Profile：');
  for (const browser of browsers) {
    for (const profile of browser.profiles) {
      console.log(JSON.stringify({
        sourceId: profile.sourceId,
        browser: browser.name,
        profile: profile.name,
        path: profile.path,
        inUse: profile.inUse,
        data: {
          cookies: profile.hasCookies,
          localStorage: profile.hasLocalStorage,
          indexedDb: profile.hasIndexedDb,
          savedPasswordsDetectedButExcluded: profile.hasSavedPasswords,
        },
      }));
    }
  }

  const inlineSource = process.argv.find((value) => value.startsWith('--source='))?.slice('--source='.length);
  const sourceIndex = process.argv.indexOf('--source');
  const positionalSource = process.argv.find((value) => /^[a-f0-9]{64}$/.test(value));
  const sourceId = inlineSource || (sourceIndex >= 0 ? process.argv[sourceIndex + 1] : undefined) || positionalSource;
  if (!sourceId) {
    console.log('\n仅完成扫描。要导入，请完全退出源浏览器后执行：');
    console.log('npm run import:local -- <sourceId> confirm-browser-closed');
    return;
  }
  if (!process.argv.includes('--confirm-browser-closed') && !process.argv.includes('confirm-browser-closed')) {
    throw new Error('导入前必须完全退出源浏览器，并提供 confirm-browser-closed。');
  }

  const result = await importer.importProfile({
    sourceId,
    confirmBrowserClosed: true,
  });
  console.log('\n导入完成：');
  console.log(JSON.stringify(result, null, 2));
}

void main().catch((error) => {
  console.error(JSON.stringify({
    message: error instanceof Error ? error.message : String(error),
    code: error?.code,
    details: error?.details,
  }));
  process.exitCode = 1;
});
