import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { managedBrowserIdentity } from '../fingerprint/runtime-identity.js';

interface FirefoxBuildProvenance {
  readonly schemaVersion?: number;
  readonly engine?: string;
  readonly browserVersion?: string;
  readonly playwrightVersion?: string;
  readonly playwrightBrowserRevision?: string;
  readonly mozillaRevision?: string;
  readonly playwrightGitRevision?: string;
  readonly patches?: ReadonlyArray<{ readonly path?: string; readonly sha256?: string }>;
  readonly executableSha256?: string;
}

const EXPECTED_FIREFOX_CORE = Object.freeze({
  playwrightVersion: '1.62.1',
  playwrightBrowserRevision: '1538',
  playwrightGitRevision: '26a9e470a7b3c7822084b09fb7f13902c5f37b51',
  mozillaRevision: 'f1b6c0f86b96b7e0688c26f65803576f27cdaf88',
  patchPath: 'patches/0001-service-worker-fingerprint-overrides.patch',
  patchSha256: 'acc92765306b6be5557e17e2c130f0546d9fa6545123519aaa7e46922b9300f7',
});

export interface VerifiedFirefoxCore {
  readonly executablePath: string;
  readonly provenancePath: string;
  readonly provenance: FirefoxBuildProvenance;
}

export async function resolveVerifiedFirefoxCore(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<VerifiedFirefoxCore | undefined> {
  const configuredPath = environment.ABS_FIREFOX_EXECUTABLE_PATH?.trim();
  if (!configuredPath) return undefined;
  if (!isAbsolute(configuredPath)) {
    throw new Error('CUSTOM_FIREFOX_PATH_INVALID: ABS_FIREFOX_EXECUTABLE_PATH must be absolute');
  }

  const executablePath = await realpath(configuredPath).catch(() => {
    throw new Error(`CUSTOM_FIREFOX_NOT_FOUND: ${configuredPath}`);
  });
  const executableStat = await stat(executablePath);
  if (!executableStat.isFile()) throw new Error(`CUSTOM_FIREFOX_NOT_FILE: ${executablePath}`);

  const configuredProvenance = environment.ABS_FIREFOX_PROVENANCE_PATH?.trim();
  if (configuredProvenance && !isAbsolute(configuredProvenance)) {
    throw new Error('CUSTOM_FIREFOX_PROVENANCE_PATH_INVALID: path must be absolute');
  }
  const provenancePath = configuredProvenance || join(dirname(executablePath), 'build-provenance.json');
  const raw = await readFile(provenancePath, 'utf8').catch(() => {
    throw new Error(`CUSTOM_FIREFOX_PROVENANCE_MISSING: ${provenancePath}`);
  });
  let provenance: FirefoxBuildProvenance;
  try {
    provenance = JSON.parse(raw.replace(/^\uFEFF/, '')) as FirefoxBuildProvenance;
  } catch {
    throw new Error(`CUSTOM_FIREFOX_PROVENANCE_INVALID: ${provenancePath}`);
  }

  const expectedVersion = managedBrowserIdentity('firefox').fullVersion;
  if (provenance.schemaVersion !== 1 || provenance.engine !== 'firefox' || provenance.browserVersion !== expectedVersion) {
    throw new Error(`CUSTOM_FIREFOX_PROVENANCE_MISMATCH: expected Firefox ${expectedVersion}`);
  }
  const expectedPatch = provenance.patches?.find((patch) => patch.path === EXPECTED_FIREFOX_CORE.patchPath);
  if (
    provenance.playwrightVersion !== EXPECTED_FIREFOX_CORE.playwrightVersion
    || provenance.playwrightBrowserRevision !== EXPECTED_FIREFOX_CORE.playwrightBrowserRevision
    || provenance.playwrightGitRevision !== EXPECTED_FIREFOX_CORE.playwrightGitRevision
    || provenance.mozillaRevision !== EXPECTED_FIREFOX_CORE.mozillaRevision
    || expectedPatch?.sha256?.toLowerCase() !== EXPECTED_FIREFOX_CORE.patchSha256
  ) {
    throw new Error('CUSTOM_FIREFOX_SOURCE_LOCK_MISMATCH: build provenance does not match the pinned source and patch set');
  }
  if (!/^[a-f0-9]{64}$/i.test(provenance.executableSha256 ?? '')) {
    throw new Error('CUSTOM_FIREFOX_PROVENANCE_HASH_INVALID');
  }
  const actualHash = createHash('sha256').update(await readFile(executablePath)).digest('hex');
  if (actualHash !== provenance.executableSha256!.toLowerCase()) {
    throw new Error('CUSTOM_FIREFOX_INTEGRITY_MISMATCH: executable SHA-256 differs from build provenance');
  }

  return { executablePath, provenancePath, provenance };
}
