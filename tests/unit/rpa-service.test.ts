import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RpaService } from '../../src/rpa/service.js';
import type { SessionManager } from '../../src/browser/session-manager.js';

describe('RpaService', () => {
  let root: string | undefined;
  let service: RpaService | undefined;
  afterEach(async () => { await service?.shutdown(); if (root) await rm(root, { recursive: true, force: true }); service = undefined; root = undefined; });

  it('persists workflows, executes semantic steps and records task logs', async () => {
    root = await mkdtemp(join(tmpdir(), 'rpa-'));
    const calls: string[] = [];
    const manager = {
      start: async () => ({ sessionId: 'ses_fake' }),
      open: async (_sid: string, url: string) => { calls.push(`open:${url}`); },
      snapshot: async () => { calls.push('snapshot'); },
      stop: async () => { calls.push('stop'); },
    } as unknown as SessionManager;
    service = new RpaService(manager, join(root, 'state.json'));
    const workflow = await service.createWorkflow({ name: 'Check', steps: [{ op: 'open', url: 'https://example.com' }, { op: 'snapshot' }] });
    const task = await service.run({ workflowId: workflow.workflowId, profileId: 'profile-one' });
    let completed = await service.getTask(task.taskId);
    for (let attempt = 0; attempt < 500 && completed?.state !== 'SUCCEEDED'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      completed = await service.getTask(task.taskId);
    }
    expect(completed?.state).toBe('SUCCEEDED');
    expect(completed?.completedSteps).toBe(2);
    expect(completed?.logs.map((entry) => entry.event)).toContain('succeeded');
    expect(calls).toEqual(['open:https://example.com', 'snapshot', 'stop']);

    // Flush the first service's serialized state writes before another service
    // opens the same single-writer state file (Windows rejects overlapping renames).
    await service.shutdown();
    service = undefined;
    const reloaded = new RpaService(manager, join(root, 'state.json'));
    expect((await reloaded.listWorkflows())[0]?.workflowId).toBe(workflow.workflowId);
    await reloaded.shutdown();
  });

  it('cancels a future scheduled task', async () => {
    root = await mkdtemp(join(tmpdir(), 'rpa-cancel-'));
    service = new RpaService({} as SessionManager, join(root, 'state.json'));
    const workflow = await service.createWorkflow({ name: 'Later', steps: [{ op: 'snapshot' }] });
    const queued = await service.run({ workflowId: workflow.workflowId, profileId: 'profile-one', scheduledAt: Date.now() + 60_000 });
    expect((await service.cancel(queued.taskId)).state).toBe('CANCELLED');
  });

  it('supports variables, conditions, loops, retry policy and screenshot artifacts', async () => {
    root = await mkdtemp(join(tmpdir(), 'rpa-control-flow-'));
    const calls: string[] = []; let failures = 0;
    const manager = {
      start: async () => ({ sessionId: 'ses_flow' }),
      open: async (_sid: string, url: string) => { calls.push(`open:${url}`); },
      snapshot: async () => ({ text: 'ok' }),
      screenshot: async () => ({ artifactRef: 'art_one', image: { data: '', mimeType: 'image/png' } }),
      click: async () => { failures += 1; if (failures === 1) throw new Error('temporary'); calls.push('click'); },
      stop: async () => { calls.push('stop'); },
    } as unknown as SessionManager;
    service = new RpaService(manager, join(root, 'state.json'));
    const workflow = await service.createWorkflow({ name: 'Flow', steps: [
      { op: 'set', variable: 'region', value: 'us' },
      { op: 'if', condition: { variable: 'region', operator: 'equals', value: 'us' }, then: [{ op: 'open', url: 'https://example.com/{{region}}' }] },
      { op: 'repeat', times: 2, steps: [{ op: 'snapshot', saveAs: 'snapshot' }] },
      { op: 'click', target: { role: 'button', name: 'Run' }, retry: { attempts: 2, delayMs: 0 } },
      { op: 'screenshot', saveAs: 'image' },
    ] });
    const queued = await service.run({ workflowId: workflow.workflowId, profileId: 'profile-one' });
    let task = await service.getTask(queued.taskId);
    for (let attempt = 0; attempt < 500 && task?.state !== 'SUCCEEDED'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      task = await service.getTask(queued.taskId);
    }
    expect(task?.state).toBe('SUCCEEDED');
    expect(task?.variables).toMatchObject({ region: 'us', image: 'art_one' });
    expect(task?.artifacts[0]?.artifactRef).toBe('art_one');
    expect(task?.logs.some((entry) => entry.event === 'step_attempt_failed')).toBe(true);
    expect(calls).toContain('open:https://example.com/us');
    expect(calls).toContain('click');
  });
});
