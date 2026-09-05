import { describe, expect, it } from 'vitest';
import { CapacityReleaseGate, type BenchmarkResult } from '../../src/acceptance/capacity-release-gate.js';

function successfulResult(): BenchmarkResult {
  return {
    passed: true,
    metrics: {
      createLatencyMs: 10,
      storageWriteLatencyMs: 10,
      listLatencyMs: 10,
      readLatencyMs: 10,
      storageReadLatencyMs: 10,
      memoryUsageMB: 20,
    },
    details: {
      totalAccounts: 2,
      uniqueness: { uniqueIds: 2, uniqueSeeds: 2, proxyBindings: 2, loginStates: 2 },
      failures: [],
    },
  };
}

describe('CapacityReleaseGate', () => {
  it('calibrates and accepts an unchanged successful benchmark', () => {
    const gate = new CapacityReleaseGate();
    const result = successfulResult();
    const baseline = gate.calibrate(result);

    expect(gate.evaluateGate(result, baseline)).toEqual({ passed: true, errors: [] });
  });

  it('rejects malformed and unsupported baselines', () => {
    const gate = new CapacityReleaseGate();
    const baseline = { ...gate.calibrate(successfulResult()), version: 2 };

    const evaluation = gate.evaluateGate(successfulResult(), baseline);
    expect(evaluation.passed).toBe(false);
    expect(evaluation.errors.join(' ')).toContain('Invalid capacity baseline');
  });

  it('rejects every account-isolation mismatch and recorded failure', () => {
    const gate = new CapacityReleaseGate();
    const baseline = gate.calibrate(successfulResult());
    const result = successfulResult();
    result.details.uniqueness.uniqueSeeds = 1;
    result.details.uniqueness.proxyBindings = 1;
    result.details.failures.push('write failed');

    const evaluation = gate.evaluateGate(result, baseline);
    expect(evaluation.passed).toBe(false);
    expect(evaluation.errors).toEqual(expect.arrayContaining([
      'uniqueSeeds mismatch: expected 2, got 1',
      'proxyBindings mismatch: expected 2, got 1',
      'write failed',
    ]));
  });

  it('applies ratio and absolute budgets independently to every benchmark metric', () => {
    const gate = new CapacityReleaseGate();
    const baseline = gate.calibrate(successfulResult());
    const result = successfulResult();
    result.metrics.storageWriteLatencyMs = 21;
    result.metrics.listLatencyMs = 101;
    result.metrics.memoryUsageMB = 41;

    const evaluation = gate.evaluateGate(result, baseline, {
      maxLatencyRatio: 2,
      absoluteMaxLatencyMs: 100,
      maxMemoryRatio: 2,
      absoluteMaxMemoryMB: 100,
    });
    expect(evaluation.passed).toBe(false);
    expect(evaluation.errors.some((error) => error.startsWith('storageWriteLatencyMs regressed'))).toBe(true);
    expect(evaluation.errors.some((error) => error.startsWith('listLatencyMs exceeded absolute maximum'))).toBe(true);
    expect(evaluation.errors.some((error) => error.startsWith('memoryUsageMB regressed'))).toBe(true);
  });

  it('rejects non-finite benchmark input without throwing', () => {
    const gate = new CapacityReleaseGate();
    const baseline = gate.calibrate(successfulResult());
    const result = successfulResult();
    result.metrics.readLatencyMs = Number.NaN;

    const evaluation = gate.evaluateGate(result, baseline);
    expect(evaluation.passed).toBe(false);
    expect(evaluation.errors.join(' ')).toContain('Invalid benchmark result');
  });
});
