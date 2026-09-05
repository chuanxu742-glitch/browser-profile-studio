import { findGeoByCountryCode, DEFAULT_GEO } from './database.js';
import type { GeoAlignmentOptions, GeoAlignmentResult } from './types.js';

/**
 * Derives consistent timezone, locale, geolocation, and HTTP headers
 * according to proxy/IP information or manual overrides.
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

  // Build standard Accept-Language header matching preferred languages
  const acceptLanguageHeader = languages
    .map((lang, index) => {
      if (index === 0) return lang;
      const q = Math.max(0.1, parseFloat((1.0 - index * 0.1).toFixed(1)));
      return `${lang};q=${q}`;
    })
    .join(',');

  // Fetch metadata, Accept and navigation-only headers are request-context
  // dependent. Leave them to the engine rather than applying document values
  // to every script, fetch, image and worker request in the context.
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
