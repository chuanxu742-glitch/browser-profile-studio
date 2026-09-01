import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalBrowserImporter } from '../../src/migration/local-browser-importer.js';
import { ProfileStore } from '../../src/profile/profile-store.js';

describe('LocalBrowserImporter', () => {
  let root: string | undefined;
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

  it('discovers Chromium profiles and imports only website session data', async () => {
    root = await mkdtemp(join(tmpdir(), 'local-browser-import-'));
    const userData = join(root, 'Chrome', 'User Data');
    const source = join(userData, 'Default');
    await mkdir(join(source, 'Network'), { recursive: true });
    await mkdir(join(source, 'Local Storage', 'leveldb'), { recursive: true });
    await mkdir(join(source, 'IndexedDB', 'https_example.test_0.indexeddb.leveldb'), { recursive: true });
    await mkdir(join(source, 'Extensions', 'unmanaged-extension'), { recursive: true });
    await writeFile(join(userData, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: 'test-key' }, profile: { secret: 'excluded' } }));
    await writeFile(join(source, 'Network', 'Cookies'), 'cookie-db');
    await writeFile(join(source, 'Local Storage', 'leveldb', '000001.ldb'), 'local-storage');
    await writeFile(join(source, 'IndexedDB', 'https_example.test_0.indexeddb.leveldb', '000001.ldb'), 'indexed-db');
    await writeFile(join(source, 'Login Data'), 'password-db');
    await writeFile(join(source, 'History'), 'history-db');
    await writeFile(join(source, 'Extensions', 'unmanaged-extension', 'manifest.json'), '{}');

    const store = new ProfileStore(join(root, 'target-profiles'));
    const importer = new LocalBrowserImporter(store, {
      candidates: [{ name: 'Google Chrome', type: 'chrome', userDataPath: userData }],
    });
    const browsers = await importer.scan();
    const scanned = browsers[0]?.profiles[0];
    expect(scanned).toMatchObject({ name: 'Default', hasCookies: true, hasLocalStorage: true, hasIndexedDb: true, hasSavedPasswords: true, inUse: false });
    await expect(importer.importProfile({ sourceId: scanned!.sourceId, confirmBrowserClosed: false })).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });

    const imported = await importer.importProfile({ sourceId: scanned!.sourceId, confirmBrowserClosed: true });
    const destination = store.getProfileDir(imported.profile.profileId);
    expect(imported.profile.engine).toBe('chromium');
    expect(imported.importedData).toEqual(expect.arrayContaining(['cookies', 'localStorage', 'indexedDb', 'cookieEncryptionMetadata']));
    expect(await readFile(join(destination, 'Default', 'Network', 'Cookies'), 'utf8')).toBe('cookie-db');
    expect(await readFile(join(destination, 'Default', 'Local Storage', 'leveldb', '000001.ldb'), 'utf8')).toBe('local-storage');
    expect(JSON.parse(await readFile(join(destination, 'Local State'), 'utf8'))).toEqual({ os_crypt: { encrypted_key: 'test-key' } });
    expect(existsSync(join(destination, 'Default', 'Login Data'))).toBe(false);
    expect(existsSync(join(destination, 'Default', 'History'))).toBe(false);
    expect(existsSync(join(destination, 'Default', 'Extensions'))).toBe(false);
  });

  it('imports Firefox cookies and origin storage without passwords or extensions', async () => {
    root = await mkdtemp(join(tmpdir(), 'local-firefox-import-'));
    const profilesRoot = join(root, 'Firefox', 'Profiles');
    const source = join(profilesRoot, 'abc.default-release');
    await mkdir(join(source, 'storage', 'default', 'https+++example.test'), { recursive: true });
    await mkdir(join(source, 'extensions'), { recursive: true });
    await writeFile(join(source, 'prefs.js'), 'user_pref("browser.startup.page", 1);');
    await writeFile(join(source, 'cookies.sqlite'), 'firefox-cookie-db');
    await writeFile(join(source, 'storage', 'default', 'https+++example.test', 'data.sqlite'), 'site-storage');
    await writeFile(join(source, 'logins.json'), '{"logins":[]}');
    await writeFile(join(source, 'key4.db'), 'password-key');
    await writeFile(join(source, 'extensions', 'unmanaged.xpi'), 'extension');

    const store = new ProfileStore(join(root, 'target-profiles'));
    const importer = new LocalBrowserImporter(store, {
      candidates: [{ name: 'Mozilla Firefox', type: 'firefox', userDataPath: profilesRoot }],
    });
    const scanned = (await importer.scan())[0]?.profiles[0];
    const imported = await importer.importProfile({ sourceId: scanned!.sourceId, confirmBrowserClosed: true });
    const destination = store.getProfileDir(imported.profile.profileId);
    expect(imported.profile.engine).toBe('firefox');
    expect(await readFile(join(destination, 'cookies.sqlite'), 'utf8')).toBe('firefox-cookie-db');
    expect(await readFile(join(destination, 'storage', 'default', 'https+++example.test', 'data.sqlite'), 'utf8')).toBe('site-storage');
    expect(existsSync(join(destination, 'logins.json'))).toBe(false);
    expect(existsSync(join(destination, 'key4.db'))).toBe(false);
    expect(existsSync(join(destination, 'extensions'))).toBe(false);
  });

  it('refuses to import a profile while the source browser lock is present', async () => {
    root = await mkdtemp(join(tmpdir(), 'local-browser-lock-'));
    const userData = join(root, 'Edge', 'User Data');
    const source = join(userData, 'Default');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'Cookies'), 'cookie-db');
    await writeFile(join(userData, 'SingletonLock'), 'locked');
    const store = new ProfileStore(join(root, 'target-profiles'));
    const importer = new LocalBrowserImporter(store, {
      candidates: [{ name: 'Microsoft Edge', type: 'edge', userDataPath: userData }],
    });
    const scanned = (await importer.scan())[0]?.profiles[0];
    expect(scanned?.inUse).toBe(true);
    await expect(importer.importProfile({ sourceId: scanned!.sourceId, confirmBrowserClosed: true })).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
});
