import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { SessionManager } from '../browser/session-manager.js';
import type { SemanticTarget } from '../browser/semantic-snapshot.js';
import { atomicWriteFile, readJsonWithBackup } from '../storage/atomic-file.js';

export interface RpaStepPolicy { readonly retry?: { readonly attempts?: number; readonly delayMs?: number }; readonly onError?: 'stop' | 'continue'; }
export interface RpaCondition { readonly variable: string; readonly operator: 'equals' | 'notEquals' | 'exists' | 'contains'; readonly value?: string | number | boolean; }

export type RpaStep = (
  | { op: 'open'; url: string }
  | { op: 'click'; target: SemanticTarget }
  | { op: 'type'; target: SemanticTarget; text: string; clearFirst?: boolean }
  | { op: 'select'; target: SemanticTarget; value?: string; label?: string }
  | { op: 'scroll'; direction: 'up' | 'down'; amount?: number }
  | { op: 'wait'; milliseconds: number }
  | { op: 'snapshot'; saveAs?: string }
  | { op: 'screenshot'; fullPage?: boolean; saveAs?: string }
  | { op: 'set'; variable: string; value: string | number | boolean }
  | { op: 'if'; condition: RpaCondition; then: readonly RpaStep[]; else?: readonly RpaStep[] }
  | { op: 'repeat'; times: number; steps: readonly RpaStep[] }
) & RpaStepPolicy;

export interface RpaWorkflow {
  readonly workflowId: string;
  readonly name: string;
  readonly description?: string;
  readonly steps: readonly RpaStep[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly version: number;
}

export interface RpaTask {
  readonly taskId: string;
  readonly workflowId: string;
  readonly profileId: string;
  state: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  readonly createdAt: number;
  updatedAt: number;
  scheduledAt?: number;
  intervalMs?: number;
  sessionId?: string;
  completedSteps: number;
  errorCode?: string;
  variables: Record<string, string | number | boolean>;
  artifacts: Array<{ at: number; artifactRef: string; step?: number }>;
  logs: Array<{ at: number; event: string; step?: number; message?: string }>;
}

interface PersistedRpaState { workflows: RpaWorkflow[]; tasks: RpaTask[]; }

export class RpaService {
  private workflows = new Map<string, RpaWorkflow>();
  private tasks = new Map<string, RpaTask>();
  private timers = new Map<string, NodeJS.Timeout>();
  private loaded = false;
  private writeTail: Promise<void> = Promise.resolve();

  public constructor(private readonly manager: SessionManager, private readonly path: string) {}

  public async listWorkflows(): Promise<RpaWorkflow[]> {
    await this.load();
    return [...this.workflows.values()].map(cloneWorkflow).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  public async createWorkflow(input: { name: string; description?: string; steps: readonly RpaStep[] }): Promise<RpaWorkflow> {
    await this.load();
    const name = input.name?.trim();
    if (!name) throw new Error('WORKFLOW_NAME_REQUIRED');
    validateSteps(input.steps);
    const now = Date.now();
    const workflow: RpaWorkflow = {
      workflowId: `rpa_${randomUUID().slice(0, 8)}`,
      name,
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      steps: input.steps.map(cloneStep),
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    this.workflows.set(workflow.workflowId, workflow);
    await this.persist();
    return cloneWorkflow(workflow);
  }

  public async deleteWorkflow(workflowId: string): Promise<boolean> {
    await this.load();
    const deleted = this.workflows.delete(workflowId);
    if (deleted) await this.persist();
    return deleted;
  }

  public async updateWorkflow(workflowId: string, input: { name?: string; description?: string; steps?: readonly RpaStep[] }): Promise<RpaWorkflow> {
    await this.load();
    const existing = this.workflows.get(workflowId);
    if (!existing) throw new Error('WORKFLOW_NOT_FOUND');
    const name = input.name === undefined ? existing.name : input.name.trim();
    if (!name) throw new Error('WORKFLOW_NAME_REQUIRED');
    const steps = input.steps === undefined ? existing.steps : input.steps;
    validateSteps(steps);
    const updated: RpaWorkflow = {
      ...existing,
      name,
      ...(input.description !== undefined ? (input.description.trim() ? { description: input.description.trim() } : { description: undefined }) : {}),
      steps: steps.map(cloneStep),
      updatedAt: Date.now(),
      version: (existing.version ?? 1) + 1,
    } as RpaWorkflow;
    this.workflows.set(workflowId, updated);
    await this.persist();
    return cloneWorkflow(updated);
  }

  public async listTasks(): Promise<RpaTask[]> {
    await this.load();
    return [...this.tasks.values()].map(cloneTask).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 500);
  }

  public async getTask(taskId: string): Promise<RpaTask | undefined> {
    await this.load();
    const task = this.tasks.get(taskId);
    return task ? cloneTask(task) : undefined;
  }

  public async run(input: {
    workflowId: string;
    profileId: string;
    headless?: boolean;
    scheduledAt?: number;
    intervalMs?: number;
    variables?: Readonly<Record<string, string | number | boolean>>;
  }): Promise<RpaTask> {
    await this.load();
    if (!this.workflows.has(input.workflowId)) throw new Error('WORKFLOW_NOT_FOUND');
    if (!input.profileId?.trim()) throw new Error('PROFILE_REQUIRED');
    if (input.scheduledAt !== undefined && !Number.isFinite(input.scheduledAt)) throw new Error('SCHEDULE_INVALID');
    if (input.intervalMs !== undefined && !Number.isFinite(input.intervalMs)) throw new Error('INTERVAL_INVALID');
    const now = Date.now();
    const scheduledAt = input.scheduledAt === undefined ? now : Math.max(now, input.scheduledAt);
    const intervalMs = input.intervalMs === undefined ? undefined : Math.max(60_000, Math.min(30 * 24 * 60 * 60_000, input.intervalMs));
    const task: RpaTask = {
      taskId: `tsk_${randomUUID().slice(0, 10)}`,
      workflowId: input.workflowId,
      profileId: input.profileId,
      state: 'QUEUED',
      createdAt: now,
      updatedAt: now,
      ...(scheduledAt > now ? { scheduledAt } : {}),
      ...(intervalMs !== undefined ? { intervalMs } : {}),
      completedSteps: 0,
      variables: { ...(input.variables ?? {}) },
      artifacts: [],
      logs: [{ at: now, event: scheduledAt > now ? 'scheduled' : 'queued' }],
    };
    this.tasks.set(task.taskId, task);
    await this.persist();
    this.schedule(task.taskId, Math.max(0, scheduledAt - now), input.headless ?? true);
    return cloneTask(task);
  }

  public async cancel(taskId: string): Promise<RpaTask> {
    await this.load();
    const task = this.tasks.get(taskId);
    if (!task) throw new Error('TASK_NOT_FOUND');
    if (task.state === 'SUCCEEDED' || task.state === 'FAILED' || task.state === 'CANCELLED') return cloneTask(task);
    const timer = this.timers.get(taskId);
    if (timer) clearTimeout(timer);
    this.timers.delete(taskId);
    task.state = 'CANCELLED';
    task.updatedAt = Date.now();
    task.logs.push({ at: task.updatedAt, event: 'cancelled' });
    if (task.sessionId) await this.manager.stop(task.sessionId, 'rpa_cancelled').catch(() => undefined);
    await this.persist();
    return cloneTask(task);
  }

  public async shutdown(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    const running = [...this.tasks.values()].filter((task) => task.state === 'RUNNING');
    for (const task of running) await this.cancel(task.taskId);
    await this.persist();
  }

  private schedule(taskId: string, delayMs: number, headless: boolean): void {
    const timer = setTimeout(() => {
      this.timers.delete(taskId);
      const task = this.tasks.get(taskId);
      const remainingMs = (task?.scheduledAt ?? 0) - Date.now();
      if (task?.state === 'QUEUED' && remainingMs > 0) this.schedule(taskId, remainingMs, headless);
      else void this.execute(taskId, headless);
    }, Math.min(delayMs, 2_147_000_000));
    timer.unref?.();
    this.timers.set(taskId, timer);
  }

  private async execute(taskId: string, headless: boolean): Promise<void> {
    const task = this.tasks.get(taskId);
    const workflow = task ? this.workflows.get(task.workflowId) : undefined;
    if (!task || !workflow || task.state === 'CANCELLED') return;
    task.state = 'RUNNING';
    task.updatedAt = Date.now();
    task.logs.push({ at: task.updatedAt, event: 'started' });
    await this.persist();
    try {
      const session = await this.manager.start({ profileId: task.profileId, headless, fingerprint: true, inputProfile: 'paced' });
      task.sessionId = session.sessionId;
      await this.executeSteps(task, session.sessionId, workflow.steps);
      await this.manager.stop(session.sessionId, 'rpa_succeeded');
      delete task.sessionId;
      task.state = 'SUCCEEDED';
      task.updatedAt = Date.now();
      task.logs.push({ at: task.updatedAt, event: 'succeeded' });
    } catch (error) {
      if (task.sessionId) await this.manager.stop(task.sessionId, 'rpa_failed').catch(() => undefined);
      delete task.sessionId;
      task.state = this.tasks.get(taskId)?.state === 'CANCELLED' ? 'CANCELLED' : 'FAILED';
      task.updatedAt = Date.now();
      task.errorCode = typeof error === 'object' && error && 'code' in error ? String(error.code) : 'RPA_FAILED';
      task.logs.push({ at: task.updatedAt, event: 'failed' });
    }
    await this.persist();
    if (task.intervalMs && task.state !== 'CANCELLED') {
      const next = await this.run({
        workflowId: task.workflowId,
        profileId: task.profileId,
        headless,
        scheduledAt: Date.now() + task.intervalMs,
        intervalMs: task.intervalMs,
        variables: task.variables,
      });
      task.logs.push({ at: Date.now(), event: `next:${next.taskId}` });
      await this.persist();
    }
  }

  private async executeSteps(task: RpaTask, sessionId: string, steps: readonly RpaStep[]): Promise<void> {
    for (let index = 0; index < steps.length; index += 1) {
      if (this.tasks.get(task.taskId)?.state === 'CANCELLED') return;
      const step = steps[index]!;
      const attempts = Math.max(1, Math.min(10, step.retry?.attempts ?? 1));
      let lastError: unknown;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try { await this.executeStep(task, sessionId, step); lastError = undefined; break; }
        catch (error) {
          lastError = error;
          task.logs.push({ at: Date.now(), event: 'step_attempt_failed', step: index, message: `${attempt}/${attempts}: ${error instanceof Error ? error.message : String(error)}` });
          if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(60_000, step.retry?.delayMs ?? 500))));
        }
      }
      if (lastError && step.onError !== 'continue') throw lastError;
      if (lastError) task.logs.push({ at: Date.now(), event: 'step_skipped_after_error', step: index });
      task.completedSteps += 1;
      task.updatedAt = Date.now();
      task.logs.push({ at: task.updatedAt, event: 'step_completed', step: index });
      if (task.logs.length > 512) task.logs.splice(0, task.logs.length - 512);
      await this.persist();
    }
  }

  private async executeStep(task: RpaTask, sessionId: string, step: RpaStep): Promise<void> {
    if (step.op === 'open') await this.manager.open(sessionId, interpolate(step.url, task.variables));
    else if (step.op === 'click') await this.manager.click(sessionId, step.target);
    else if (step.op === 'type') await this.manager.type(sessionId, step.target, interpolate(step.text, task.variables), { clearFirst: step.clearFirst ?? false });
    else if (step.op === 'select') await this.manager.select(sessionId, step.target, step.value !== undefined ? { value: interpolate(step.value, task.variables) } : { label: interpolate(step.label!, task.variables) });
    else if (step.op === 'scroll') await this.manager.scroll(sessionId, step.direction, step.amount ?? 1);
    else if (step.op === 'wait') await this.manager.wait(sessionId, { durationMs: step.milliseconds });
    else if (step.op === 'snapshot') {
      const snapshot = await this.manager.snapshot(sessionId, { format: 'compact', maxBytes: 16_000 });
      if (step.saveAs) task.variables[step.saveAs] = JSON.stringify(snapshot).slice(0, 16_000);
    } else if (step.op === 'screenshot') {
      const result = await this.manager.screenshot(sessionId, { fullPage: step.fullPage ?? false });
      task.artifacts.push({ at: Date.now(), artifactRef: result.artifactRef });
      if (step.saveAs) task.variables[step.saveAs] = result.artifactRef;
    } else if (step.op === 'set') task.variables[step.variable] = step.value;
    else if (step.op === 'if') await this.executeSteps(task, sessionId, testCondition(step.condition, task.variables) ? step.then : (step.else ?? []));
    else if (step.op === 'repeat') {
      for (let count = 0; count < step.times; count += 1) {
        task.variables.$index = count;
        await this.executeSteps(task, sessionId, step.steps);
      }
    }
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.path)) return;
    const state = await readJsonWithBackup<PersistedRpaState>(this.path);
    for (const workflow of state.workflows ?? []) this.workflows.set(workflow.workflowId, { ...workflow, version: workflow.version ?? 1 });
    for (const task of state.tasks ?? []) {
      task.variables ??= {};
      task.artifacts ??= [];
      if (task.state === 'RUNNING') {
        task.state = 'FAILED';
        task.errorCode = 'PROCESS_RESTARTED';
        task.logs.push({ at: Date.now(), event: 'interrupted_by_restart' });
      }
      this.tasks.set(task.taskId, task);
      if (task.state === 'QUEUED') this.schedule(task.taskId, Math.max(0, (task.scheduledAt ?? Date.now()) - Date.now()), true);
    }
  }

  private persist(): Promise<void> {
    const operation = this.writeTail.then(async () => {
      const state: PersistedRpaState = {
        workflows: [...this.workflows.values()],
        tasks: [...this.tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 500),
      };
      await atomicWriteFile(this.path, JSON.stringify(state, null, 2));
    });
    this.writeTail = operation.catch(() => undefined);
    return operation;
  }
}

function validateSteps(steps: readonly RpaStep[]): void {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 100) throw new Error('WORKFLOW_STEPS_INVALID');
  for (const step of steps) {
    if (!step || typeof step !== 'object' || !['open', 'click', 'type', 'select', 'scroll', 'wait', 'snapshot', 'screenshot', 'set', 'if', 'repeat'].includes(step.op)) {
      throw new Error('WORKFLOW_STEP_INVALID');
    }
    if (step.op === 'open' && (!step.url || !/^https?:\/\//i.test(step.url))) throw new Error('WORKFLOW_URL_INVALID');
    if (['click', 'type', 'select'].includes(step.op)) {
      const target = (step as { target?: unknown }).target;
      if (!target || typeof target !== 'object' || Array.isArray(target)) throw new Error('WORKFLOW_TARGET_INVALID');
      const candidate = target as Record<string, unknown>;
      if ('selector' in candidate || 'x' in candidate || 'y' in candidate || 'coordinates' in candidate) throw new Error('WORKFLOW_TARGET_INVALID');
      const strategies = ['role', 'label', 'testId'].filter((key) => typeof candidate[key] === 'string' && candidate[key] !== '');
      if (strategies.length !== 1) throw new Error('WORKFLOW_TARGET_INVALID');
    }
    if (step.op === 'type' && (typeof step.text !== 'string' || step.text.length > 10_000)) throw new Error('WORKFLOW_TEXT_INVALID');
    if (step.op === 'wait' && (!Number.isFinite(step.milliseconds) || step.milliseconds < 0 || step.milliseconds > 60_000)) throw new Error('WORKFLOW_WAIT_INVALID');
    if (step.op === 'select' && ((step.value === undefined) === (step.label === undefined))) throw new Error('WORKFLOW_SELECT_INVALID');
    if (step.op === 'set' && (!/^[A-Za-z_$][\w$.-]{0,63}$/.test(step.variable) || !['string', 'number', 'boolean'].includes(typeof step.value))) throw new Error('WORKFLOW_VARIABLE_INVALID');
    if (step.op === 'if') { validateCondition(step.condition); validateSteps(step.then); if (step.else?.length) validateSteps(step.else); }
    if (step.op === 'repeat') { if (!Number.isInteger(step.times) || step.times < 1 || step.times > 100) throw new Error('WORKFLOW_REPEAT_INVALID'); validateSteps(step.steps); }
    if (step.retry && (!Number.isInteger(step.retry.attempts ?? 1) || (step.retry.attempts ?? 1) < 1 || (step.retry.attempts ?? 1) > 10)) throw new Error('WORKFLOW_RETRY_INVALID');
  }
}

function cloneStep(step: RpaStep): RpaStep { return structuredClone(step); }
function cloneWorkflow(value: RpaWorkflow): RpaWorkflow { return { ...value, steps: value.steps.map(cloneStep) }; }
function cloneTask(value: RpaTask): RpaTask { return { ...value, variables: { ...value.variables }, artifacts: value.artifacts.map((artifact) => ({ ...artifact })), logs: value.logs.map((log) => ({ ...log })) }; }

function interpolate(value: string, variables: Readonly<Record<string, string | number | boolean>>): string {
  return value.replace(/\{\{\s*([\w$.-]+)\s*\}\}/g, (_match, name: string) => String(variables[name] ?? ''));
}

function validateCondition(condition: RpaCondition): void {
  if (!condition || !/^[A-Za-z_$][\w$.-]{0,63}$/.test(condition.variable) || !['equals', 'notEquals', 'exists', 'contains'].includes(condition.operator)) throw new Error('WORKFLOW_CONDITION_INVALID');
}

function testCondition(condition: RpaCondition, variables: Readonly<Record<string, string | number | boolean>>): boolean {
  const actual = variables[condition.variable];
  if (condition.operator === 'exists') return actual !== undefined;
  if (condition.operator === 'equals') return actual === condition.value;
  if (condition.operator === 'notEquals') return actual !== condition.value;
  return String(actual ?? '').includes(String(condition.value ?? ''));
}
