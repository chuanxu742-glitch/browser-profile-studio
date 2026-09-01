import { mergeChallengeSignals } from './signal.js';
import type { ChallengeDetection, ChallengeSignal } from './signal.js';

export type ChallengePolicyMode = 'pause';

export class ChallengePolicy {
  public readonly enabled: boolean;
  public readonly mode: ChallengePolicyMode;

  public constructor(options: { enabled?: boolean; mode?: ChallengePolicyMode } = {}) {
    this.mode = options.mode ?? 'pause';
    this.enabled = options.enabled ?? true;
    if (!this.enabled) throw new Error('Challenge pause policy cannot be disabled');
  }

  public shouldPause(detection: ChallengeDetection): boolean {
    return detection.detected;
  }

  public merge(signals: readonly ChallengeSignal[]): ChallengeSignal[] {
    return mergeChallengeSignals(signals);
  }
}

export const DEFAULT_CHALLENGE_POLICY = new ChallengePolicy();
