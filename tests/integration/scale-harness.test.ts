import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

describe('Account Scale Benchmark Harness', () => {
  it('checks isolated metadata and login state without launching browsers', () => {
    const scriptPath = join(process.cwd(), 'scripts', 'run-account-scale-benchmark.ts');
    const execution = spawnSync(process.execPath, ['--import', 'tsx/esm', scriptPath], {
      env: {
        ...process.env,
        BENCHMARK_SMALL_TEST: '1',
      },
      encoding: 'utf-8',
      timeout: 30_000,
    });
    if (execution.status !== 0) {
      throw new Error(`Benchmark failed: ${execution.stderr || execution.stdout}`);
    }

    const result = JSON.parse(execution.stdout) as {
      passed: boolean;
      metrics: Record<string, unknown>;
      details: {
        totalAccounts: number;
        uniqueness: Record<string, unknown>;
        failures: unknown[];
      };
    };

    expect(result.passed).toBe(true);
    expect(result.details.totalAccounts).toBe(10);
    expect(result.details.uniqueness).toMatchObject({
      uniqueIds: 10,
      uniqueSeeds: 10,
      proxyBindings: 10,
      loginStates: 10,
    });
    expect(result.metrics).toMatchObject({
      createLatencyMs: expect.any(Number),
      storageWriteLatencyMs: expect.any(Number),
      listLatencyMs: expect.any(Number),
      readLatencyMs: expect.any(Number),
      storageReadLatencyMs: expect.any(Number),
      memoryUsageMB: expect.any(Number),
    });
    expect(result.details.failures).toEqual([]);
  });
});
