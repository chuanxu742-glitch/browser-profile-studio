export type ChallengeCategory =
  | 'cloudflare'
  | 'turnstile'
  | 'captcha'
  | 'recaptcha'
  | 'hcaptcha'
  | 'robot_check'
  | 'verification'
  | 'interstitial'
  | 'unknown';

export type ChallengeSignalSource = 'url' | 'title' | 'text' | 'iframe' | 'container' | 'response' | 'frame';

export interface ChallengeSignal {
  category: ChallengeCategory;
  source: ChallengeSignalSource;
  /** A stable, non-secret marker, never the page's complete text or URL. */
  marker: string;
  confidence: 'low' | 'medium' | 'high';
  observedAt: string;
  origin?: string;
  status?: number;
}

export interface ChallengeDetection {
  detected: boolean;
  /** Backwards-compatible, descriptive alias for callers that prefer a predicate name. */
  isChallenge?: boolean;
  category?: ChallengeCategory;
  signals: ChallengeSignal[];
  observedAt: string;
  reason?: string;
}

export interface ChallengeObservation {
  url?: string;
  title?: string;
  text?: string;
  iframeUrls?: readonly string[];
  iframes?: readonly string[];
  iframe?: readonly string[];
  frameUrls?: readonly string[];
  containers?: readonly (string | ChallengeContainerObservation)[];
  container?: readonly (string | ChallengeContainerObservation)[];
  responseStatus?: number;
}

export interface ChallengeContainerObservation {
  selector?: string;
  id?: string;
  className?: string;
  text?: string;
  marker?: string;
}

export function sanitizeOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.origin;
  } catch {
    return undefined;
  }
}

export function challengeCategoryFor(marker: string): ChallengeCategory {
  const normalized = marker.toLowerCase();
  if (normalized.includes('turnstile')) return 'turnstile';
  if (normalized.includes('hcaptcha')) return 'hcaptcha';
  if (normalized.includes('recaptcha')) return 'recaptcha';
  if (normalized.includes('cloudflare') || normalized.includes('cf-chl') || normalized.includes('cdn-cgi')) {
    return 'cloudflare';
  }
  if (normalized.includes('captcha')) return 'captcha';
  if (normalized.includes('robot') || normalized.includes('human')) return 'robot_check';
  if (normalized.includes('verify') || normalized.includes('verification') || normalized.includes('security')) {
    return 'verification';
  }
  return 'unknown';
}

export function mergeChallengeSignals(signals: readonly ChallengeSignal[]): ChallengeSignal[] {
  const unique = new Map<string, ChallengeSignal>();
  for (const signal of signals) {
    const key = [signal.source, signal.category, signal.marker, signal.origin ?? '', signal.status ?? ''].join('|');
    if (!unique.has(key)) unique.set(key, signal);
  }
  return [...unique.values()];
}
