import { describe, expect, it } from 'vitest';
import { CapacityReleaseGate, type BenchmarkResult } from '../../src/acceptance/capacity-release-gate.js';

function successfulResult(totalAccounts = 2): BenchmarkResult {
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
      totalAccounts,
      uniqueness: {
        uniqueIds: totalAccounts,
        uniqueSeeds: totalAccounts,
        proxyBindings: totalAccounts,
        loginStates: totalAccounts,
      },
      failures: [],
    },
  };
}

describe('CapacityReleaseGate', () => {
  it('accepts an unchanged successful benchmark', () => {
    const gate = new CapacityReleaseGate();
    const result = successfulResult();

    expect(gate.evaluateGate(result, gate.calibrate(result))).toEqual({ passed: true, errors: [] });
  });

  it('requires candidate account counts to match the baseline', () => {
    const gate = new CapacityReleaseGate();
    const baseline = gate.calibrate(successfulResult());

    expect(gate.evaluateGate(successfulResult(3), baseline).passed).toBe(false);
    expect(gate.evaluateGate(successfulResult(3), gate.calibrate(successfulResult(3))).passed).toBe(true);
  });

  it('rejects malformed or unsupported baselines', () => {
    const gate = new CapacityReleaseGate();
    const baseline = gate.calibrate(successfulResult());

    for (const candidate of [
      { ...baseline, version: 2 },
      { ...baseline, details: { ...baseline.details, failures: ['baseline failure'] } },
    ]) {
      const evaluation = gate.evaluateGate(successfulResult(), candidate);
      expect(evaluation.passed).toBe(false);
    }
  });

  it('rejects an isolation mismatch on its own', () => {
    const gate = new CapacityReleaseGate();
    const baseline = gate.calibrate(successfulResult());
    const result = successfulResult();
    result.details.uniqueness.uniqueSeeds -= 1;

    const evaluation = gate.evaluateGate(result, baseline);
    expect(evaluation.passed).toBe(false);
  });

  it('rejects a recorded failure on its own', () => {
    const gate = new CapacityReleaseGate();
    const baseline = gate.calibrate(successfulResult());
    const result = successfulResult();
    result.details.failures.push('write failed');

    const evaluation = gate.evaluateGate(result, baseline);
    expect(evaluation.passed).toBe(false);
  });

  it('accepts an inclusive two-times latency ratio and rejects one above it', () => {
    const gate = new CapacityReleaseGate();
    const baseline = gate.calibrate(successfulResult());
    const result = successfulResult();
    result.metrics.createLatencyMs = 20;

    expect(gate.evaluateGate(result, baseline, { maxLatencyRatio: 2 }).passed).toBe(true);
    result.metrics.createLatencyMs = 20.001;
    expect(gate.evaluateGate(result, baseline, { maxLatencyRatio: 2 }).passed).toBe(false);
  });

  it('accepts an inclusive two-times memory ratio and rejects one above it', () => {
    const gate = new CapacityReleaseGate();
    const baseline = gate.calibrate(successfulResult());
    const result = successfulResult();
    result.metrics.memoryUsageMB = 40;

    expect(gate.evaluateGate(result, baseline, { maxMemoryRatio: 2 }).passed).toBe(true);
    result.metrics.memoryUsageMB = 40.001;
    expect(gate.evaluateGate(result, baseline, { maxMemoryRatio: 2 }).passed).toBe(false);
  });

  it('enforces absolute latency and memory limits when ratios are nonbinding', () => {
    const gate = new CapacityReleaseGate();
    const baseline = gate.calibrate(successfulResult());
    const latency = successfulResult();
    latency.metrics.listLatencyMs = 100;
    const memory = successfulResult();
    memory.metrics.memoryUsageMB = 100;

    expect(gate.evaluateGate(latency, baseline, { maxLatencyRatio: 20, absoluteMaxLatencyMs: 100 }).passed).toBe(true);
    latency.metrics.listLatencyMs = 100.001;
    expect(gate.evaluateGate(latency, baseline, { maxLatencyRatio: 20, absoluteMaxLatencyMs: 100 }).passed).toBe(false);
    expect(gate.evaluateGate(memory, baseline, { maxMemoryRatio: 20, absoluteMaxMemoryMB: 100 }).passed).toBe(true);
    memory.metrics.memoryUsageMB = 100.001;
    expect(gate.evaluateGate(memory, baseline, { maxMemoryRatio: 20, absoluteMaxMemoryMB: 100 }).passed).toBe(false);
  });

  it('rejects non-finite benchmark input without throwing', () => {
    const gate = new CapacityReleaseGate();
    const baseline = gate.calibrate(successfulResult());
    const result = successfulResult();
    result.metrics.readLatencyMs = Number.NaN;

    expect(gate.evaluateGate(result, baseline).passed).toBe(false);
  });
});
