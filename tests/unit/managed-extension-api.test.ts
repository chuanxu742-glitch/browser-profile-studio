import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { zipSync, strToU8 } from 'fflate';
import { SessionManager } from '../../src/browser/session-manager.js';
import { ProfileStore } from '../../src/profile/profile-store.js';
import { ManagedExtensionStore } from '../../src/extension/managed-extension-store.js';
import { RestApiServer } from '../../src/api/server.js';

describe('managed extension REST API', () => {
  let root: string; let manager: SessionManager; let server: RestApiServer; let extensionStore: ManagedExtensionStore; let baseUrl: string;
  const headers = { Authorization: 'Bearer owner-extension-token-012345678901234', 'Content-Type': 'application/json' };
  const restrictedHeaders = { Authorization: 'Bearer manager-extension-token-012345678901', 'Content-Type': 'application/json' };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'extension-api-'));
    const profiles = new ProfileStore(join(root, 'profiles')); extensionStore = new ManagedExtensionStore(join(root, 'extensions')); await extensionStore.init();
    manager = new SessionManager({ cluster: false, profileStore: profiles, extensionStore });
    server = new RestApiServer(manager, { port: 0, host: '127.0.0.1', credentials: [
      { token: 'owner-extension-token-012345678901234', role: 'owner' },
      { token: 'manager-extension-token-012345678901', role: 'manager', grants: { profile: ['*'], extension: [] } },
    ], extensionStore });
    const address = await server.start(); baseUrl = `http://${address.host}:${address.port}/api/v1`;
  });
  afterEach(async () => { await server.stop(); await manager.shutdown(); await rm(root, { recursive: true, force: true }); });

  it('imports, assigns and prevents deletion while in use', async () => {
    const archive = zipSync({ 'manifest.json': strToU8(JSON.stringify({ name: 'API Fixture', version: '1.0', manifest_version: 3, browser_specific_settings: { gecko: { id: 'api@example.test' } } })), 'META-INF/manifest.mf': strToU8('fixture'), 'META-INF/mozilla.sf': strToU8('fixture'), 'META-INF/mozilla.rsa': strToU8('fixture') });
    const imported = await fetch(`${baseUrl}/extensions/import`, { method: 'POST', headers, body: JSON.stringify({ packageBase64: Buffer.from(archive).toString('base64') }) });
    expect(imported.status).toBe(201); const extension = (await imported.json() as any).data;
    const created = await fetch(`${baseUrl}/profiles`, { method: 'POST', headers, body: JSON.stringify({ name: 'With extension', engine: 'firefox', extensionIds: [extension.extensionId] }) });
    expect(created.status).toBe(201); const profile = (await created.json() as any).data;
    expect(profile.extensionIds).toEqual([extension.extensionId]);
    expect((await fetch(`${baseUrl}/extensions/${extension.extensionId}`, { method: 'DELETE', headers })).status).toBe(409);
    expect((await fetch(`${baseUrl}/profiles/${profile.profileId}/extensions`, { method: 'PUT', headers, body: JSON.stringify({ extensionIds: [] }) })).status).toBe(200);
    expect((await fetch(`${baseUrl}/extensions/${extension.extensionId}`, { method: 'DELETE', headers })).status).toBe(200);
  });

  it('rejects incompatible engines, malformed packages and extension-grant bypasses', async () => {
    expect((await fetch(`${baseUrl}/extensions/import`, { method: 'POST', headers, body: JSON.stringify({ packageBase64: 'bad!' }) })).status).toBe(400);
    const archive = zipSync({ 'manifest.json': strToU8(JSON.stringify({ name: 'Chromium only', version: '1.0', manifest_version: 3 })) });
    const imported = await fetch(`${baseUrl}/extensions/import`, { method: 'POST', headers, body: JSON.stringify({ packageBase64: Buffer.from(archive).toString('base64') }) });
    const extension = (await imported.json() as any).data;
    expect((await fetch(`${baseUrl}/profiles`, { method: 'POST', headers, body: JSON.stringify({ name: 'Wrong engine', engine: 'firefox', extensionIds: [extension.extensionId] }) })).status).toBe(400);
    expect((await fetch(`${baseUrl}/profiles`, { method: 'POST', headers: restrictedHeaders, body: JSON.stringify({ name: 'No grant', engine: 'chromium', extensionIds: [extension.extensionId] }) })).status).toBe(403);
  });
});
