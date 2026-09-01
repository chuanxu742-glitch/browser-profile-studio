import type { ProxyConfig } from '../proxy/types.js';
import type { GeoAlignmentOptions } from '../geoip/types.js';
import type { OSPlatform } from '../fingerprint/types.js';

export type CookieSameSite = 'Strict' | 'Lax' | 'None';

export interface CookieRecord {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  /** Unix timestamp in seconds */
  readonly expires?: number;
  readonly httpOnly?: boolean;
  readonly secure?: boolean;
  readonly sameSite?: CookieSameSite;
}

export type CookieFormat = 'json' | 'netscape';

export interface ProfileFingerprintSettings {
  /** Stable per-profile seed used for all deterministic fingerprint surfaces. */
  readonly seed: number;
  readonly os?: OSPlatform;
  readonly hardwareConcurrency?: number;
  readonly deviceMemory?: number;
  readonly screen?: {
    readonly width: number;
    readonly height: number;
    readonly availWidth?: number;
    readonly availHeight?: number;
    readonly colorDepth?: number;
    readonly devicePixelRatio?: number;
  };
}

export interface ProfileMetadata {
  readonly profileId: string;
  readonly name: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly proxy?: ProxyConfig;
  readonly geo?: GeoAlignmentOptions;
  readonly engine?: 'firefox' | 'chromium';
  readonly userAgent?: string;
  readonly customHeaders?: Record<string, string>;
  readonly fingerprint?: ProfileFingerprintSettings;
  readonly twoFactorSecret?: string;
  readonly proxyId?: string;
  /** Server-owned managed extension IDs assigned to this profile. */
  readonly extensionIds?: readonly string[];
}

export interface ProfileCreateOptions {
  readonly name: string;
  readonly profileId?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly proxy?: ProxyConfig;
  readonly geo?: GeoAlignmentOptions;
  readonly engine?: 'firefox' | 'chromium';
  readonly userAgent?: string;
  readonly customHeaders?: Record<string, string>;
  readonly fingerprint?: Partial<ProfileFingerprintSettings>;
  readonly twoFactorSecret?: string;
  readonly proxyId?: string;
  readonly extensionIds?: readonly string[];
  readonly initialCookies?: readonly CookieRecord[] | string;
  readonly cookieFormat?: CookieFormat;
}

export interface ProfileSummary {
  readonly profileId: string;
  readonly name: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly proxyServer?: string;
  readonly country?: string;
  readonly engine: 'firefox' | 'chromium';
  readonly tags?: readonly string[];
  readonly hasTwoFactorSecret: boolean;
  readonly proxyId?: string;
  readonly extensionIds?: readonly string[];
}
