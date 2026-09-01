import { InteractionScheduler } from './scheduler.js';
import type { SchedulerOptions, SchedulerPageLike } from './scheduler.js';

/** Bounded, deterministic timing and pointer movement for test/replay use. */
export class PacedScheduler extends InteractionScheduler {
  public constructor(options: Omit<SchedulerOptions, 'mode'> = {}, page?: SchedulerPageLike) {
    super({ ...options, mode: 'paced' }, page);
  }
}

export const PacedInputScheduler = PacedScheduler;
