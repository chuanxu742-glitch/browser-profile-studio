import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProfileStore } from '../../src/profile/profile-store.js';
import { cookiesToNetscape, parseNetscapeCookies, parseCookies } from '../../src/profile/cookie-converter.js';
import { managedBrowserIdentity } from '../../src/fingerprint/runtime-identity.js';

describe('Profile and Cookie Unit Tests', () => {
  let tempDir: string;
  let store: ProfileStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'profile-test-'));
    store = new ProfileStore(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('Cookie Converter', () => {
    it('should convert cookies to Netscape format and parse back losslessly', () => {
      const original = [
        {
          name: 'session_id',
          value: 'xyz123456',
          domain: '.example.com',
          path: '/',
          expires: 1800000000,
          secure: true,
        },
        {
          name: 'theme',
          value: 'dark',
          domain: 'app.example.com',
          path: '/settings',
          secure: false,
        },
      ];

      const netscapeText = cookiesToNetscape(original);
      expect(netscapeText).toContain('# Netscape HTTP Cookie File');
      expect(netscapeText).toContain('.example.com\tTRUE\t/\tTRUE\t1800000000\tsession_id\txyz123456');

      const parsed = parseNetscapeCookies(netscapeText);
      expect(parsed).toHaveLength(2);
      expect(parsed[0]?.name).toBe('session_id');
      expect(parsed[0]?.value).toBe('xyz123456');
      expect(parsed[0]?.domain).toBe('.example.com');
      expect(parsed[0]?.secure).toBe(true);

      expect(parsed[1]?.name).toBe('theme');
      expect(parsed[1]?.value).toBe('dark');
      expect(parsed[1]?.secure).toBe(false);
    });

    it('should parse JSON cookies format', () => {
      const jsonCookies = JSON.stringify([
        { name: 'token', value: 'secret', domain: 'api.example.com', path: '/' },
      ]);
      const parsed = parseCookies(jsonCookies, 'json');
      expect(parsed).toHaveLength(1);
      expect(parsed[0]?.name).toBe('token');
      expect(parsed[0]?.value).toBe('secret');
    });
  });

  describe('ProfileStore', () => {
    it('should create, read, list, update and delete a profile', async () => {
      const created = await store.createProfile({
        name: 'Amazon US Store',
        description: 'US Operation Store Profile',
        tags: ['e-commerce', 'us'],
        proxy: {
          server: 'http://user:pass@1.2.3.4:8080',
        },
        geo: {
          countryCode: 'US',
          timezone: 'America/New_York',
        },
        initialCookies: [
          { name: 'c_user', value: '10001', domain: '.amazon.com', path: '/' },
        ],
      });

      expect(created.profileId).toBeDefined();
      expect(created.name).toBe('Amazon US Store');
      expect(created.proxy?.server).toBe('http://1.2.3.4:8080');
      expect(created.fingerprint?.seed).toBeGreaterThan(0);

      const fetched = await store.getProfile(created.profileId);
      expect(fetched?.name).toBe('Amazon US Store');
      expect(fetched?.fingerprint?.seed).toBe(created.fingerprint?.seed);

      const list = await store.listProfiles();
      expect(list.some((p) => p.profileId === created.profileId)).toBe(true);

      const cookies = await store.getCookies(created.profileId);
      expect(cookies).toHaveLength(1);
      expect(cookies[0]?.name).toBe('c_user');

      // Export cookies as Netscape format
      const exportedNetscape = await store.exportCookies(created.profileId, 'netscape');
      expect(exportedNetscape).toContain('c_user\t10001');

      // Import additional cookies
      const importedCount = await store.importCookies(created.profileId, [
        { name: 'xs', value: 'abcdef', domain: '.amazon.com', path: '/' },
      ]);
      expect(importedCount).toBe(2);

      const updated = await store.updateProfile(created.profileId, {
        description: 'Updated description',
      });
      expect(updated.description).toBe('Updated description');

      const deleted = await store.deleteProfile(created.profileId);
      expect(deleted).toBe(true);

      const afterDelete = await store.getProfile(created.profileId);
      expect(afterDelete).toBeNull();
    });

    it('rejects a custom User-Agent whose major version does not match the managed core', async () => {
      await expect(store.createProfile({
        name: 'Stale Chrome',
        engine: 'chromium',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36',
      })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

      const major = managedBrowserIdentity('chromium').majorVersion;
      await expect(store.createProfile({
        name: 'Aligned Chrome',
        engine: 'chromium',
        userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/${major}.0.0.0 Safari/537.36`,
      })).resolves.toMatchObject({ engine: 'chromium' });
    });

    it('removes the exact legacy UA presets generated by older releases', async () => {
      const profileDir = join(tempDir, 'legacy-profile');
      await mkdir(profileDir, { recursive: true });
      await writeFile(join(profileDir, 'metadata.json'), JSON.stringify({
        profileId: 'legacy-profile',
        name: 'Legacy',
        createdAt: 1,
        updatedAt: 1,
        engine: 'firefox',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
      }));

      expect((await store.getProfile('legacy-profile'))?.userAgent).toBeUndefined();
      expect(JSON.parse(await readFile(join(profileDir, 'metadata.json'), 'utf8')).userAgent).toBeUndefined();
    });
  });
});
