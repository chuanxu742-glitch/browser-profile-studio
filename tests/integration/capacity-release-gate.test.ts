import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const execFileAsync = promisify(execFile);

describe('Capacity Release Gate', () => {
  const scriptPath = join(process.cwd(), 'scripts/run-capacity-release-gate.ts');
  const tempBaseline = join(process.cwd(), 'tests', 'integration', 'temp-baseline.json');

  // Clean up before and after tests
  const cleanup = async () => {
    try {
      await rm(tempBaseline, { force: true });
    } catch {}
  };

  it('should execute benchmark and reject regressions in count/isolation/latencies/memory', async () => {
    await cleanup();

    // 1. Calibrate baseline
    const { stdout: calStdout } = await execFileAsync(process.execPath, [
      '--import', 'tsx/esm', scriptPath, 'calibrate', tempBaseline
    ], {
      env: { ...process.env, BENCHMARK_SMALL_TEST: '1' },
      timeout: 60000,
    });

    let calResult;
    try {
      // It might have console.logs, so we just check if it generated a file
      expect(existsSync(tempBaseline)).toBe(true);
      const baselineData = JSON.parse(readFileSync(tempBaseline, 'utf8'));
      expect(baselineData.version).toBe(1);
      expect(baselineData.details.totalAccounts).toBe(10);
    } catch (err) {
      console.error('Failed in calibration step:', calStdout);
      throw err;
    }

    // 2. Evaluate gate (should pass against its own baseline)
    const { stdout: gateStdout } = await execFileAsync(process.execPath, [
      '--import', 'tsx/esm', scriptPath, 'gate', tempBaseline
    ], {
      env: { ...process.env, BENCHMARK_SMALL_TEST: '1' },
      timeout: 60000,
    });

    const lines = gateStdout.trim().split('\n');
    let gateResultStr = lines[lines.length - 1] || '{}';
    let gateResult = JSON.parse(gateResultStr);

    expect(gateResult.success).toBe(true);
    expect(gateResult.mode).toBe('gate');

    // 3. Use a structurally valid but impossible baseline to force count and ratio regressions.
    const baselineData = JSON.parse(readFileSync(tempBaseline, 'utf8'));
    for (const metric of ['createLatencyMs', 'storageWriteLatencyMs', 'listLatencyMs', 'readLatencyMs', 'storageReadLatencyMs']) {
      baselineData.metrics[metric] = 0.001;
    }
    baselineData.metrics.memoryUsageMB = 0.001;
    baselineData.details.totalAccounts = 999;
    baselineData.details.uniqueness = {
      uniqueIds: 999,
      uniqueSeeds: 999,
      proxyBindings: 999,
      loginStates: 999,
    };
    writeFileSync(tempBaseline, JSON.stringify(baselineData));
    let failed = false;
    try {
      await execFileAsync(process.execPath, [
        '--import', 'tsx/esm', scriptPath, 'gate', tempBaseline
      ], {
        env: { ...process.env, BENCHMARK_SMALL_TEST: '1' },
        timeout: 60000,
      });
    } catch (error: unknown) {
      failed = true;
      if (error && typeof error === 'object' && 'code' in error && 'stdout' in error && 'stderr' in error) {
        expect(error.code).toBe(1);
        
        const stdoutLines = String(error.stdout).trim().split('\n');
        const stderrLines = String(error.stderr).trim().split('\n');
      
      // stderr might have the json payload
      let resultStr = stderrLines[stderrLines.length - 1];
      if (!resultStr || !resultStr.startsWith('{')) {
        resultStr = stdoutLines[stdoutLines.length - 1];
      }
      if (resultStr && resultStr.startsWith('{')) {
         const res = JSON.parse(resultStr);
         expect(res.error).toBeDefined();
         expect(res.issues).toBeDefined();
         expect(res.issues.some((i: string) => i.includes('Total accounts mismatch'))).toBe(true);
      }
      }
    }
    
    expect(failed).toBe(true);

    await cleanup();
  }, 120000); // 120s timeout for the entire suite
});
