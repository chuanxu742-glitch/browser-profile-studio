import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../../src/browser/session-manager.js';
import { handleToolCall } from '../../src/mcp/server.js';
import { ProfileStore } from '../../src/profile/profile-store.js';

describe('Profile and Proxy MCP Tools Contract Tests', () => {
  let tempDir: string;
  let manager: SessionManager;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'mcp-profile-test-'));
    const store = new ProfileStore(join(tempDir, 'profiles'));
    manager = new SessionManager({
      profileRoot: join(tempDir, 'profiles'),
      artifactsRoot: join(tempDir, 'artifacts'),
      profileStore: store,
    });
  });

  afterEach(async () => {
    await manager.shutdown();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should create, list, export cookies and delete profiles via MCP tools', async () => {
    // 1. profile_create
    const createResult = await handleToolCall(manager, 'profile_create', {
      name: 'Ebay US Store',
      description: 'Ebay merchant profile',
      proxy: {
        server: 'socks5://user:pass@127.0.0.1:1080',
      },
      geo: {
        countryCode: 'US',
        timezone: 'America/Chicago',
      },
      initialCookies: [
        { name: 'ebay_token', value: 'token123', domain: '.ebay.com', path: '/' },
      ],
    });

    expect(createResult.isError).toBeFalsy();
    const createdData = (createResult as any).structuredContent.data;
    expect(createdData.profileId).toBeDefined();
    expect(createdData.name).toBe('Ebay US Store');

    const profileId = createdData.profileId;

    // 2. profile_get
    const getResult = await handleToolCall(manager, 'profile_get', { profileId });
    expect(getResult.isError).toBeFalsy();
    const getData = (getResult as any).structuredContent.data;
    expect(getData.name).toBe('Ebay US Store');
    expect(getData.proxy.server).toBe('socks5://127.0.0.1:1080');

    // 3. profile_list
    const listResult = await handleToolCall(manager, 'profile_list', {});
    expect(listResult.isError).toBeFalsy();
    const listData = (listResult as any).structuredContent.data;
    expect(listData.some((p: any) => p.profileId === profileId)).toBe(true);

    // 4. profile_export_cookies (Netscape format)
    const exportResult = await handleToolCall(manager, 'profile_export_cookies', {
      profileId,
      format: 'netscape',
    });
    expect(exportResult.isError).toBeFalsy();
    const exportedData = (exportResult as any).structuredContent.data;
    expect(exportedData).toContain('ebay_token\ttoken123');

    // 5. profile_import_cookies
    const importResult = await handleToolCall(manager, 'profile_import_cookies', {
      profileId,
      cookies: [
        { name: 'session_guid', value: 'guid_999', domain: '.ebay.com', path: '/' },
      ],
      format: 'json',
    });
    expect(importResult.isError).toBeFalsy();
    expect((importResult as any).structuredContent.data).toBe(2);

    // 6. proxy_check
    const checkResult = await handleToolCall(manager, 'proxy_check', {
      proxy: 'http://127.0.0.1:59999',
    });
    expect(checkResult.isError).toBeFalsy();
    const checkData = (checkResult as any).structuredContent.data;
    expect(checkData.success).toBe(false); // unreachable port fails gracefully

    // 7. profile_delete
    const deleteResult = await handleToolCall(manager, 'profile_delete', { profileId });
    expect(deleteResult.isError).toBeFalsy();
    expect((deleteResult as any).structuredContent.data).toBe(true);
  });
});
