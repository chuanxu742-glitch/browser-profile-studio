import type { ChallengeDetection } from './signal.js';

export interface SolverResult {
  readonly success: boolean;
  readonly token?: string;
  readonly injected?: boolean;
  readonly error?: string;
}

export interface ChallengeSolver {
  readonly id: string;
  readonly name: string;
  supports(type: string): boolean;
  solve(detection: ChallengeDetection, context: { pageUrl: string; pageEvaluate?: (script: string, arg?: unknown) => Promise<unknown> }): Promise<SolverResult>;
}

export interface WebhookSolverConfig {
  readonly endpoint: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
}

export class WebhookChallengeSolver implements ChallengeSolver {
  public readonly id = 'webhook-solver';
  public readonly name = 'Webhook/API Challenge Solver';

  public constructor(private readonly config: WebhookSolverConfig) {}

  public supports(type: string): boolean {
    return ['cloudflare_turnstile', 'recaptcha', 'hcaptcha', 'generic_challenge'].includes(type);
  }

  public async solve(
    detection: ChallengeDetection,
    context: { pageUrl: string; pageEvaluate?: (script: string, arg?: unknown) => Promise<unknown> },
  ): Promise<SolverResult> {
    if (!detection.detected) return { success: true };

    const payload = {
      challengeCategory: detection.category || 'unknown',
      pageUrl: context.pageUrl,
      signals: detection.signals,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 30_000);

    try {
      const response = await fetch(this.config.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        return { success: false, error: `Solver HTTP error: ${response.status}` };
      }

      const result = await response.json() as { success?: boolean; token?: string };
      if (!result.token) {
        return { success: false, error: 'No solution token returned by solver' };
      }

      // 如果提供了 pageEvaluate，尝试向 DOM 中注入 token
      let injected = false;
      if (context.pageEvaluate) {
        const cat = detection.category;
        if (cat === 'turnstile' || cat === 'cloudflare') {
          await context.pageEvaluate(`
            (token) => {
              const inputs = document.querySelectorAll('input[name="cf-turnstile-response"]');
              inputs.forEach(el => { el.value = token; });
              if (window.turnstile && typeof window.turnstile.callback === 'function') {
                window.turnstile.callback(token);
              }
            }
          `, result.token).catch(() => undefined);
          injected = true;
        } else if (cat === 'recaptcha' || cat === 'captcha') {
          await context.pageEvaluate(`
            (token) => {
              const el = document.getElementById('g-recaptcha-response');
              if (el) el.value = token;
            }
          `, result.token).catch(() => undefined);
          injected = true;
        }
      }

      return { success: true, token: result.token, injected };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  }
}

export class ChallengeSolverRegistry {
  private readonly solvers = new Map<string, ChallengeSolver>();

  public register(solver: ChallengeSolver): void {
    this.solvers.set(solver.id, solver);
  }

  public unregister(solverId: string): void {
    this.solvers.delete(solverId);
  }

  public findSolver(challengeType: string): ChallengeSolver | undefined {
    for (const solver of this.solvers.values()) {
      if (solver.supports(challengeType)) return solver;
    }
    return undefined;
  }
}

export const defaultSolverRegistry = new ChallengeSolverRegistry();
