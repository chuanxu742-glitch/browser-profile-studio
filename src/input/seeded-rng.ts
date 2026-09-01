/**
 * A small deterministic pseudo random number generator.
 *
 * The generator is deliberately kept local to an interaction/session.  It is
 * useful for replaying a test or a UI demo, but it is not intended to model a
 * person's behaviour or to make an automated browser less detectable.
 */
export class SeededRng {
  private state: number;

  public readonly seed: number;

  public constructor(seed: number) {
    if (!Number.isFinite(seed) || !Number.isInteger(seed)) {
      throw new TypeError('Seed must be a finite integer');
    }

    // Keep the public seed in the documented uint32 range while accepting the
    // complete signed 32-bit range for callers that use a persisted seed.
    this.seed = seed >>> 0;
    this.state = this.seed || 0x6d2b79f5;
  }

  /** Return a deterministic value in [0, 1). */
  public next(): number {
    // Mulberry32.  All arithmetic is intentionally unsigned 32 bit so the
    // sequence is stable on every JavaScript runtime.
    let value = (this.state += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    this.state = value >>> 0;
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  }

  /** Return a deterministic floating point value in [min, max). */
  public float(min = 0, max = 1): number {
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
      throw new RangeError('Invalid random range');
    }
    if (min === max) return min;
    return min + (max - min) * this.next();
  }

  /** Return a deterministic integer in the inclusive range [min, max]. */
  public int(min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) {
      throw new RangeError('Invalid integer random range');
    }
    if (min === max) return min;
    return min + Math.floor(this.next() * (max - min + 1));
  }

  public pick<T>(values: readonly T[]): T {
    if (values.length === 0) throw new RangeError('Cannot pick from an empty list');
    return values[this.int(0, values.length - 1)] as T;
  }

  /** Create an independent deterministic stream derived from this stream. */
  public fork(label = ''): SeededRng {
    let hash = 2166136261;
    for (const character of label) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return new SeededRng((this.int(0, 0xffff_ffff) ^ hash) >>> 0);
  }

  /** Return a copy at the current point in the sequence. */
  public clone(): SeededRng {
    const copy = new SeededRng(this.seed);
    copy.state = this.state;
    return copy;
  }
}

export const SeededRandom = SeededRng;
export const createSeededRng = (seed: number): SeededRng => new SeededRng(seed);

