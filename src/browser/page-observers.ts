import { ChallengeDetector } from '../challenge/detector.js';
import type { ChallengePageLike } from '../challenge/detector.js';

export interface ObservablePageLike extends ChallengePageLike {
  on?(event: string, listener: (...args: unknown[]) => void): void;
}

export interface PageObserverHandlers {
  detector?: ChallengeDetector;
  onChallenge?: (detection: Awaited<ReturnType<ChallengeDetector['detectPage']>>) => void | Promise<void>;
  onGenerationChange?: () => void;
  onPopup?: (page: unknown) => void | Promise<void>;
  onDownload?: (download: unknown) => void | Promise<void>;
  onDialog?: (dialog: unknown) => void | Promise<void>;
  onCrash?: () => void | Promise<void>;
}

/**
 * Install only high-level Playwright page observers.  The helper deliberately
 * performs no DOM mutation and does not expose raw protocol/evaluate hooks.
 */
export function installPageObservers(page: ObservablePageLike, handlers: PageObserverHandlers = {}): void {
  const on = page.on?.bind(page);
  if (!on) return;

  const scan = (): void => {
    if (!handlers.detector || !handlers.onChallenge) return;
    void handlers.detector.detectPage(page).then((detection) => {
      if (detection.detected) return handlers.onChallenge?.(detection);
      return undefined;
    }).catch(() => undefined);
  };

  on('framenavigated', () => {
    handlers.onGenerationChange?.();
    scan();
  });
  on('frameattached', scan);
  on('domcontentloaded', scan);
  on('load', scan);
  on('popup', (...args: unknown[]) => {
    if (args[0] !== undefined) void handlers.onPopup?.(args[0]);
  });
  on('download', (...args: unknown[]) => {
    if (args[0] !== undefined) void handlers.onDownload?.(args[0]);
  });
  on('dialog', (...args: unknown[]) => {
    if (args[0] !== undefined) void handlers.onDialog?.(args[0]);
  });
  on('crash', () => {
    void handlers.onCrash?.();
  });
}

export const observePage = installPageObservers;

