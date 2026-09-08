import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { BaselineSchema } from '../../src/acceptance/capacity-release-gate.js';

const execFileAsync = promisify(execFile);

describe('Capacity Release Gate', () => {
  it('calibrates a real benchmark and reports incompatible account counts through the CLI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'capacity-release-gate-'));
    const scriptPath = join(process.cwd(), 'scripts/run-capacity-release-gate.ts');
    const baselinePath = join(root, 'baseline.json');
    const options = { env: { ...process.env, BENCHMARK_SMALL_TEST: '1' }, timeout: 60_000 };

    try {
      await execFileAsync(process.execPath, [
        '--import', 'tsx/esm', scriptPath, 'calibrate', baselinePath,
      ], options);

      const baseline = BaselineSchema.parse(JSON.parse(await readFile(baselinePath, 'utf8')));
      expect(baseline.details.totalAccounts).toBe(10);
      expect(baseline.details.uniqueness).toEqual({
        uniqueIds: baseline.details.totalAccounts,
        uniqueSeeds: baseline.details.totalAccounts,
        proxyBindings: baseline.details.totalAccounts,
        loginStates: baseline.details.totalAccounts,
      });
      expect(baseline.details.failures).toEqual([]);

      // Keep measured budgets intact; inconsistent account capacity must fail
      // independently of timing variation between separate benchmark processes.
      baseline.details.totalAccounts = 999;
      baseline.details.uniqueness = {
        uniqueIds: 999,
        uniqueSeeds: 999,
        proxyBindings: 999,
        loginStates: 999,
      };
      await writeFile(baselinePath, JSON.stringify(baseline));

      const failure: unknown = await execFileAsync(process.execPath, [
        '--import', 'tsx/esm', scriptPath, 'gate', baselinePath,
      ], options).then(
        () => { throw new Error('Capacity gate accepted incompatible account counts'); },
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({ code: 1 });
      if (!failure || typeof failure !== 'object' || !('stderr' in failure) || typeof failure.stderr !== 'string') {
        throw new Error('Capacity CLI rejection did not include stderr');
      }
      const report: unknown = JSON.parse(failure.stderr);
      expect(report).toEqual({
        error: expect.any(String),
        issues: expect.arrayContaining([expect.any(String)]),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
