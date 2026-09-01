import { InteractionScheduler } from './scheduler.js';
import type { ActionKind, SchedulerLocatorLike, SchedulerOptions, SchedulerPageLike, SchedulerTiming } from './scheduler.js';

/**
 * High-level Playwright interactions without pacing.  This class intentionally
 * does not expose a DOM event dispatcher or a protocol/evaluate escape hatch.
 */
export class DirectScheduler extends InteractionScheduler {
  public constructor(options: Omit<SchedulerOptions, 'mode'> = {}, page?: SchedulerPageLike) {
    super({ ...options, mode: 'direct' }, page);
  }

  public override async pauseBefore(action: ActionKind, signal?: AbortSignal): Promise<number> {
    void action;
    if (signal?.aborted) {
      const error = new Error('Interaction was aborted');
      error.name = 'AbortError';
      throw error;
    }
    return 0;
  }

  public override async pauseAfter(action: ActionKind, signal?: AbortSignal): Promise<number> {
    void action;
    if (signal?.aborted) {
      const error = new Error('Interaction was aborted');
      error.name = 'AbortError';
      throw error;
    }
    return 0;
  }

  /** Use Playwright's locator.click actionability checks. */
  public override async click(
    locator: SchedulerLocatorLike,
    options: Record<string, unknown> = { button: 'left' },
    signal?: AbortSignal,
  ): Promise<SchedulerTiming> {
    if (signal?.aborted) throw this.abortedError();
    await locator.click({ button: 'left', ...options });
    if (signal?.aborted) throw this.abortedError();
    return { preDelayMs: 0, postDelayMs: 0 };
  }

  private abortedError(): Error {
    const error = new Error('Interaction was aborted');
    error.name = 'AbortError';
    return error;
  }
}

export const DirectInputScheduler = DirectScheduler;
