import {
  CHALLENGE_CONTAINER_SELECTORS,
  CHALLENGE_IFRAME_SELECTORS,
  CHALLENGE_TEXT_PATTERNS,
  CHALLENGE_STRONG_TEXT_PATTERNS,
  CHALLENGE_WEAK_TEXT_PATTERNS,
  CHALLENGE_TITLE_PATTERNS,
  CHALLENGE_STRONG_TITLE_PATTERNS,
  CHALLENGE_WEAK_TITLE_PATTERNS,
  CHALLENGE_URL_PATTERNS,
  CHALLENGE_STRONG_URL_PATTERNS,
  CHALLENGE_WEAK_URL_PATTERNS,
} from './signatures.js';
import {
  challengeCategoryFor,
  mergeChallengeSignals,
  sanitizeOrigin,
} from './signal.js';
import type {
  ChallengeContainerObservation,
  ChallengeDetection,
  ChallengeObservation,
  ChallengeSignal,
  ChallengeSignalSource,
} from './signal.js';

export interface ChallengeLocatorLike {
  count(): Promise<number>;
  nth(index: number): ChallengeLocatorLike;
  innerText?(options?: Record<string, unknown>): Promise<string>;
  textContent?(options?: Record<string, unknown>): Promise<string | null>;
  getAttribute?(name: string, options?: Record<string, unknown>): Promise<string | null>;
}

export interface ChallengeFrameLike {
  url(): string;
}

/** Read-only subset of Playwright's Page used by the detector. */
export interface ChallengePageLike {
  url(): string;
  title(): Promise<string>;
  locator(selector: string): ChallengeLocatorLike;
  frames?(): readonly ChallengeFrameLike[];
}

export interface ChallengeDetectorOptions {
  /** Optional additional fixed marker patterns maintained by the host app. */
  additionalUrlPatterns?: readonly RegExp[];
  additionalTitlePatterns?: readonly RegExp[];
  additionalTextPatterns?: readonly RegExp[];
  /** Keep the detector conservative for weak text such as a lone 403 page. */
  requireStrongSignalForDetection?: boolean;
  now?: () => Date;
}

function asText(value: string | null | undefined): string {
  return typeof value === 'string' ? value.slice(0, 100_000) : '';
}

function markerFromMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/gi, ' ').trim().slice(0, 80);
}

function makeSignal(
  source: ChallengeSignalSource,
  marker: string,
  confidence: ChallengeSignal['confidence'],
  observedAt: string,
  origin?: string,
  status?: number,
): ChallengeSignal {
  const safeMarker = markerFromMatch(marker) || source;
  return {
    source,
    marker: safeMarker,
    category: challengeCategoryFor(safeMarker),
    confidence,
    observedAt,
    ...(origin ? { origin } : {}),
    ...(typeof status === 'number' ? { status } : {}),
  };
}

function matchingMarker(value: string, patterns: readonly RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match?.[0]) return match[0];
  }
  return undefined;
}

function hasStrongSignal(signals: readonly ChallengeSignal[]): boolean {
  return signals.some((signal) => signal.confidence === 'high');
}

function isWeakResponseOnly(signals: readonly ChallengeSignal[]): boolean {
  return signals.length > 0 && signals.every((signal) => signal.source === 'response');
}

export class ChallengeDetector {
  private readonly options: ChallengeDetectorOptions;

  public constructor(options: ChallengeDetectorOptions = {}) {
    this.options = options;
  }

  /** Detect from an already collected, non-secret page observation. */
  public detectObservation(observation: ChallengeObservation): ChallengeDetection {
    const observedAt = (this.options.now ?? (() => new Date()))().toISOString();
    const signals: ChallengeSignal[] = [];
    const url = observation.url ?? '';
    const origin = sanitizeOrigin(url);
    const strongUrlMarker = matchingMarker(url, [...CHALLENGE_STRONG_URL_PATTERNS, ...(this.options.additionalUrlPatterns ?? [])]);
    if (strongUrlMarker) {
      signals.push(makeSignal('url', strongUrlMarker, 'high', observedAt, origin));
    } else {
      const weakUrlMarker = matchingMarker(url, CHALLENGE_WEAK_URL_PATTERNS);
      if (weakUrlMarker) {
        signals.push(makeSignal('url', weakUrlMarker, 'low', observedAt, origin));
      }
    }

    const title = asText(observation.title);
    const strongTitleMarker = matchingMarker(title, [...CHALLENGE_STRONG_TITLE_PATTERNS, ...(this.options.additionalTitlePatterns ?? [])]);
    if (strongTitleMarker) {
      signals.push(makeSignal('title', strongTitleMarker, 'high', observedAt, origin));
    } else {
      const weakTitleMarker = matchingMarker(title, CHALLENGE_WEAK_TITLE_PATTERNS);
      if (weakTitleMarker) {
        signals.push(makeSignal('title', weakTitleMarker, 'low', observedAt, origin));
      }
    }

    const text = asText(observation.text);
    const strongTextMarker = matchingMarker(text, [...CHALLENGE_STRONG_TEXT_PATTERNS, ...(this.options.additionalTextPatterns ?? [])]);
    if (strongTextMarker) {
      signals.push(makeSignal('text', strongTextMarker, 'medium', observedAt, origin));
    } else {
      const weakTextMarker = matchingMarker(text, CHALLENGE_WEAK_TEXT_PATTERNS);
      if (weakTextMarker) {
        signals.push(makeSignal('text', weakTextMarker, 'low', observedAt, origin));
      }
    }

    for (const iframeUrl of [
      ...(observation.iframeUrls ?? []),
      ...(observation.iframes ?? []),
      ...(observation.iframe ?? []),
      ...(observation.frameUrls ?? []),
    ]) {
      const marker = matchingMarker(iframeUrl, CHALLENGE_URL_PATTERNS);
      if (marker) signals.push(makeSignal('iframe', marker, 'high', observedAt, sanitizeOrigin(iframeUrl)));
    }

    for (const container of [...(observation.containers ?? []), ...(observation.container ?? [])]) {
      const normalized: ChallengeContainerObservation = typeof container === 'string'
        ? { marker: container }
        : container;
      const candidate = [normalized.selector, normalized.id, normalized.className, normalized.marker, normalized.text]
        .filter(Boolean)
        .join(' ');

      let matchedContainerMarker: string | undefined;
      const lowerCandidate = candidate.toLowerCase();
      for (const sel of CHALLENGE_CONTAINER_SELECTORS) {
        const cleanSel = sel.toLowerCase().replace(/[#[\]'".=*]/g, '');
        if ((normalized.selector && normalized.selector.toLowerCase().includes(sel.toLowerCase())) || lowerCandidate.includes(cleanSel)) {
          matchedContainerMarker = sel;
          break;
        }
      }
      if (!matchedContainerMarker) {
        matchedContainerMarker = matchingMarker(candidate, [
          ...CHALLENGE_URL_PATTERNS,
          ...CHALLENGE_TITLE_PATTERNS,
          ...CHALLENGE_TEXT_PATTERNS,
        ]);
      }
      if (matchedContainerMarker) {
        signals.push(makeSignal('container', matchedContainerMarker, 'high', observedAt, origin));
      }
    }

    if (typeof observation.responseStatus === 'number' && [403, 429].includes(observation.responseStatus)) {
      signals.push(makeSignal('response', String(observation.responseStatus), 'low', observedAt, origin, observation.responseStatus));
    }

    const merged = mergeChallengeSignals(signals);
    const responseOnly = isWeakResponseOnly(merged);
    const hasStructuralSignal = merged.some((s) => s.source === 'iframe' || s.source === 'container');
    const hasUrlSignal = merged.some((s) => s.source === 'url' && s.confidence === 'high');
    const hasStrongTitleSignal = merged.some((s) => s.source === 'title' && s.confidence === 'high');
    const distinctSources = new Set(merged.map((s) => s.source));

    // 严密判定：单纯正文或标题提及 CAPTCHA 等弱词绝不单独判定，必须与实际 iframe、container、URL 或强标题组合
    let detected = false;
    if (!responseOnly && merged.length > 0) {
      if (this.options.requireStrongSignalForDetection === false) {
        detected = true;
      } else {
        if (hasStructuralSignal || hasUrlSignal) {
          detected = true;
        } else if (hasStrongTitleSignal && (distinctSources.size > 1 || hasStrongSignal(merged))) {
          detected = true;
        } else if (distinctSources.size >= 2 && merged.some((s) => s.confidence === 'high')) {
          detected = true;
        }
      }
    }

    const category = merged.find((signal) => signal.category !== 'unknown')?.category;
    return {
      detected,
      isChallenge: detected,
      signals: merged,
      observedAt,
      ...(category ? { category } : {}),
      ...(detected ? { reason: 'A read-only challenge signature was observed' } : {}),
    };
  }

  /** Alias useful for callers that keep observations in a scanner pipeline. */
  public inspect(observation: ChallengeObservation): ChallengeDetection {
    return this.detectObservation(observation);
  }

  /**
   * Collect only read-only, high-level page metadata and run detection.  No
   * evaluate(), DOM event, click, or challenge interaction is performed.
   */
  public async detectPage(page: ChallengePageLike): Promise<ChallengeDetection> {
    const url = safePageUrl(page);
    let title = '';
    try {
      title = await page.title();
    } catch {
      // A page can close while an observer is scanning.  Missing title is safe.
    }

    let text = '';
    try {
      const body = page.locator('body');
      if (body.innerText) text = asText(await body.innerText({ timeout: 1_000 }));
      else if (body.textContent) text = asText(await body.textContent({ timeout: 1_000 }));
    } catch {
      // Keep scanning URL/frame/container signals when the body is unavailable.
    }

    const iframeUrls: string[] = [];
    try {
      const iframeLocator = page.locator('iframe');
      const count = Math.min(await iframeLocator.count(), 100);
      for (let index = 0; index < count; index += 1) {
        const frame = iframeLocator.nth(index);
        const src = frame.getAttribute ? await frame.getAttribute('src') : null;
        if (src) iframeUrls.push(src);
      }
    } catch {
      // Frame enumeration is best effort and remains read-only.
    }

    const frameUrls: string[] = [];
    try {
      for (const frame of page.frames?.() ?? []) {
        const frameUrl = frame.url();
        if (frameUrl) frameUrls.push(frameUrl);
      }
    } catch {
      // Ignore a frame that detached during inspection.
    }

    const containers: ChallengeContainerObservation[] = [];
    for (const selector of CHALLENGE_CONTAINER_SELECTORS) {
      try {
        const locator = page.locator(selector);
        const count = Math.min(await locator.count(), 20);
        for (let index = 0; index < count; index += 1) {
          const container = locator.nth(index);
          const textContent = container.innerText
            ? await container.innerText({ timeout: 500 }).catch(() => '')
            : container.textContent
              ? await container.textContent({ timeout: 500 }).catch(() => null)
              : null;
          containers.push({
            selector,
            text: asText(textContent),
            marker: selector,
          });
        }
      } catch {
        // A missing optional selector is not an error.
      }
    }

    return this.detectObservation({ url, title, text, iframeUrls, frameUrls, containers });
  }

  public async detect(page: ChallengePageLike | ChallengeObservation): Promise<ChallengeDetection> {
    if (isPageLike(page)) return this.detectPage(page);
    return this.detectObservation(page);
  }

  public async scan(page: ChallengePageLike): Promise<ChallengeDetection> {
    return this.detectPage(page);
  }
}

function isPageLike(value: ChallengePageLike | ChallengeObservation): value is ChallengePageLike {
  return typeof (value as ChallengePageLike).locator === 'function' && typeof (value as ChallengePageLike).title === 'function';
}

function safePageUrl(page: ChallengePageLike): string {
  try {
    return page.url();
  } catch {
    return '';
  }
}

export default ChallengeDetector;
