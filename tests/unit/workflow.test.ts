import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_WORKFLOW_STEPS,
  MAX_WORKFLOW_DURATION_MS,
  WorkflowActionIdConflictError,
  WorkflowExecutor,
  type WorkflowAdapter,
  type WorkflowAdapterStatus,
  type WorkflowDefinition,
  type WorkflowTarget,
  executeWorkflow,
  validateWorkflow,
  workflowLimitsForPolicy,
} from '../../src/browser/workflow.js';
import { getAutomationPolicy } from '../../src/browser/automation-policy.js';
import { WorkflowRunner } from '../../src/browser/workflow-runner.js';

const ACTION_ID = '1e2f3a4b-5c6d-4e7f-8a9b-0c1d2e3f4a5b';

function baseWorkflow(...steps: WorkflowDefinition['steps']): WorkflowDefinition {
  return { steps };
}

function adapterFixture(options: {
  status?: () => WorkflowAdapterStatus;
  handlers?: Partial<WorkflowAdapter>;
} = {}): { adapter: WorkflowAdapter; calls: Array<{ op: string; args: unknown[] }> } {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const status = options.status;
  const adapter: WorkflowAdapter = {
    async open(...args) { calls.push({ op: 'open', args }); return { url: args[0], title: 'Done', pageGeneration: 1 }; },
    async click(...args) { calls.push({ op: 'click', args }); return { ref: refFromTarget(args[0]), pageGeneration: 1 }; },
    async type(...args) { calls.push({ op: 'type', args }); return { ref: refFromTarget(args[0]), length: String(args[1]).length, pageGeneration: 1 }; },
    async select(...args) { calls.push({ op: 'select', args }); return { ref: refFromTarget(args[0]), pageGeneration: 1 }; },
    async scroll(...args) { calls.push({ op: 'scroll', args }); return { direction: args[0], amount: args[1], pageGeneration: 1 }; },
    async wait(...args) { calls.push({ op: 'wait', args }); return { waitedMs: 5, conditionMet: true }; },
    async snapshot(...args) { calls.push({ op: 'snapshot', args }); return { snapshotId: 'snp_test_1', pageRevision: 1, format: 'compact', content: 'ref_1 [button] "Done"' }; },
    ...(status ? { status: async () => status() } : {}),
    ...options.handlers,
  };
  return { adapter, calls };
}

function refFromTarget(target: WorkflowTarget): string | undefined {
  return typeof target === 'string' ? target : target.ref;
}
describe('safe declarative workflow', () => {
  it('validates a finite high-level language and rejects selector/script escapes', () => {
    expect(() => validateWorkflow({
      steps: Array.from({ length: DEFAULT_WORKFLOW_STEPS + 1 }, () => ({ op: 'snapshot' })),
    })).toThrow(/at most 50 steps/u);

    expect(() => validateWorkflow({
      steps: [{ op: 'click', target: { selector: '#submit' } }],
    })).toThrow(/unsupported field|semantic strategy/u);

    expect(() => validateWorkflow({
      steps: [{ op: 'script', code: 'page.evaluate(() => document.cookie)' }],
    })).toThrow(/one of open/u);

    expect(() => validateWorkflow({
      steps: [{ op: 'wait', condition: { expression: 'true' } }],
    })).toThrow(/unsupported field|ref/u);

    expect(() => validateWorkflow({
      steps: [{ op: 'click', target: 'button#submit' }],
    })).toThrow(/opaque snapshot refs/u);
    expect(() => validateWorkflow({
      steps: [{ op: 'scroll', direction: 'down', amount: 21 }],
    })).toThrow(/integer from 1 to 10/u);
    expect(() => validateWorkflow({
      steps: [{ op: 'scroll', direction: 'down', amount: 4 }],
    }, {
      limits: workflowLimitsForPolicy(getAutomationPolicy('strict').limits),
    })).toThrow(/integer from 1 to 3/u);
  });

  it('executes every allowed operation through the injected adapter', async () => {
    const { adapter, calls } = adapterFixture();
    const result = await executeWorkflow(adapter, baseWorkflow(
      { op: 'open', url: 'https://example.test/orders?secret=do-not-return' },
      { op: 'click', target: { role: 'button', name: 'Apply' } },
      { op: 'type', target: { label: 'Search' }, text: 'literal-${value}', sensitive: true },
      { op: 'select', target: { ref: 'ref_1' }, value: 'paid' },
      { op: 'scroll', direction: 'down', amount: 2, target: 'ref_1' },
      { op: 'wait', milliseconds: 1 },
      { op: 'snapshot', format: 'compact', maxBytes: 2_000 },
    ));

    expect(result.ok).toBe(true);
    expect(result.stopReason).toBe('completed');
    expect(result.steps).toHaveLength(7);
    expect(result.resultBytes).toBe(Buffer.byteLength(JSON.stringify(result), 'utf8'));
    expect(calls.map((call) => call.op)).toEqual(['open', 'click', 'type', 'select', 'scroll', 'wait', 'snapshot']);
    expect(calls[2]?.args[1]).toBe('literal-${value}');
    expect(result.steps[0]?.summary).toMatchObject({ kind: 'open', url: 'https://example.test/orders' });
    expect(result.steps[2]?.summary).toMatchObject({ kind: 'type', length: 16 });
    expect(JSON.stringify(result)).not.toContain('literal-${value}');
    expect(JSON.stringify(result)).not.toContain('do-not-return');
  });

  it('passes outer actionId and expected revision only to the first write', async () => {
    const { adapter, calls } = adapterFixture({
      status: () => ({ pageRevision: 4, challenge: { detected: false }, interrupts: { latestSequence: 0, total: 0 } }),
    });
    const executor = new WorkflowExecutor(adapter);
    const result = await executor.run({
      actionId: ACTION_ID,
      expectedPageRevision: 4,
      steps: [
        { op: 'snapshot' },
        { op: 'click', target: { ref: 'ref_1' } },
        { op: 'type', target: { ref: 'ref_2' }, text: 'secret input' },
      ],
    });

    expect(result.ok).toBe(true);
    const clickOptions = calls[1]?.args[1] as Record<string, unknown>;
    const typeOptions = calls[2]?.args[2] as Record<string, unknown>;
    expect(clickOptions.actionId).toBe(ACTION_ID);
    expect(clickOptions.expectedPageRevision).toBe(4);
    expect(typeOptions.actionId).toBeUndefined();
    expect(typeOptions.expectedPageRevision).toBeUndefined();
  });

  it('is idempotent for the same outer action and rejects a conflicting reuse', async () => {
    let clickCount = 0;
    const { adapter } = adapterFixture({
      handlers: {
        async click(...args) {
          clickCount += 1;
          return { ref: refFromTarget(args[0]), pageGeneration: 1 };
        },
      },
    });
    const executor = new WorkflowExecutor(adapter);
    const first = await executor.run({ actionId: ACTION_ID, steps: [{ op: 'click', target: { ref: 'ref_1' } }] });
    const second = await executor.run({ actionId: ACTION_ID, steps: [{ op: 'click', target: { ref: 'ref_1' } }] });
    expect(clickCount).toBe(1);
    expect(second).toEqual(first);

    await expect(executor.run({ actionId: ACTION_ID, steps: [{ op: 'click', target: { ref: 'ref_2' } }] })).rejects.toBeInstanceOf(WorkflowActionIdConflictError);
  });

  it('returns a safe challenge summary and stops before later steps', async () => {
    const { adapter, calls } = adapterFixture({
      handlers: {
        async click() {
          calls.push({ op: 'click', args: [] });
          const error = new Error('secret page contents must not escape') as Error & { code: string; retryable: boolean };
          error.code = 'SESSION_PAUSED_CHALLENGE';
          error.retryable = false;
          throw error;
        },
      },
    });
    const result = await executeWorkflow(adapter, baseWorkflow(
      { op: 'click', target: { ref: 'ref_1' } },
      { op: 'type', target: { ref: 'ref_2' }, text: 'password' },
    ));

    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe('challenge');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.error).toMatchObject({ code: 'SESSION_PAUSED_CHALLENGE' });
    expect(JSON.stringify(result)).not.toContain('secret page contents');
    expect(calls.map((call) => call.op)).toEqual(['click']);
  });

  it('stops on an interrupt observed in the adapter status projection', async () => {
    let interrupted = false;
    const { adapter, calls } = adapterFixture({
      status: () => interrupted
        ? { pageRevision: 1, challenge: { detected: false }, interrupts: { latestSequence: 1, total: 1, recent: [{ sequence: 1, type: 'DIALOG_BLOCKED' }] } }
        : { pageRevision: 1, challenge: { detected: false }, interrupts: { latestSequence: 0, total: 0 } },
      handlers: {
        async click(...args) {
          calls.push({ op: 'click', args });
          interrupted = true;
          return { ref: refFromTarget(args[0]), pageGeneration: 1 };
        },
      },
    });
    const result = await executeWorkflow(adapter, baseWorkflow(
      { op: 'click', target: { ref: 'ref_1' } },
      { op: 'snapshot' },
    ));

    expect(result.stopReason).toBe('interrupt');
    expect(result.steps).toHaveLength(1);
    expect(calls.map((call) => call.op)).toEqual(['click']);
  });

  it('continues after an omitted optional dialog interrupt', async () => {
    let interrupted = false;
    const { adapter, calls } = adapterFixture({
      status: () => interrupted
        ? { pageRevision: 1, challenge: { detected: false }, interrupts: { latestSequence: 1, total: 1, recent: [{ sequence: 1, type: 'DIALOG_BLOCKED' }] } }
        : { pageRevision: 1, challenge: { detected: false }, interrupts: { latestSequence: 0, total: 0 } },
      handlers: {
        async click(...args) {
          calls.push({ op: 'click', args });
          interrupted = true;
          return { ref: refFromTarget(args[0]), pageGeneration: 1 };
        },
      },
    });
    const result = await executeWorkflow(adapter, {
      stopOn: ['navigation'],
      steps: [
        { op: 'click', target: { ref: 'ref_1' } },
        { op: 'snapshot' },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.stopReason).toBe('completed');
    expect(calls.map((call) => call.op)).toEqual(['click', 'snapshot']);
  });

  it('rejects a stale outer revision before invoking a write', async () => {
    const { adapter, calls } = adapterFixture({
      status: () => ({ pageRevision: 9, challenge: { detected: false }, interrupts: { latestSequence: 0, total: 0 } }),
    });
    const result = await executeWorkflow(adapter, {
      expectedPageRevision: 8,
      steps: [{ op: 'click', target: { ref: 'ref_1' } }],
    });

    expect(result.stopReason).toBe('revision_mismatch');
    expect(result.steps).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('enforces the total deadline and reports timeout without leaking input', async () => {
    vi.useFakeTimers();
    try {
      const { adapter } = adapterFixture({
        handlers: {
          async click() { return await new Promise<never>(() => undefined); },
        },
      });
      const pending = executeWorkflow(adapter, {
        maxDurationMs: 50,
        steps: [{ op: 'click', target: { ref: 'ref_1' } }],
      });
      await vi.advanceTimersByTimeAsync(55);
      const result = await pending;
      expect(result.stopReason).toBe('timeout');
      expect(result.steps[0]?.error?.code).toBe('WORKFLOW_TIMEOUT');
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds the complete result, including large snapshot content', async () => {
    const content = '界'.repeat(10_000);
    const { adapter } = adapterFixture({
      handlers: {
        async snapshot() { return { snapshotId: 'snp_test_1', pageRevision: 1, format: 'compact', content }; },
      },
    });
    const result = await executeWorkflow(adapter, {
      maxResultBytes: 600,
      steps: [{ op: 'snapshot' }],
    });

    expect(result.truncated).toBe(true);
    expect(result.resultBytes).toBeLessThanOrEqual(600);
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(600);
    expect((result.steps[0]?.summary as { content?: string } | undefined)?.content?.length ?? 0).toBeLessThan(content.length);
  });

  it('keeps the defensive wire bound for the smallest accepted budget', async () => {
    const { adapter } = adapterFixture();
    const result = await executeWorkflow(adapter, { maxResultBytes: 100, steps: [{ op: 'snapshot' }] });
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(100);
  });

  it('keeps the hard duration ceiling even when callers request more', () => {
    expect(() => validateWorkflow({
      maxDurationMs: MAX_WORKFLOW_DURATION_MS + 1,
      steps: [{ op: 'snapshot' }],
    }, {
      limits: workflowLimitsForPolicy(getAutomationPolicy('trusted-local').limits),
    })).toThrow(/maxDurationMs/u);
  });

  it('runner enforces the selected profile step bound before invoking the adapter', async () => {
    const { adapter, calls } = adapterFixture();
    const runner = new WorkflowRunner(adapter);
    await expect(runner.run({ steps: Array.from({ length: DEFAULT_WORKFLOW_STEPS + 1 }, () => ({ op: 'snapshot' })) })).rejects.toMatchObject({
      code: 'WORKFLOW_STEP_LIMIT_EXCEEDED',
      path: 'workflow.steps',
    });
    expect(calls).toHaveLength(0);
  });

  it('applies profile-specific workflow ceilings before adapter dispatch', () => {
    const standard = validateWorkflow({
      steps: Array.from({ length: 11 }, () => ({ op: 'snapshot' })),
    });
    expect(standard.steps).toHaveLength(11);

    const strictLimits = workflowLimitsForPolicy(getAutomationPolicy('strict').limits);
    expect(() => validateWorkflow({
      steps: Array.from({ length: 11 }, () => ({ op: 'snapshot' })),
    }, { limits: strictLimits })).toThrow(/at most 10 steps/u);
    expect(() => validateWorkflow({
      maxDurationMs: 30_001,
      steps: [{ op: 'snapshot' }],
    }, { limits: strictLimits })).toThrow(/maxDurationMs/u);

    const trusted = validateWorkflow({
      maxDurationMs: 5 * 60_000,
      maxResultBytes: 1_024 * 1_024,
      steps: [
        { op: 'scroll', direction: 'down', amount: 20 },
        { op: 'snapshot', maxBytes: 1_024 * 1_024 },
      ],
    }, { limits: workflowLimitsForPolicy(getAutomationPolicy('trusted-local').limits) });
    expect(trusted.steps).toHaveLength(2);
  });

  it('runner serializes multi-select values and captures a bounded stop snapshot', async () => {
    let interrupted = false;
    let selectCount = 0;
    const { adapter, calls } = adapterFixture({
      status: () => interrupted
        ? { pageRevision: 1, challenge: { detected: false }, interrupts: { latestSequence: 1, total: 1, recent: [{ sequence: 1, type: 'DIALOG_BLOCKED' }] } }
        : { pageRevision: 1, challenge: { detected: false }, interrupts: { latestSequence: 0, total: 0 } },
      handlers: {
        async select(...args) {
          calls.push({ op: 'select', args });
          selectCount += 1;
          if (selectCount === 2) interrupted = true;
          return { ref: refFromTarget(args[0]), pageRevision: 1 };
        },
      },
    });
    const runner = new WorkflowRunner(adapter);
    const result = await runner.run({
      steps: [{ op: 'select', target: { ref: 'ref_choice' }, values: ['paid', 'shipped'] }],
    });

    expect(result.status).toBe('stopped');
    expect(result.stopReason).toBe('interrupt');
    expect(result.stoppedReason).toBe('interrupt');
    expect(result.snapshot).toMatchObject({ snapshotId: 'snp_test_1' });
    expect(calls.map((call) => call.op)).toEqual(['select', 'select', 'snapshot']);
  });
});
