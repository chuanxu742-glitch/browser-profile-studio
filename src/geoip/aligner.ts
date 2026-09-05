import { findGeoByCountryCode } from './database.js';
import type { GeoAlignmentOptions, GeoAlignmentResult } from './types.js';

/**
 * Applies country presets and explicit overrides; this is not an IP lookup.
 * Country defaults are suggestions, not measured egress language or coordinates.
 */
export function alignGeoEnvironment(options: GeoAlignmentOptions = {}): GeoAlignmentResult {
  const countryCode = options.countryCode ? options.countryCode.toUpperCase() : 'US';
  const defaults = findGeoByCountryCode(countryCode);

  const timezoneId = options.timezone || defaults.timezone;
  const locale = options.locale || defaults.locale;
  const languages = options.locale ? [options.locale] : defaults.languages;

  const latitude = options.geolocation?.latitude ?? defaults.latitude;
  const longitude = options.geolocation?.longitude ?? defaults.longitude;
  const accuracy = options.geolocation?.accuracy ?? 100;
  // Validate caller overrides without deriving a language or exact position
  // from an IP address. Countries can legitimately span several timezones.
  new Intl.DateTimeFormat(locale, { timeZone: timezoneId });
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      !Number.isFinite(longitude) || longitude < -180 || longitude > 180 ||
      !Number.isFinite(accuracy) || accuracy < 0) {
    throw new Error('GEOLOCATION_INVALID');
  }

  // Build standard Accept-Language header matching preferred languages
  const acceptLanguageHeader = languages
    .map((lang, index) => {
      if (index === 0) return lang;
      const q = Math.max(0.1, parseFloat((1.0 - index * 0.1).toFixed(1)));
      return `${lang};q=${q}`;
    })
    .join(',');

  const extraHeaders: Record<string, string> = {
    'Accept-Language': acceptLanguageHeader,
  };

  return {
    timezoneId,
    locale,
    languages,
    geolocation: {
      latitude,
      longitude,
      accuracy,
    },
    country: defaults.country,
    extraHeaders,
  };
}
