import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { launchPersistentChromium } from '../../src/browser/chromium-launcher.js';
import { launchPersistentFirefox } from '../../src/browser/firefox-launcher.js';
import { ManagedExtensionStore } from '../../src/extension/managed-extension-store.js';

const realExtensions = process.env.RUN_EXTENSION_SMOKE === '1' || process.env.npm_lifecycle_event === 'test:extensions' ? describe : describe.skip;

realExtensions('real managed Chromium extension smoke test', () => {
  let workRoot: string;
  beforeAll(async () => { workRoot = await mkdtemp(join(tmpdir(), 'managed-extension-smoke-')); });
  afterAll(async () => { if (workRoot) await rm(workRoot, { recursive: true, force: true }); });

  it('loads only the reviewed unpacked directory into a headed Chromium process', async () => {
    const archive = zipSync({
      'manifest.json': strToU8(JSON.stringify({ name: 'Managed Smoke', version: '1.0', manifest_version: 3, background: { service_worker: 'worker.js' } })),
      'worker.js': strToU8('globalThis.__managedExtensionSmoke = true;'),
    });
    const store = new ManagedExtensionStore(join(workRoot, 'extensions'));
    const record = await store.importPackage({ packageBase64: Buffer.from(archive).toString('base64') });
    const descriptors = await store.resolveForLaunch([record.extensionId], 'chromium');
    const context = await launchPersistentChromium(join(workRoot, 'profile'), { headless: false, managedExtensions: descriptors }) as any;
    try {
      const existing = context.serviceWorkers?.().find((worker: any) => worker.url().startsWith('chrome-extension://'));
      const worker = existing ?? await context.waitForEvent('serviceworker', { timeout: 15_000 });
      expect(worker.url()).toMatch(/^chrome-extension:\/\/[a-z]{32}\/worker\.js$/);
    } finally { await context.close(); }
  }, 45_000);
});

const signedFirefoxXpi = process.env.RUN_FIREFOX_EXTENSION_XPI;
const realFirefoxExtension = signedFirefoxXpi ? describe : describe.skip;

realFirefoxExtension('real signed Firefox extension smoke test', () => {
  let workRoot: string;
  beforeAll(async () => { workRoot = await mkdtemp(join(tmpdir(), 'managed-firefox-extension-smoke-')); });
  afterAll(async () => { if (workRoot) await rm(workRoot, { recursive: true, force: true }); });

  it('is accepted by Firefox native signature validation and becomes active', async () => {
    const store = new ManagedExtensionStore(join(workRoot, 'extensions'));
    const archive = await readFile(signedFirefoxXpi!);
    const record = await store.importPackage({ packageBase64: archive.toString('base64'), approveHighRisk: true });
    expect(record.engines).toContain('firefox');
    const descriptors = await store.resolveForLaunch([record.extensionId], 'firefox');
    const profileDirectory = join(workRoot, 'profile');
    const context = await launchPersistentFirefox(profileDirectory, { headless: true, managedExtensions: descriptors });
    await context.close();
    const registry = JSON.parse(await readFile(join(profileDirectory, 'extensions.json'), 'utf8')) as { addons?: Array<{ id?: string; active?: boolean; appDisabled?: boolean; userDisabled?: boolean }> };
    expect(registry.addons?.find((addon) => addon.id === record.geckoId)).toMatchObject({ active: true, appDisabled: false, userDisabled: false });
  }, 45_000);
});
