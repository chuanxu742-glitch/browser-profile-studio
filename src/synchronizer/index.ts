import type { SessionManager } from '../browser/session-manager.js';

import type { SemanticTarget } from '../browser/semantic-snapshot.js';

export interface SyncAction {
  type: 'navigate' | 'click' | 'type' | 'scroll' | 'reload';
  url?: string;
  target?: string | SemanticTarget;
  text?: string;
  deltaX?: number;
  deltaY?: number;
}

export interface SyncTaskResult {
  sessionId: string;
  success: boolean;
  error?: string;
  elapsedMs: number;
}

export class WindowSynchronizer {
  private readonly captures = new Map<string, { masterSessionId: string; targetSessionIds: string[]; stop: () => void; startedAt: number; actions: number; failures: number; tail: Promise<void> }>();
  constructor(private readonly manager: SessionManager) {}

  public async startCapture(masterSessionId: string, targetSessionIds: string[], options: { jitterMs?: number } = {}): Promise<{ synchronizerId: string; masterSessionId: string; targetSessionIds: string[] }> {
    const targets = [...new Set(targetSessionIds)].filter((id) => id !== masterSessionId).slice(0, 32);
    if (!targets.length) throw new Error('SYNCHRONIZER_TARGETS_REQUIRED');
    this.manager.status(masterSessionId);
    targets.forEach((id) => this.manager.status(id));
    const synchronizerId = `syn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const capture: { masterSessionId: string; targetSessionIds: string[]; stop: () => void; startedAt: number; actions: number; failures: number; tail: Promise<void> } = { masterSessionId, targetSessionIds: targets, stop: () => undefined, startedAt: Date.now(), actions: 0, failures: 0, tail: Promise.resolve() };
    capture.stop = await this.manager.observeSyncEvents(masterSessionId, (action) => {
      capture.tail = capture.tail.then(async () => {
        capture.actions += 1;
        const results = await this.broadcast(targets, action, options);
        capture.failures += results.filter((result) => !result.success).length;
      }).catch(() => { capture.failures += targets.length; });
    });
    this.captures.set(synchronizerId, capture);
    return { synchronizerId, masterSessionId, targetSessionIds: [...targets] };
  }

  public stopCapture(synchronizerId: string): boolean {
    const capture = this.captures.get(synchronizerId); if (!capture) return false;
    capture.stop(); this.captures.delete(synchronizerId); return true;
  }

  public listCaptures(): Array<{ synchronizerId: string; masterSessionId: string; targetSessionIds: string[]; startedAt: number; actions: number; failures: number }> {
    return [...this.captures.entries()].map(([synchronizerId, value]) => ({ synchronizerId, masterSessionId: value.masterSessionId, targetSessionIds: [...value.targetSessionIds], startedAt: value.startedAt, actions: value.actions, failures: value.failures }));
  }

  public shutdown(): void { for (const id of [...this.captures.keys()]) this.stopCapture(id); }

  /**
   * Broadcast an action from the master session to all target slave sessions with humanized jitter.
   */
  public async broadcast(
    targetSessionIds: string[],
    action: SyncAction,
    options: { jitterMs?: number } = {},
  ): Promise<SyncTaskResult[]> {
    const jitter = options.jitterMs ?? 40;
    const results: SyncTaskResult[] = [];

    const tasks = targetSessionIds.map(async (sid, idx) => {
      const startTs = Date.now();
      const delay = idx * 25 + Math.floor(Math.random() * jitter);
      if (delay > 0) {
        await new Promise((r) => setTimeout(r, delay));
      }

      try {
        if (action.target && typeof action.target === 'object' && 'selector' in action.target) {
          throw new Error('Raw selectors are not accepted by the synchronizer');
        }
        if (action.type === 'navigate' && action.url) {
          await this.manager.open(sid, action.url, { waitUntil: 'domcontentloaded', timeoutMs: 20_000 });
        } else if (action.type === 'click' && action.target) {
          await this.manager.click(sid, action.target);
        } else if (action.type === 'type' && action.target && action.text !== undefined) {
          await this.manager.type(sid, action.target, action.text);
        } else if (action.type === 'scroll') {
          const delta = action.deltaY || 300;
          await this.manager.scroll(sid, delta < 0 ? 'up' : 'down', Math.max(1, Math.ceil(Math.abs(delta) / 300)));
        } else if (action.type === 'reload') {
          const currentUrl = this.manager.status(sid).url;
          if (!currentUrl) throw new Error(`Session ${sid} has no active URL`);
          await this.manager.open(sid, currentUrl, { waitUntil: 'domcontentloaded', timeoutMs: 20_000 });
        } else {
          throw new Error(`Unsupported or incomplete synchronization action: ${action.type}`);
        }

        results.push({ sessionId: sid, success: true, elapsedMs: Date.now() - startTs });
      } catch (err: any) {
        results.push({ sessionId: sid, success: false, error: err.message, elapsedMs: Date.now() - startTs });
      }
    });

    await Promise.all(tasks);
    return results;
  }

  /**
   * Calculate grid tile layout coordinates for multi-window organization.
   */
  public calculateGridLayout(
    windowCount: number,
    screenWidth = 1920,
    screenHeight = 1080,
  ): Array<{ width: number; height: number; x: number; y: number }> {
    if (windowCount <= 0) return [];
    let cols = 1;
    let rows = 1;

    if (windowCount === 2) {
      cols = 2;
      rows = 1;
    } else if (windowCount <= 4) {
      cols = 2;
      rows = 2;
    } else if (windowCount <= 6) {
      cols = 3;
      rows = 2;
    } else if (windowCount <= 9) {
      cols = 3;
      rows = 3;
    } else {
      cols = 4;
      rows = Math.ceil(windowCount / 4);
    }

    const cellWidth = Math.floor(screenWidth / cols);
    const cellHeight = Math.floor(screenHeight / rows);

    const layout: Array<{ width: number; height: number; x: number; y: number }> = [];
    for (let i = 0; i < windowCount; i++) {
      const c = i % cols;
      const r = Math.floor(i / cols);
      layout.push({
        width: cellWidth,
        height: cellHeight,
        x: c * cellWidth,
        y: r * cellHeight,
      });
    }
    return layout;
  }
}
