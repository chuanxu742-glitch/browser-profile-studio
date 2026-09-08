import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveCdpProfile } from '../../src/cdp/profile.js';

describe('CDP profile persistence', () => {
  const roots: string[] = [];
  async function directory() { const root = await mkdtemp(join(tmpdir(), 'cdp-profile-')); roots.push(root); return root; }
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

  it('publishes one complete identity under concurrent first starts', async () => {
    const root = await directory();
    const profiles = await Promise.all(Array.from({ length: 16 }, () => resolveCdpProfile(root, { CDP_COUNTRY: 'JP' })));
    for (const profile of profiles) expect(profile).toEqual(profiles[0]);
    expect(profiles[0]?.locale).toBe('ja-JP');
    expect(JSON.parse(await readFile(join(root, 'cdp-profile.json'), 'utf8'))).toEqual(profiles[0]);
    expect(await readdir(root)).toEqual(['cdp-profile.json']);
  });
  it.each(['', ' ', '1e3', '-1', '1.5', '0x10'])('rejects invalid numeric seed %j without writing state', async (seed) => {
    const root = await directory();
    await expect(resolveCdpProfile(root, { CDP_SEED: seed })).rejects.toThrow('CDP_PROFILE_CONFIG_INVALID:seed');
    expect(await readdir(root)).toEqual([]);
  });
  it.each(['locale', 'timezone'] as const)('validates persisted %s again on restart', async (key) => {
    const root = await directory();
    const profile = await resolveCdpProfile(root, {});
    await writeFile(join(root, 'cdp-profile.json'), JSON.stringify({ ...profile, [key]: 'not_a_valid_value' }));
    await expect(resolveCdpProfile(root, {})).rejects.toThrow('CDP_PROFILE_METADATA_INVALID');
  });
  it('never replaces a valid profile when an explicit configuration conflicts', async () => {
    const root = await directory();
    const profile = await resolveCdpProfile(root, { CDP_SEED: '0' });
    await expect(resolveCdpProfile(root, { CDP_SEED: '1' })).rejects.toThrow('CDP_PROFILE_CONFIG_CONFLICT:seed');
    expect(await resolveCdpProfile(root, {})).toEqual(profile);
  });
});
