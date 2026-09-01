import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveVerifiedFirefoxCore } from '../../src/browser/custom-firefox-runtime.js';
import { managedBrowserIdentity } from '../../src/fingerprint/runtime-identity.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('custom Firefox runtime verification', () => {
  it('accepts an absolute executable whose version lock and SHA-256 match provenance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'abs-custom-firefox-'));
    roots.push(root);
    const executablePath = join(root, 'firefox.exe');
    const bytes = Buffer.from('version-locked-firefox-binary');
    await writeFile(executablePath, bytes);
    await writeFile(join(root, 'build-provenance.json'), JSON.stringify({
      schemaVersion: 1,
      engine: 'firefox',
      browserVersion: managedBrowserIdentity('firefox').fullVersion,
      playwrightVersion: '1.62.1',
      playwrightBrowserRevision: '1538',
      playwrightGitRevision: '26a9e470a7b3c7822084b09fb7f13902c5f37b51',
      mozillaRevision: 'f1b6c0f86b96b7e0688c26f65803576f27cdaf88',
      patches: [{ path: 'patches/0001-service-worker-fingerprint-overrides.patch', sha256: 'acc92765306b6be5557e17e2c130f0546d9fa6545123519aaa7e46922b9300f7' }],
      executableSha256: createHash('sha256').update(bytes).digest('hex'),
    }));

    await expect(resolveVerifiedFirefoxCore({ ABS_FIREFOX_EXECUTABLE_PATH: executablePath })).resolves.toMatchObject({
      executablePath,
      provenance: { engine: 'firefox', browserVersion: managedBrowserIdentity('firefox').fullVersion },
    });
  });

  it('rejects a modified executable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'abs-custom-firefox-'));
    roots.push(root);
    const executablePath = join(root, 'firefox.exe');
    await writeFile(executablePath, 'modified');
    await writeFile(join(root, 'build-provenance.json'), JSON.stringify({
      schemaVersion: 1,
      engine: 'firefox',
      browserVersion: managedBrowserIdentity('firefox').fullVersion,
      playwrightVersion: '1.62.1',
      playwrightBrowserRevision: '1538',
      playwrightGitRevision: '26a9e470a7b3c7822084b09fb7f13902c5f37b51',
      mozillaRevision: 'f1b6c0f86b96b7e0688c26f65803576f27cdaf88',
      patches: [{ path: 'patches/0001-service-worker-fingerprint-overrides.patch', sha256: 'acc92765306b6be5557e17e2c130f0546d9fa6545123519aaa7e46922b9300f7' }],
      executableSha256: '0'.repeat(64),
    }));

    await expect(resolveVerifiedFirefoxCore({ ABS_FIREFOX_EXECUTABLE_PATH: executablePath }))
      .rejects.toThrow('CUSTOM_FIREFOX_INTEGRITY_MISMATCH');
  });
});
