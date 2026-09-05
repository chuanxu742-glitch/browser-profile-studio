import { describe, it, expect } from 'vitest';
import { AccountSoakHarness } from '../../scripts/run-account-soak.js';

describe('Account Soak Harness', () => {
  it('should run a small deterministic test cycle and clean up successfully', async () => {
    const harness = new AccountSoakHarness({
      durationMs: 500, // Very short run
      accountCount: 5,
      concurrency: 2,
      checkpointFrequency: 2,
      memoryCeilingMb: 256
    });

    const metrics = await harness.start();
    await harness.cleanup();

    expect(metrics.errors).toBe(0);
    expect(metrics.leaseLeaks).toBe(0);
    expect(metrics.cyclesCompleted).toBeGreaterThan(0);
  });
});
