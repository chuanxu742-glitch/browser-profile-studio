import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  CapacityReleaseGate,
  BenchmarkResultSchema,
  type BenchmarkResult,
  type GateConfig,
} from '../src/acceptance/capacity-release-gate.js';

const execFileAsync = promisify(execFile);

function readPositiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number`);
  return value;
}

function parseBenchmarkOutput(stdout: string): BenchmarkResult {
  const output = stdout.trim();
  try {
    return BenchmarkResultSchema.parse(JSON.parse(output));
  } catch (directError) {
    const firstBrace = output.indexOf('{');
    const lastBrace = output.lastIndexOf('}');
    if (firstBrace < 0 || lastBrace <= firstBrace) throw directError;
    return BenchmarkResultSchema.parse(JSON.parse(output.slice(firstBrace, lastBrace + 1)));
  }
}

async function runBenchmark(smallTest: boolean): Promise<BenchmarkResult> {
  const scriptPath = resolve(process.cwd(), 'scripts/run-account-scale-benchmark.ts');
  const env = { ...process.env, ...(smallTest ? { BENCHMARK_SMALL_TEST: '1' } : {}) };
  try {
    const { stdout } = await execFileAsync(process.execPath, ['--import', 'tsx/esm', scriptPath], {
      env,
      timeout: 10 * 60 * 1_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    return parseBenchmarkOutput(stdout);
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string' && error.stdout.trim()) {
      return parseBenchmarkOutput(error.stdout);
    }
    throw new Error(`Benchmark execution failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function gateConfig(smallTest: boolean): GateConfig {
  return {
    maxLatencyRatio: readPositiveNumber('CAPACITY_MAX_LATENCY_RATIO', smallTest ? 10 : 1.5),
    absoluteMaxLatencyMs: readPositiveNumber('CAPACITY_MAX_LATENCY_MS', smallTest ? 5_000 : 60_000),
    maxMemoryRatio: readPositiveNumber('CAPACITY_MAX_MEMORY_RATIO', smallTest ? 10 : 1.5),
    absoluteMaxMemoryMB: readPositiveNumber('CAPACITY_MAX_MEMORY_MB', 2_048),
  };
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== 'calibrate' && mode !== 'gate') {
    console.error(JSON.stringify({ error: 'Usage: npm run capacity:release -- <calibrate|gate> [baseline-path]' }));
    process.exitCode = 1;
    return;
  }

  const baselinePath = resolve(process.cwd(), process.argv[3] ?? 'capacity-baseline.json');
  const smallTest = process.env.BENCHMARK_SMALL_TEST === '1';
  const gate = new CapacityReleaseGate();

  if (mode === 'calibrate') {
    const baseline = gate.calibrate(await runBenchmark(smallTest));
    const temporaryPath = `${baselinePath}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(dirname(baselinePath), { recursive: true });
    try {
      await writeFile(temporaryPath, `${JSON.stringify(baseline, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, baselinePath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
    console.log(JSON.stringify({ success: true, mode, baselinePath }));
    return;
  }

  let baselineInput: unknown;
  try {
    baselineInput = JSON.parse(await readFile(baselinePath, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to read capacity baseline: ${error instanceof Error ? error.message : String(error)}`);
  }
  const evaluation = gate.evaluateGate(await runBenchmark(smallTest), baselineInput, gateConfig(smallTest));
  if (!evaluation.passed) {
    console.error(JSON.stringify({ error: 'Capacity gate failed', issues: evaluation.errors }));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ success: true, mode, baselinePath }));
}

void main().catch((error: unknown) => {
  console.error(JSON.stringify({ error: 'Capacity release command failed', details: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
