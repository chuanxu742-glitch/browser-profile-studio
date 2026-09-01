import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { zipSync, strToU8 } from 'fflate';
import { ManagedExtensionStore } from '../../src/extension/managed-extension-store.js';
import { ProfileStore } from '../../src/profile/profile-store.js';
import { SessionManager } from '../../src/browser/session-manager.js';
import type { BrowserSession, BrowserSessionOptions, BrowserSessionStatus } from '../../src/browser/browser-session.js';

describe('ManagedExtensionStore', () => {
  let root: string | undefined;
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

  it('imports a reviewed package, pins its hash and resolves engine-specific launch assets', async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-ext-'));
    const store = new ManagedExtensionStore(root);
    const archive = packageBytes({
      name: 'Fixture Extension', version: '1.2.3', manifest_version: 3,
      permissions: ['storage'], browser_specific_settings: { gecko: { id: 'fixture@example.test' } },
    }, true);
    const record = await store.importPackage({ packageBase64: Buffer.from(archive).toString('base64') });
    expect(record).toMatchObject({ name: 'Fixture Extension', version: '1.2.3', engines: ['chromium', 'firefox'], geckoId: 'fixture@example.test' });
    const chromium = await store.resolveForLaunch([record.extensionId], 'chromium');
    expect(await readFile(join(chromium[0]!.directory, 'manifest.json'), 'utf8')).toContain('Fixture Extension');
    expect((await store.resolveForLaunch([record.extensionId], 'firefox'))[0]?.packagePath).toMatch(/package\.xpi$/);
    const duplicate = await store.importPackage({ packageBase64: Buffer.from(archive).toString('base64') });
    expect(duplicate.extensionId).toBe(record.extensionId);
    await writeFile(chromium[0]!.packagePath, 'tampered');
    await expect(store.resolveForLaunch([record.extensionId], 'chromium')).rejects.toThrow('EXTENSION_INTEGRITY_FAILED');
  });

  it('requires explicit approval for high-risk permissions and rejects forbidden native capabilities', async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-ext-risk-'));
    const store = new ManagedExtensionStore(root);
    const highRisk = packageBytes({ name: 'Cookies', version: '1.0', manifest_version: 3, permissions: ['cookies'], host_permissions: ['<all_urls>'] });
    await expect(store.importPackage({ packageBase64: Buffer.from(highRisk).toString('base64') })).rejects.toThrow('EXTENSION_HIGH_RISK_APPROVAL_REQUIRED');
    expect((await store.importPackage({ packageBase64: Buffer.from(highRisk).toString('base64'), approveHighRisk: true })).highRiskPermissions).toContain('cookies');
    const forbidden = packageBytes({ name: 'Debugger', version: '1.0', manifest_version: 3, permissions: ['debugger'] });
    await expect(store.importPackage({ packageBase64: Buffer.from(forbidden).toString('base64'), approveHighRisk: true })).rejects.toThrow('EXTENSION_PERMISSION_FORBIDDEN');
    const broadHost = packageBytes({ name: 'Broad host', version: '1.0', manifest_version: 3, permissions: ['*://*/*'] });
    await expect(store.importPackage({ packageBase64: Buffer.from(broadHost).toString('base64') })).rejects.toThrow('EXTENSION_HIGH_RISK_APPROVAL_REQUIRED');
    const optionalForbidden = packageBytes({ name: 'Optional debugger', version: '1.0', manifest_version: 3, optional_permissions: ['debugger'] });
    await expect(store.importPackage({ packageBase64: Buffer.from(optionalForbidden).toString('base64'), approveHighRisk: true })).rejects.toThrow('EXTENSION_PERMISSION_FORBIDDEN');
  });

  it('rejects executable payloads', async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-ext-exe-'));
    const store = new ManagedExtensionStore(root);
    const archive = zipSync({ 'manifest.json': strToU8(JSON.stringify({ name: 'Bad', version: '1.0', manifest_version: 3 })), 'payload.exe': new Uint8Array([1, 2, 3]) });
    await expect(store.importPackage({ packageBase64: Buffer.from(archive).toString('base64') })).rejects.toThrow('EXTENSION_EXECUTABLE_FORBIDDEN');
  });

  it('does not advertise unsigned Firefox packages as Firefox compatible', async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-ext-unsigned-'));
    const store = new ManagedExtensionStore(root);
    const archive = packageBytes({
      name: 'Unsigned Firefox Fixture', version: '1.0', manifest_version: 3,
      browser_specific_settings: { gecko: { id: 'unsigned@example.test' } },
    });
    const record = await store.importPackage({ packageBase64: Buffer.from(archive).toString('base64') });
    expect(record).toMatchObject({ engines: ['chromium'], geckoId: 'unsigned@example.test', firefoxSignaturePresent: false });
    await expect(store.resolveForLaunch([record.extensionId], 'firefox')).rejects.toThrow('EXTENSION_ENGINE_UNSUPPORTED');
  });

  it('rejects malformed base64 and traversal paths before persisting files', async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-ext-path-'));
    const store = new ManagedExtensionStore(root);
    await expect(store.importPackage({ packageBase64: 'not base64!' })).rejects.toThrow('EXTENSION_PACKAGE_INVALID');
    const traversal = zipSync({ 'manifest.json': strToU8(JSON.stringify({ name: 'Traversal', version: '1.0', manifest_version: 3 })), '../outside.js': strToU8('bad') });
    await expect(store.importPackage({ packageBase64: Buffer.from(traversal).toString('base64') })).rejects.toThrow('EXTENSION_PATH_INVALID');
  });

  it('accepts Firefox UUID-style Gecko IDs when a signature structure is present', async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-ext-guid-'));
    const store = new ManagedExtensionStore(root);
    const geckoId = '{446900e4-71c2-419f-a6a7-df9c091e268b}';
    const record = await store.importPackage({ packageBase64: Buffer.from(packageBytes({ name: 'GUID Fixture', version: '1.0', manifest_version: 2, browser_specific_settings: { gecko: { id: geckoId } } }, true)).toString('base64') });
    expect(record).toMatchObject({ geckoId, engines: ['firefox'], firefoxSignaturePresent: true });
  });

  it('resolves only Profile-assigned managed assets into the server-owned launch options', async () => {
    root = await mkdtemp(join(tmpdir(), 'managed-ext-launch-'));
    const extensions = new ManagedExtensionStore(join(root, 'extensions'));
    const record = await extensions.importPackage({ packageBase64: Buffer.from(packageBytes({ name: 'Launch Fixture', version: '1.0', manifest_version: 3 })).toString('base64') });
    const profiles = new ProfileStore(join(root, 'profiles'));
    await profiles.createProfile({ profileId: 'profile-with-extension', name: 'Profile', engine: 'chromium', extensionIds: [record.extensionId] });
    let captured: BrowserSessionOptions | undefined;
    const session = fakeSession('ses_extension_fixture');
    const manager = new SessionManager({ cluster: false, profileStore: profiles, extensionStore: extensions, sessionFactory: (options) => { captured = options; return session; } });
    await manager.start({ profileId: 'profile-with-extension' });
    expect(captured?.managedExtensions).toHaveLength(1);
    expect(captured?.managedExtensions?.[0]).toMatchObject({ extensionId: record.extensionId, directory: expect.stringContaining('unpacked') });
    await manager.shutdown();
  });
});

function packageBytes(manifest: Record<string, unknown>, signed = false): Uint8Array {
  return zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), 'worker.js': strToU8('chrome.runtime.onInstalled.addListener(() => {});'), ...(signed ? { 'META-INF/manifest.mf': strToU8('fixture'), 'META-INF/mozilla.sf': strToU8('fixture'), 'META-INF/mozilla.rsa': strToU8('fixture') } : {}) });
}

function fakeSession(sessionId: string): BrowserSession {
  let state: BrowserSessionStatus['state'] = 'STOPPED';
  const status = (): BrowserSessionStatus => ({ sessionId, state, engine: 'chromium', headless: true, pageGeneration: 0, queueDepth: 0, challenge: { detected: false }, interrupts: { latestSequence: 0, total: 0, recent: [] }, control: { state: 'AGENT_CONTROLLED', controlState: 'AGENT_CONTROLLED', owner: 'agent', handoffState: 'NONE', leaseState: 'NONE', phase: 'NONE', hardStop: false, agentWriteAllowed: true, userControlActive: false, leaseActive: false, hasActiveLease: false } });
  return { sessionId, get state() { return state; }, start: async () => { state = 'READY'; return status(); }, stop: async () => { state = 'STOPPED'; return status(); }, status } as unknown as BrowserSession;
}
