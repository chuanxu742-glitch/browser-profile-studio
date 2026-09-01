export interface ApiResponse<T = unknown> {
  readonly success: boolean;
  readonly code: string;
  readonly data?: T;
  readonly message?: string;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
  readonly timestamp: number;
}

export interface BrowserStartResponseData {
  readonly sessionId: string;
  readonly state: string;
  readonly headless: boolean;
  readonly cdpEndpoint?: string;
  readonly wsEndpoint?: string;
  readonly debugPort?: number;
}
