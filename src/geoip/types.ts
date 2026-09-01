export interface GeoIpInfo {
  readonly ip?: string;
  readonly country: string; // ISO 2-letter country code, e.g. "US", "CN", "GB", "JP"
  readonly countryName?: string;
  readonly region?: string;
  readonly city?: string;
  readonly timezone: string; // IANA Timezone, e.g. "America/New_York", "Asia/Shanghai"
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracy?: number;
  readonly languages: readonly string[]; // Preferred language tags, e.g. ["en-US", "en"]
}

export interface GeoAlignmentOptions {
  /** Target IP address or hostname to match */
  readonly ipOrHost?: string;
  /** Explicit ISO 2-letter country code override, e.g. "US", "JP" */
  readonly countryCode?: string;
  /** Explicit timezone override, e.g. "America/Los_Angeles" */
  readonly timezone?: string;
  /** Explicit locale override, e.g. "en-US" */
  readonly locale?: string;
  /** Explicit geolocation override */
  readonly geolocation?: {
    latitude: number;
    longitude: number;
    accuracy?: number;
  };
}

export interface GeoAlignmentResult {
  readonly timezoneId: string;
  readonly locale: string;
  readonly languages: readonly string[];
  readonly geolocation: {
    latitude: number;
    longitude: number;
    accuracy: number;
  };
  readonly country: string;
  readonly extraHeaders: Record<string, string>;
}
