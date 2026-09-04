import type { GeoIpInfo } from './types.js';

export interface CountryGeoDefaults {
  readonly country: string;
  readonly countryName: string;
  readonly timezone: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly languages: readonly string[];
  readonly locale: string;
}

export const DEFAULT_GEO: CountryGeoDefaults = {
  country: 'US',
  countryName: 'United States',
  timezone: 'America/New_York',
  latitude: 40.7128,
  longitude: -74.006,
  languages: ['en-US', 'en'],
  locale: 'en-US',
};

export const COUNTRY_GEO_DEFAULTS: Record<string, CountryGeoDefaults> = {
  US: DEFAULT_GEO,
  CN: {
    country: 'CN',
    countryName: 'China',
    timezone: 'Asia/Shanghai',
    latitude: 31.2304,
    longitude: 121.4737,
    languages: ['zh-CN', 'zh', 'en'],
    locale: 'zh-CN',
  },
  GB: {
    country: 'GB',
    countryName: 'United Kingdom',
    timezone: 'Europe/London',
    latitude: 51.5074,
    longitude: -0.1278,
    languages: ['en-GB', 'en'],
    locale: 'en-GB',
  },
  JP: {
    country: 'JP',
    countryName: 'Japan',
    timezone: 'Asia/Tokyo',
    latitude: 35.6762,
    longitude: 139.6503,
    languages: ['ja-JP', 'ja', 'en-US', 'en'],
    locale: 'ja-JP',
  },
  DE: {
    country: 'DE',
    countryName: 'Germany',
    timezone: 'Europe/Berlin',
    latitude: 52.52,
    longitude: 13.405,
    languages: ['de-DE', 'de', 'en'],
    locale: 'de-DE',
  },
  FR: {
    country: 'FR',
    countryName: 'France',
    timezone: 'Europe/Paris',
    latitude: 48.8566,
    longitude: 2.3522,
    languages: ['fr-FR', 'fr', 'en'],
    locale: 'fr-FR',
  },
  SG: {
    country: 'SG',
    countryName: 'Singapore',
    timezone: 'Asia/Singapore',
    latitude: 1.3521,
    longitude: 103.8198,
    languages: ['en-SG', 'en', 'zh-CN'],
    locale: 'en-SG',
  },
  HK: {
    country: 'HK',
    countryName: 'Hong Kong',
    timezone: 'Asia/Hong_Kong',
    latitude: 22.3193,
    longitude: 114.1694,
    languages: ['zh-HK', 'zh-TW', 'zh', 'en'],
    locale: 'zh-HK',
  },
  KR: {
    country: 'KR',
    countryName: 'South Korea',
    timezone: 'Asia/Seoul',
    latitude: 37.5665,
    longitude: 126.978,
    languages: ['ko-KR', 'ko', 'en'],
    locale: 'ko-KR',
  },
  AU: {
    country: 'AU',
    countryName: 'Australia',
    timezone: 'Australia/Sydney',
    latitude: -33.8688,
    longitude: 151.2093,
    languages: ['en-AU', 'en'],
    locale: 'en-AU',
  },
  CA: {
    country: 'CA',
    countryName: 'Canada',
    timezone: 'America/Toronto',
    latitude: 43.6532,
    longitude: -79.3832,
    languages: ['en-CA', 'en', 'fr-CA'],
    locale: 'en-CA',
  },
  RU: {
    country: 'RU',
    countryName: 'Russia',
    timezone: 'Europe/Moscow',
    latitude: 55.7558,
    longitude: 37.6173,
    languages: ['ru-RU', 'ru', 'en'],
    locale: 'ru-RU',
  },
  NL: {
    country: 'NL',
    countryName: 'Netherlands',
    timezone: 'Europe/Amsterdam',
    latitude: 52.3676,
    longitude: 4.9041,
    languages: ['nl-NL', 'nl', 'en-US', 'en'],
    locale: 'nl-NL',
  },
  UA: {
    country: 'UA',
    countryName: 'Ukraine',
    timezone: 'Europe/Kyiv',
    latitude: 50.4501,
    longitude: 30.5234,
    languages: ['uk-UA', 'uk', 'en'],
    locale: 'uk-UA',
  },
  TW: {
    country: 'TW',
    countryName: 'Taiwan',
    timezone: 'Asia/Taipei',
    latitude: 25.033,
    longitude: 121.5654,
    languages: ['zh-TW', 'zh', 'en'],
    locale: 'zh-TW',
  },
};

export const TIMEZONE_COORDINATES: Record<string, { latitude: number; longitude: number }> = {
  'America/New_York': { latitude: 40.7128, longitude: -74.0060 },
  'America/Chicago': { latitude: 41.8781, longitude: -87.6298 },
  'America/Denver': { latitude: 39.7392, longitude: -104.9903 },
  'America/Los_Angeles': { latitude: 34.0522, longitude: -118.2437 },
  'America/Phoenix': { latitude: 33.4484, longitude: -112.0740 },
  'America/Anchorage': { latitude: 61.2181, longitude: -149.9003 },
  'Pacific/Honolulu': { latitude: 21.3069, longitude: -157.8583 },
  'America/Toronto': { latitude: 43.6532, longitude: -79.3832 },
  'America/Vancouver': { latitude: 49.2827, longitude: -123.1207 },
  'Europe/London': { latitude: 51.5074, longitude: -0.1278 },
  'Europe/Berlin': { latitude: 52.5200, longitude: 13.4050 },
  'Europe/Paris': { latitude: 48.8566, longitude: 2.3522 },
  'Europe/Amsterdam': { latitude: 52.3676, longitude: 4.9041 },
  'Europe/Moscow': { latitude: 55.7558, longitude: 37.6173 },
  'Europe/Kyiv': { latitude: 50.4501, longitude: 30.5234 },
  'Asia/Tokyo': { latitude: 35.6762, longitude: 139.6503 },
  'Asia/Shanghai': { latitude: 31.2304, longitude: 121.4737 },
  'Asia/Hong_Kong': { latitude: 22.3193, longitude: 114.1694 },
  'Asia/Taipei': { latitude: 25.0330, longitude: 121.5654 },
  'Asia/Singapore': { latitude: 1.3521, longitude: 103.8198 },
  'Asia/Seoul': { latitude: 37.5665, longitude: 126.9780 },
  'Australia/Sydney': { latitude: -33.8688, longitude: 151.2093 },
  'Australia/Melbourne': { latitude: -37.8136, longitude: 144.9631 },
};

export function findCoordinatesByTimezone(timezoneId?: string): { latitude: number; longitude: number } | undefined {
  if (!timezoneId) return undefined;
  return TIMEZONE_COORDINATES[timezoneId.trim()];
}

export function findGeoByCountryCode(countryCode: string): CountryGeoDefaults {
  const upper = countryCode.trim().toUpperCase();
  return COUNTRY_GEO_DEFAULTS[upper] ?? DEFAULT_GEO;
}
