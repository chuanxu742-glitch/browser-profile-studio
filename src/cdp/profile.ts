import { randomInt, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { managedBrowserIdentity } from '../fingerprint/runtime-identity.js';
import { alignGeoEnvironment } from '../geoip/aligner.js';

const profileSchema = z.object({
  schema: z.literal(1), seed: z.number().int().min(0).max(0xffffffff),
  os: z.enum(['linux', 'windows', 'macos']), countryCode: z.string().regex(/^[A-Z]{2}$/),
  locale: z.string().min(1), timezone: z.string().min(1),
  width: z.number().int().min(320).max(7680), height: z.number().int().min(240).max(4320),
  browserVersion: z.string().min(1),
}).strict().superRefine((value, ctx) => {
  try { if (Intl.getCanonicalLocales(value.locale).length !== 1) throw new Error(); }
  catch { ctx.addIssue({ code: 'custom', path: ['locale'], message: 'Invalid locale' }); }
  try { new Intl.DateTimeFormat('en-US', { timeZone: value.timezone }); }
  catch { ctx.addIssue({ code: 'custom', path: ['timezone'], message: 'Invalid timezone' }); }
});

export type CdpProfile = z.infer<typeof profileSchema>;

function integer(raw: string | undefined, key: string): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw new Error(`CDP_PROFILE_CONFIG_INVALID:${key}`);
  return Number(raw);
}

/** Atomically publishes a complete, synced file without replacing a competing writer. */
async function publishProfile(path: string, profile: CdpProfile): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(profile, null, 2)); await handle.sync(); }
    finally { await handle.close(); }
    // Unlike rename, hard-link creation has no overwrite behavior. A losing
    // writer reads the complete winner instead of a partially written JSON file.
    await link(temporary, path);
  } finally { await unlink(temporary).catch(() => undefined); }
}

export async function resolveCdpProfile(directory: string, env: NodeJS.ProcessEnv): Promise<CdpProfile> {
  const metadataPath = join(directory, 'cdp-profile.json');
  const seed = integer(env.CDP_SEED, 'seed');
  const width = integer(env.CDP_WIDTH, 'width');
  const height = integer(env.CDP_HEIGHT, 'height');
  const explicit = {
    ...(seed !== undefined ? { seed } : {}),
    ...(env.CDP_OS !== undefined ? { os: env.CDP_OS } : {}),
    ...(env.CDP_COUNTRY !== undefined ? { countryCode: env.CDP_COUNTRY } : {}),
    ...(env.CDP_LOCALE !== undefined ? { locale: env.CDP_LOCALE } : {}),
    ...(env.CDP_TIMEZONE !== undefined ? { timezone: env.CDP_TIMEZONE } : {}),
    ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}),
  };
  const read = async () => {
    const raw = await readFile(metadataPath, 'utf8');
    try { return profileSchema.parse(JSON.parse(raw)); }
    catch { throw new Error('CDP_PROFILE_METADATA_INVALID'); }
  };
  let metadata: CdpProfile;
  try { metadata = await read(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const geo = alignGeoEnvironment({ ...(env.CDP_COUNTRY ? { countryCode: env.CDP_COUNTRY } : {}),
      ...(env.CDP_LOCALE ? { locale: env.CDP_LOCALE } : {}), ...(env.CDP_TIMEZONE ? { timezone: env.CDP_TIMEZONE } : {}) });
    const candidate = profileSchema.safeParse({ schema: 1, seed: randomInt(0x100000000),
      os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
      countryCode: geo.country, locale: geo.locale, timezone: geo.timezoneId, width: 1280, height: 800,
      browserVersion: managedBrowserIdentity('chromium').fullVersion, ...explicit });
    if (!candidate.success) throw new Error('CDP_PROFILE_CONFIG_INVALID');
    metadata = candidate.data;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try { await publishProfile(metadataPath, metadata); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      metadata = await read();
    }
  }
  for (const [key, value] of Object.entries(explicit)) {
    if (metadata[key as keyof CdpProfile] !== value) throw new Error(`CDP_PROFILE_CONFIG_CONFLICT:${key}`);
  }
  if (metadata.browserVersion !== managedBrowserIdentity('chromium').fullVersion) throw new Error('CDP_PROFILE_VERSION_MISMATCH');
  return metadata;
}
