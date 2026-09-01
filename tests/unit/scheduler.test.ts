import { describe, expect, it } from 'vitest';

import { SeededRng } from '../../src/input/seeded-rng.js';
import {
  InteractionScheduler,
  createBezierTrajectory,
  type SchedulerPageLike,
} from '../../src/input/scheduler.js';

describe('SeededRng and InteractionScheduler', () => {
  it('replays the same random stream for the same seed', () => {
    const first = new SeededRng(1234);
    const second = new SeededRng(1234);
    expect(Array.from({ length: 8 }, () => first.next())).toEqual(
      Array.from({ length: 8 }, () => second.next()),
    );
  });

  it('creates a bounded eased Bezier trajectory', () => {
    const trajectory = createBezierTrajectory(
      { x: 0, y: 0 },
      { x: 100, y: 80 },
      new SeededRng(5),
    );
    expect(trajectory.points.length).toBeGreaterThanOrEqual(8);
    expect(trajectory.points.length).toBeLessThanOrEqual(24);
    expect(trajectory.points[0]).toEqual({ x: 0, y: 0 });
    expect(trajectory.points.at(-1)).toEqual({ x: 100, y: 80 });
    expect(trajectory.durationMs).toBeGreaterThanOrEqual(50);
  });

  it('types through high-level keyboard calls with 25-90ms delays', async () => {
    const sleeps: number[] = [];
    const typed: string[] = [];
    const page: SchedulerPageLike = {
      mouse: { move: async () => undefined },
      keyboard: { type: async (value) => { typed.push(value); return undefined; } },
    };
    const scheduler = new InteractionScheduler({
      mode: 'paced',
      seed: 99,
      page,
      sleep: async (milliseconds) => { sleeps.push(milliseconds); return undefined; },
    });
    const locator = {
      click: async () => undefined,
      focus: async () => undefined,
    };
    const timing = await scheduler.typeText(locator, 'abc');
    expect(typed.join('')).toBe('abc');
    expect(timing.keyDelaysMs).toHaveLength(3);
    expect(timing.keyDelaysMs?.every((delay) => delay >= 25 && delay <= 90)).toBe(true);
    expect(sleeps.some((delay) => delay >= 25 && delay <= 90)).toBe(true);
  });

  it('paces every pointer segment across the planned trajectory duration', async () => {
    const sleeps: number[] = [];
    const moves: Array<{ x: number; y: number }> = [];
    const page: SchedulerPageLike = {
      mouse: {
        move: async (x, y) => {
          moves.push({ x, y });
          return undefined;
        },
      },
    };
    const scheduler = new InteractionScheduler({
      mode: 'paced',
      seed: 17,
      page,
      mousePoints: [8, 8],
      mouseDurationMs: [280, 280],
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        return undefined;
      },
    });

    const trajectory = await scheduler.movePointer({ x: 120, y: 90 });
    expect(moves).toHaveLength(8);
    expect(sleeps).toHaveLength(7);
    expect(sleeps.reduce((total, value) => total + value, 0)).toBeCloseTo(trajectory.durationMs, 6);
    expect(moves.at(-1)).toEqual({ x: 120, y: 90 });
  });

  it('chunks long policy-approved scrolls into bounded wheel bursts', async () => {
    const wheels: Array<[number, number]> = [];
    const page: SchedulerPageLike = {
      mouse: {
        move: async () => undefined,
        wheel: async (deltaX, deltaY) => {
          wheels.push([deltaX, deltaY]);
        },
      },
    };
    const scheduler = new InteractionScheduler({
      mode: 'direct',
      page,
      scrollStepPixels: 480,
    });

    const result = await scheduler.scroll('down', 10);
    expect(wheels).toHaveLength(4);
    expect(result.steps).toBe(4);
    expect(result.deltaX).toBe(0);
    expect(result.deltaY).toBe(4_800);
    await expect(scheduler.scroll('down', 21)).rejects.toThrow(/1 to 20/u);
  });

  it('stops before emitting a later key after abort', async () => {
    const controller = new AbortController();
    const typed: string[] = [];
    const page: SchedulerPageLike = {
      mouse: { move: async () => undefined },
      keyboard: {
        type: async (value) => {
          typed.push(value);
          if (value === 'a') controller.abort();
        },
      },
    };
    const scheduler = new InteractionScheduler({
      mode: 'paced',
      seed: 1,
      page,
      sleep: async () => undefined,
    });
    await expect(scheduler.typeText({ click: async () => undefined, focus: async () => undefined }, 'abc', controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(typed).toEqual(['a']);
  });

  it('preserves label versus value when selecting through the high-level locator', async () => {
    const selections: Array<string | { label?: string; value?: string }> = [];
    const scheduler = new InteractionScheduler({ mode: 'direct', seed: 3 });
    const locator = {
      click: async () => undefined,
      selectOption: async (selection: string | { label?: string; value?: string }) => {
        selections.push(selection);
        return undefined;
      },
    };

    await scheduler.selectOption(locator, { label: 'Visible option' });
    await scheduler.selectOption(locator, 'stored-value');
    expect(selections).toEqual([{ label: 'Visible option' }, { value: 'stored-value' }]);
  });
});
