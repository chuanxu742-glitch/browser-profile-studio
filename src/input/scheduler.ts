import { randomBytes } from 'node:crypto';

import { SeededRng } from './seeded-rng.js';

export type SchedulerMode = 'direct' | 'paced';
export type ActionKind = 'click' | 'hover' | 'type' | 'select' | 'scroll' | 'wait';
export type Direction = 'up' | 'down' | 'left' | 'right';

export interface Point {
  x: number;
  y: number;
}

export interface BoundingBox extends Point {
  width: number;
  height: number;
}

export interface MouseLike {
  move(x: number, y: number, options?: { steps?: number }): Promise<void>;
  wheel?(deltaX: number, deltaY: number): Promise<void>;
}

export interface KeyboardLike {
  type(text: string, options?: { delay?: number }): Promise<void>;
  press?(key: string, options?: { delay?: number }): Promise<void>;
  insertText?(text: string): Promise<void>;
}

export interface ViewportLike {
  width: number;
  height: number;
}

/** The small subset of Playwright's Page used by the scheduler. */
export interface SchedulerPageLike {
  mouse: MouseLike;
  keyboard?: KeyboardLike;
  viewportSize?(): ViewportLike | null;
  waitForTimeout?(milliseconds: number): Promise<void>;
}

/** The small subset of Playwright's Locator used by the scheduler. */
export interface SchedulerLocatorLike {
  click(options?: Record<string, unknown>): Promise<void>;
  focus?(): Promise<void>;
  fill?(value: string): Promise<void>;
  type?(value: string, options?: { delay?: number }): Promise<void>;
  press?(key: string, options?: { delay?: number }): Promise<void>;
  selectOption?(value: string | { label?: string; value?: string }): Promise<unknown>;
  boundingBox?(): Promise<BoundingBox | null>;
}

export interface SchedulerOptions {
  mode?: SchedulerMode;
  seed?: number;
  rng?: SeededRng;
  page?: SchedulerPageLike;
  /** Inclusive lower and upper bounds for click/hover pre-action pauses. */
  preDelayMs?: readonly [number, number];
  /** Inclusive lower and upper bounds for post-action pauses. */
  postDelayMs?: readonly [number, number];
  /** Inclusive lower and upper bounds for per-character delays. */
  keyDelayMs?: readonly [number, number];
  /** Inclusive lower and upper bounds for total trajectory points. */
  mousePoints?: readonly [number, number];
  /** Inclusive lower and upper bounds for a pointer movement duration. */
  mouseDurationMs?: readonly [number, number];
  /** Used by tests and by embedders that already have a timer service. */
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  /** Maximum amount of wheel movement per micro-step. */
  scrollStepPixels?: number;
}

export interface SchedulerTiming {
  preDelayMs: number;
  postDelayMs: number;
  keyDelaysMs?: number[];
  mouseDurationMs?: number;
}

export interface MouseTrajectory {
  points: Point[];
  durationMs: number;
}

const DEFAULT_PRE_DELAY: readonly [number, number] = [80, 260];
const DEFAULT_POST_DELAY: readonly [number, number] = [120, 450];
const DEFAULT_KEY_DELAY: readonly [number, number] = [25, 90];
const DEFAULT_MOUSE_POINTS: readonly [number, number] = [8, 24];
const DEFAULT_MOUSE_DURATION: readonly [number, number] = [180, 850];
const HARD_PRE_DELAY: readonly [number, number] = [0, 2_000];
const HARD_POST_DELAY: readonly [number, number] = [0, 2_000];
const HARD_KEY_DELAY: readonly [number, number] = [25, 90];
const HARD_MOUSE_POINTS: readonly [number, number] = [8, 24];
const HARD_MOUSE_DURATION: readonly [number, number] = [50, 3_000];
export const HARD_MAX_SCROLL_AMOUNT = 20;

function sessionRandomSeed(): number {
  try {
    return randomBytes(4).readUInt32LE(0);
  } catch {
    // Supported Node versions provide crypto.randomBytes. Keep a non-secret
    // fallback for minimal test embedders; this seed controls pacing replay,
    // not authentication or a security token.
    return (Date.now() ^ Math.floor(Math.random() * 0xffff_ffff)) >>> 0;
  }
}

function clampRange(
  value: readonly [number, number] | undefined,
  hard: readonly [number, number],
  fallback: readonly [number, number],
  name: string,
): readonly [number, number] {
  const candidate = value ?? fallback;
  if (
    candidate.length !== 2 ||
    !Number.isFinite(candidate[0]) ||
    !Number.isFinite(candidate[1]) ||
    !Number.isInteger(candidate[0]) ||
    !Number.isInteger(candidate[1]) ||
    candidate[0] < hard[0] ||
    candidate[1] > hard[1] ||
    candidate[0] > candidate[1]
  ) {
    throw new RangeError(`${name} is outside the scheduler's bounded range`);
  }
  return [candidate[0], candidate[1]];
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof value === 'object' && value !== null && 'aborted' in value;
}

function abortError(): Error {
  const error = new Error('Interaction was aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function isBoundingBox(value: unknown): value is BoundingBox {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.x === 'number' &&
    typeof candidate.y === 'number' &&
    typeof candidate.width === 'number' &&
    typeof candidate.height === 'number'
  );
}

function isPoint(value: unknown): value is Point {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.x === 'number' && typeof candidate.y === 'number';
}

function centerOf(box: BoundingBox): Point {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function normalizePoint(target: Point | BoundingBox): Point {
  return isBoundingBox(target) ? centerOf(target) : { x: target.x, y: target.y };
}

/**
 * Abortable bounded delay.  It intentionally uses a normal timer rather than
 * page.evaluate or a browser protocol command.
 */
export function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/** Cubic Bezier interpolation. Exported for deterministic unit tests. */
export function cubicBezier(t: number, p0: Point, p1: Point, p2: Point, p3: Point): Point {
  const oneMinusT = 1 - t;
  const a = oneMinusT * oneMinusT * oneMinusT;
  const b = 3 * oneMinusT * oneMinusT * t;
  const c = 3 * oneMinusT * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

/** A monotonic ease-in/ease-out curve. */
export function easeInOut(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return clamped * clamped * (3 - 2 * clamped);
}

export function sampleGaussian(rng: SeededRng, mean = 0, stdDev = 1): number {
  let u1 = rng.next();
  let u2 = rng.next();
  while (u1 <= 1e-7) u1 = rng.next();
  const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return mean + z0 * stdDev;
}

const COMMON_DIGRAPHS = new Set([
  'th', 'he', 'in', 'er', 'an', 're', 'on', 'at', 'en', 'nd', 'ed', 'es', 'or', 'te', 'of', 'ea',
  'ti', 'to', 'it', 'st', 'io', 'le', 'is', 'ou', 'ar', 'as', 'de', 'rt', 've'
]);

export function calculateHumanKeyDelay(
  currentKey: string,
  prevKey: string | undefined,
  rng: SeededRng,
  minBound: number,
  maxBound: number,
): number {
  const center = (minBound + maxBound) / 2;
  const spread = Math.max(1, (maxBound - minBound) / 6);
  let delay = sampleGaussian(rng, center, spread);

  if (prevKey) {
    const digraph = (prevKey + currentKey).toLowerCase();
    if (COMMON_DIGRAPHS.has(digraph)) {
      // 常见双字母加速 15%~20%
      delay *= 0.85;
    } else if (/[^a-zA-Z0-9]/.test(currentKey)) {
      // 标点符号与特殊按键减速 20%
      delay *= 1.20;
    }
  }

  return Math.max(minBound, Math.min(maxBound, Math.round(delay)));
}

/**
 * Build a bounded multi-point pointer path with Fitts's Law pacing and muscular jitter.
 * The first and final points are exactly the supplied endpoints.
 */
export function createBezierTrajectory(
  from: Point,
  to: Point,
  rng: SeededRng,
  pointRange: readonly [number, number] = DEFAULT_MOUSE_POINTS,
  durationRange: readonly [number, number] = DEFAULT_MOUSE_DURATION,
): MouseTrajectory {
  const pointsMin = Math.max(HARD_MOUSE_POINTS[0], pointRange[0]);
  const pointsMax = Math.min(HARD_MOUSE_POINTS[1], pointRange[1]);
  if (!Number.isInteger(pointsMin) || !Number.isInteger(pointsMax) || pointsMin > pointsMax) {
    throw new RangeError('Mouse point range is invalid');
  }
  const count = rng.int(pointsMin, pointsMax);
  const durationMin = Math.max(HARD_MOUSE_DURATION[0], durationRange[0]);
  const durationMax = Math.min(HARD_MOUSE_DURATION[1], durationRange[1]);
  if (durationMin > durationMax) throw new RangeError('Mouse duration range is invalid');

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);

  // 菲茨定律估算自然时间：T = a + b * log2(1 + D/W)
  let durationMs: number;
  if (durationMin === durationMax) {
    durationMs = durationMin;
  } else {
    const fittsFactor = Math.min(1, Math.max(0, Math.log2(1 + distance / 45) / 4.2));
    const estimated = Math.round(durationMin + (durationMax - durationMin) * fittsFactor);
    durationMs = Math.max(durationMin, Math.min(durationMax, estimated));
  }

  const perpendicularLength = distance === 0 ? 0 : Math.min(80, Math.max(4, distance * 0.18));
  const normal = distance === 0 ? { x: 0, y: 0 } : { x: -dy / distance, y: dx / distance };
  const bend = rng.float(-perpendicularLength, perpendicularLength);
  const p1: Point = {
    x: from.x + dx * 0.34 + normal.x * bend,
    y: from.y + dy * 0.34 + normal.y * bend,
  };
  const p2: Point = {
    x: from.x + dx * 0.72 - normal.x * bend * 0.55,
    y: from.y + dy * 0.72 - normal.y * bend * 0.55,
  };

  const points: Point[] = [];
  for (let index = 0; index < count; index += 1) {
    const raw = count === 1 ? 1 : index / (count - 1);
    if (raw === 0) {
      points.push({ x: Number(from.x.toFixed(3)), y: Number(from.y.toFixed(3)) });
      continue;
    }
    if (raw === 1) {
      points.push({ x: Number(to.x.toFixed(3)), y: Number(to.y.toFixed(3)) });
      continue;
    }

    const curvePoint = cubicBezier(easeInOut(raw), from, p1, p2, to);

    // 人类手部微小肌肉抖动（Muscular Jitter）：在运动中间产生微小的高斯随机偏置，两端自然衰减至 0
    const jitterMagnitude = Math.sin(raw * Math.PI) * 0.75;
    const jitterX = jitterMagnitude === 0 ? 0 : rng.float(-jitterMagnitude, jitterMagnitude);
    const jitterY = jitterMagnitude === 0 ? 0 : rng.float(-jitterMagnitude, jitterMagnitude);

    points.push({
      x: Number((curvePoint.x + jitterX).toFixed(3)),
      y: Number((curvePoint.y + jitterY).toFixed(3)),
    });
  }
  return { points, durationMs };
}

export function makeSafePoint(box: BoundingBox, rng: SeededRng): Point {
  // Keep the point away from the edge of the box.  If a zero-sized box is
  // returned by a test double, its origin is still a valid deterministic point.
  const insetX = Math.max(0, box.width * 0.2);
  const insetY = Math.max(0, box.height * 0.2);
  const availableWidth = Math.max(0, box.width - insetX * 2);
  const availableHeight = Math.max(0, box.height - insetY * 2);
  return {
    x: box.x + insetX + (availableWidth === 0 ? 0 : rng.float(0, availableWidth)),
    y: box.y + insetY + (availableHeight === 0 ? 0 : rng.float(0, availableHeight)),
  };
}

export class InteractionScheduler {
  public readonly mode: SchedulerMode;
  public readonly rng: SeededRng;
  protected page: SchedulerPageLike | undefined;
  protected readonly preDelayRange: readonly [number, number];
  protected readonly postDelayRange: readonly [number, number];
  protected readonly keyDelayRange: readonly [number, number];
  protected readonly mousePointRange: readonly [number, number];
  protected readonly mouseDurationRange: readonly [number, number];
  protected readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  protected readonly scrollStepPixels: number;
  protected pointer: Point = { x: 0, y: 0 };

  public constructor(options?: SchedulerOptions | SchedulerMode, page?: SchedulerPageLike);
  public constructor(mode: SchedulerMode, seed?: number, page?: SchedulerPageLike);
  public constructor(
    options: SchedulerOptions | SchedulerMode = {},
    pageOrSeed?: SchedulerPageLike | number,
    page?: SchedulerPageLike,
  ) {
    const normalized: SchedulerOptions = typeof options === 'string'
      ? typeof pageOrSeed === 'number'
        ? { mode: options, seed: pageOrSeed, ...(page ? { page } : {}) }
        : pageOrSeed === undefined ? { mode: options } : { mode: options, page: pageOrSeed }
      : options;
    this.mode = normalized.mode ?? 'paced';
    this.rng = normalized.rng ?? new SeededRng(normalized.seed ?? sessionRandomSeed());
    this.page = normalized.page ?? page;
    this.preDelayRange = clampRange(normalized.preDelayMs, HARD_PRE_DELAY, DEFAULT_PRE_DELAY, 'preDelayMs');
    this.postDelayRange = clampRange(normalized.postDelayMs, HARD_POST_DELAY, DEFAULT_POST_DELAY, 'postDelayMs');
    this.keyDelayRange = clampRange(normalized.keyDelayMs, HARD_KEY_DELAY, DEFAULT_KEY_DELAY, 'keyDelayMs');
    this.mousePointRange = clampRange(normalized.mousePoints, HARD_MOUSE_POINTS, DEFAULT_MOUSE_POINTS, 'mousePoints');
    this.mouseDurationRange = clampRange(
      normalized.mouseDurationMs,
      HARD_MOUSE_DURATION,
      DEFAULT_MOUSE_DURATION,
      'mouseDurationMs',
    );
    this.sleep = normalized.sleep ?? delay;
    this.scrollStepPixels = Math.max(1, Math.min(1_200, Math.floor(normalized.scrollStepPixels ?? 480)));
  }

  public get isPaced(): boolean {
    return this.mode === 'paced';
  }

  /** Attach the page created by a persistent context after construction. */
  public setPage(page: SchedulerPageLike): void {
    this.page = page;
    // A fresh Playwright page starts its virtual pointer at the origin. Reset
    // our planner as well so a headed reopen does not jump to a stale point
    // from the previous browser process before beginning its paced path.
    this.pointer = { x: 0, y: 0 };
  }

  public samplePreDelay(): number {
    return this.rng.int(this.preDelayRange[0], this.preDelayRange[1]);
  }

  public samplePostDelay(): number {
    return this.rng.int(this.postDelayRange[0], this.postDelayRange[1]);
  }

  public sampleKeyDelay(currentKey?: string, prevKey?: string): number {
    return calculateHumanKeyDelay(
      currentKey ?? 'a',
      prevKey,
      this.rng,
      this.keyDelayRange[0],
      this.keyDelayRange[1],
    );
  }

  public keyDelays(length: number, text?: string): number[] {
    if (!Number.isInteger(length) || length < 0) throw new RangeError('Text length must be non-negative');
    const delays: number[] = [];
    let prevChar: string | undefined;
    for (let i = 0; i < length; i += 1) {
      const char = text ? text[i] : undefined;
      delays.push(this.sampleKeyDelay(char, prevChar));
      prevChar = char;
    }
    return delays;
  }

  public planTrajectory(from: Point, to: Point): MouseTrajectory {
    return createBezierTrajectory(from, to, this.rng, this.mousePointRange, this.mouseDurationRange);
  }

  public generateMousePath(from: Point, to: Point): Point[] {
    return this.planTrajectory(from, to).points;
  }

  public getMouseTrajectory(from: Point, to: Point): MouseTrajectory {
    return this.planTrajectory(from, to);
  }

  public getKeyDelays(length: number): number[] {
    return this.keyDelays(length);
  }

  public async pauseBefore(action: ActionKind, signal?: AbortSignal): Promise<number> {
    throwIfAborted(signal);
    if (!this.isPaced || action === 'wait') return 0;
    const milliseconds = this.samplePreDelay();
    await this.sleep(milliseconds, signal);
    return milliseconds;
  }

  public async pauseAfter(action: ActionKind, signal?: AbortSignal): Promise<number> {
    throwIfAborted(signal);
    if (!this.isPaced || action === 'wait') return 0;
    const milliseconds = this.samplePostDelay();
    await this.sleep(milliseconds, signal);
    return milliseconds;
  }

  public async movePointer(target: BoundingBox | Point, signal?: AbortSignal): Promise<MouseTrajectory>;
  public async movePointer(
    page: SchedulerPageLike,
    target: BoundingBox | Point,
    signal?: AbortSignal,
  ): Promise<MouseTrajectory>;
  public async movePointer(
    pageOrTarget: SchedulerPageLike | BoundingBox | Point,
    targetOrSignal?: BoundingBox | Point | AbortSignal,
    signal?: AbortSignal,
  ): Promise<MouseTrajectory> {
    const externalPage = isBoundingBox(pageOrTarget) || isPoint(pageOrTarget)
      ? undefined
      : pageOrTarget as SchedulerPageLike;
    const target = (externalPage ? targetOrSignal : pageOrTarget) as BoundingBox | Point;
    const actualSignal = externalPage ? signal : isAbortSignal(targetOrSignal) ? targetOrSignal : signal;
    if (!isBoundingBox(target) && !isPoint(target)) throw new TypeError('Pointer target must be a point or bounding box');
    throwIfAborted(actualSignal);
    const page = externalPage ?? this.page;
    if (!page) throw new Error('A page is required for pointer movement');
    const destination = isBoundingBox(target) ? makeSafePoint(target, this.rng) : normalizePoint(target);
    const trajectory = this.isPaced
      ? this.planTrajectory(this.pointer, destination)
      : { points: [destination], durationMs: 0 };

    const segmentDelayMs = trajectory.points.length > 1
      ? trajectory.durationMs / (trajectory.points.length - 1)
      : 0;
    for (let index = 0; index < trajectory.points.length; index += 1) {
      const point = trajectory.points[index]!;
      throwIfAborted(actualSignal);
      await page.mouse.move(point.x, point.y);
      if (this.isPaced && index + 1 < trajectory.points.length) {
        await this.sleep(segmentDelayMs, actualSignal);
      }
    }
    this.pointer = destination;
    return trajectory;
  }

  public async click(
    locator: SchedulerLocatorLike,
    options: Record<string, unknown> = { button: 'left' },
    signal?: AbortSignal,
  ): Promise<SchedulerTiming> {
    const preDelayMs = await this.pauseBefore('click', signal);
    throwIfAborted(signal);
    if (this.isPaced && this.page && locator.boundingBox) {
      const box = await locator.boundingBox();
      throwIfAborted(signal);
      if (box) await this.movePointer(box, signal);
    }
    throwIfAborted(signal);
    await locator.click({ button: 'left', ...options });
    throwIfAborted(signal);
    const postDelayMs = await this.pauseAfter('click', signal);
    return { preDelayMs, postDelayMs };
  }

  public async hover(locator: SchedulerLocatorLike, signal?: AbortSignal): Promise<SchedulerTiming> {
    const preDelayMs = await this.pauseBefore('hover', signal);
    throwIfAborted(signal);
    if (this.isPaced && this.page && locator.boundingBox) {
      const box = await locator.boundingBox();
      throwIfAborted(signal);
      if (box) await this.movePointer(box, signal);
    }
    // Locator.hover is a Playwright high-level action.  It is optional in the
    // narrow test interface because click is the only required interaction.
    const hover = (locator as SchedulerLocatorLike & { hover?: () => Promise<void> }).hover;
    if (hover) await hover.call(locator);
    else throw new Error('Target does not support high-level hover');
    throwIfAborted(signal);
    const postDelayMs = await this.pauseAfter('hover', signal);
    return { preDelayMs, postDelayMs };
  }

  public async typeText(
    target: SchedulerLocatorLike,
    text: string,
    sensitiveOrSignal?: boolean | AbortSignal,
    signal?: AbortSignal,
  ): Promise<SchedulerTiming> {
    const actualSignal = isAbortSignal(sensitiveOrSignal) ? sensitiveOrSignal : signal;
    throwIfAborted(actualSignal);
    const sensitive = typeof sensitiveOrSignal === 'boolean' ? sensitiveOrSignal : false;
    void sensitive; // Sensitivity is consumed by the audit layer, never by timing logic.
    const preDelayMs = await this.pauseBefore('type', actualSignal);
    throwIfAborted(actualSignal);
    if (target.focus) await target.focus();
    throwIfAborted(actualSignal);

    if (!this.isPaced) {
      if (target.fill) await target.fill(text);
      else if (target.type) await target.type(text);
      else if (this.page?.keyboard) await this.page.keyboard.type(text);
      else throw new Error('Target does not support high-level text input');
      const postDelayMs = await this.pauseAfter('type', actualSignal);
      return { preDelayMs, postDelayMs };
    }

    const keyDelaysMs: number[] = [];
    let prevChar: string | undefined;
    for (const character of text) {
      throwIfAborted(actualSignal);
      const keyDelayMs = this.sampleKeyDelay(character, prevChar);
      prevChar = character;
      keyDelaysMs.push(keyDelayMs);
      await this.sleep(keyDelayMs, actualSignal);
      throwIfAborted(actualSignal);
      if (this.page?.keyboard) await this.page.keyboard.type(character);
      else if (target.type) await target.type(character);
      else throw new Error('Target does not support high-level text input');
      throwIfAborted(actualSignal);
    }
    const postDelayMs = await this.pauseAfter('type', actualSignal);
    return { preDelayMs, postDelayMs, keyDelaysMs };
  }

  public async selectOption(
    target: SchedulerLocatorLike,
    valueOrLabel: string | { value?: string; label?: string },
    signal?: AbortSignal,
  ): Promise<SchedulerTiming> {
    if (!target.selectOption) throw new Error('Target does not support high-level selectOption');
    const preDelayMs = await this.pauseBefore('select', signal);
    throwIfAborted(signal);
    await target.selectOption(
      typeof valueOrLabel === 'string' ? { value: valueOrLabel } : valueOrLabel,
    );
    throwIfAborted(signal);
    const postDelayMs = await this.pauseAfter('select', signal);
    return { preDelayMs, postDelayMs };
  }

  public async scroll(
    direction: Direction,
    amount: number = 1,
    signal?: AbortSignal,
    page?: SchedulerPageLike,
  ): Promise<SchedulerTiming & { steps: number; deltaX: number; deltaY: number }> {
    if (!Number.isInteger(amount) || amount < 1 || amount > HARD_MAX_SCROLL_AMOUNT) {
      throw new RangeError(`Scroll amount must be an integer from 1 to ${HARD_MAX_SCROLL_AMOUNT}`);
    }
    const actualPage = page ?? this.page;
    if (!actualPage?.mouse.wheel) throw new Error('A page with high-level mouse wheel support is required');
    const preDelayMs = await this.pauseBefore('scroll', signal);
    const viewport = actualPage.viewportSize?.() ?? { width: 1_280, height: 800 };
    const maxChunkPixels = Math.max(viewport.height, viewport.width) * 3;
    const signed = direction === 'up' ? -1 : direction === 'down' ? 1 : 0;
    const signedX = direction === 'left' ? -1 : direction === 'right' ? 1 : 0;
    let steps = 0;
    let deltaX = 0;
    let deltaY = 0;
    for (let remaining = amount; remaining > 0;) {
      throwIfAborted(signal);
      const chunkAmount = Math.min(3, remaining);
      const total = Math.min(this.scrollStepPixels * chunkAmount, maxChunkPixels);
      const chunkSteps = this.isPaced ? Math.max(1, Math.min(6, chunkAmount * 2)) : 1;

      // 拟人化惯性阻尼：多步滚动时按指数阻尼权重衰减，权重归一化保证总距离完全守恒
      const rawWeights: number[] = [];
      let weightSum = 0;
      for (let i = 0; i < chunkSteps; i += 1) {
        const w = Math.exp(-0.35 * i);
        rawWeights.push(w);
        weightSum += w;
      }

      for (let index = 0; index < chunkSteps; index += 1) {
        throwIfAborted(signal);
        const weightFraction = rawWeights[index]! / weightSum;
        const stepDeltaX = signedX * total * weightFraction;
        const stepDeltaY = signed * total * weightFraction;
        await actualPage.mouse.wheel(stepDeltaX, stepDeltaY);
        throwIfAborted(signal);
        steps += 1;
        deltaX += stepDeltaX;
        deltaY += stepDeltaY;
        if (this.isPaced && index + 1 < chunkSteps) {
          const pacingMs = Math.round(this.samplePostDelay() / chunkSteps);
          await this.sleep(Math.max(15, pacingMs), signal);
        }
      }
      remaining -= chunkAmount;
      if (this.isPaced && remaining > 0) await this.sleep(this.samplePostDelay(), signal);
    }
    throwIfAborted(signal);
    const postDelayMs = await this.pauseAfter('scroll', signal);
    return { preDelayMs, postDelayMs, steps, deltaX, deltaY };
  }
}

export function createInteractionScheduler(options: SchedulerOptions = {}): InteractionScheduler {
  return new InteractionScheduler(options);
}
