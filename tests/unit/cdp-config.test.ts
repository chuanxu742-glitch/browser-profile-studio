import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startCdpService } from '../../src/cdp/service.js';

describe('CDP configuration', () => {
  it('rejects a network listener without authentication', async () => {
    await expect(startCdpService({ CDP_HOST: '0.0.0.0' })).rejects.toThrow('CDP_TOKEN_REQUIRED');
    await expect(startCdpService({ CDP_TOKEN: 'short' })).rejects.toThrow('at least 24');
  });
  it('rejects malformed persisted identity before launching a browser', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cdp-invalid-'));
    try {
      await writeFile(join(root, 'cdp-profile.json'), '{"seed":"broken"}');
      await expect(startCdpService({ CDP_PROFILE_DIR: root })).rejects.toThrow('CDP_PROFILE_METADATA_INVALID');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('rejects credential-bearing or path-based advertised endpoints', async () => {
    await expect(startCdpService({ CDP_PUBLIC_URL: 'https://user:pass@example.com' })).rejects.toThrow('HTTP(S) origin');
    await expect(startCdpService({ CDP_PUBLIC_URL: 'https://example.com/path' })).rejects.toThrow('HTTP(S) origin');
  });
});
