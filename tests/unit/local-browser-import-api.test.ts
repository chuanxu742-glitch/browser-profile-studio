import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { RestApiServer } from '../../src/api/server.js';
import { SessionManager } from '../../src/browser/session-manager.js';
import { ProfileStore } from '../../src/profile/profile-store.js';

describe('local browser migration API', () => {
  let root: string;
  let manager: SessionManager;
  let server: RestApiServer;
  let baseUrl: string;
  const ownerToken = 'owner-token-local-import-012345678901234';
  const viewerToken = 'viewer-token-local-import-01234567890123';
  const sourceId = 'a'.repeat(64);
  const importer = {
    scan: vi.fn(async () => [{
      name: 'Google Chrome',
      type: 'chrome' as const,
      userDataPath: 'C:\\Browser\\User Data',
      profiles: [{
        sourceId,
        name: 'Default',
        path: 'C:\\Browser\\User Data\\Default',
        hasCookies: true,
        hasLocalStorage: true,
        hasIndexedDb: false,
        hasSavedPasswords: true,
        inUse: false,
      }],
    }]),
    importProfile: vi.fn(async () => ({
      profile: {
        profileId: 'imported-chrome-default-aaaaaaaa',
        name: '从Google Chrome导入-Default',
        createdAt: 1,
        updatedAt: 2,
        engine: 'chromium' as const,
      },
      browserName: 'Google Chrome',
      browserType: 'chrome' as const,
      sourceProfileName: 'Default',
      copiedFiles: 3,
      copiedBytes: 42,
      importedData: ['cookies', 'localStorage'],
      excludedData: ['savedPasswords'],
      warnings: [],
    })),
  };

  beforeEach(async () => {
    importer.scan.mockClear();
    importer.importProfile.mockClear();
    root = await mkdtemp(join(tmpdir(), 'local-import-api-'));
    const store = new ProfileStore(join(root, 'profiles'));
    manager = new SessionManager({ profileStore: store, profileRoot: join(root, 'profiles'), artifactsRoot: join(root, 'artifacts') });
    server = new RestApiServer(manager, {
      port: 0,
      host: '127.0.0.1',
      credentials: [
        { token: viewerToken, role: 'viewer' },
        { token: ownerToken, role: 'owner' },
      ],
      localBrowserImporter: importer,
    });
    const address = await server.start();
    baseUrl = `http://${address.host}:${address.port}`;
  });

  afterEach(async () => {
    await server.stop();
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  it('requires owner access to scan and import local browser data', async () => {
    expect((await fetch(`${baseUrl}/api/v1/migration/local-browsers`, { headers: { Authorization: `Bearer ${viewerToken}` } })).status).toBe(403);
    const scan = await fetch(`${baseUrl}/api/v1/migration/local-browsers`, { headers: { Authorization: `Bearer ${ownerToken}` } });
    expect(scan.status).toBe(200);
    expect((await scan.json() as any).data[0].profiles[0].sourceId).toBe(sourceId);

    const imported = await fetch(`${baseUrl}/api/v1/migration/import-local`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId, confirmBrowserClosed: true }),
    });
    expect(imported.status).toBe(200);
    expect((await imported.json() as any).data.copiedFiles).toBe(3);
    expect(importer.importProfile).toHaveBeenCalledWith({ sourceId, confirmBrowserClosed: true });
  });
});
