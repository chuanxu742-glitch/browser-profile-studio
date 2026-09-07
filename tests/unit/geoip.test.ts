import { describe, it, expect } from 'vitest';
import { findGeoByCountryCode, findCoordinatesByTimezone, DEFAULT_GEO } from '../../src/geoip/database.js';
import { alignGeoEnvironment } from '../../src/geoip/aligner.js';
import { generateFingerprint } from '../../src/fingerprint/generator.js';

describe('GeoIP Module Unit Tests', () => {
  describe('database lookup', () => {
    it('should find US defaults', () => {
      const geo = findGeoByCountryCode('US');
      expect(geo.country).toBe('US');
      expect(geo.timezone).toBe('America/New_York');
      expect(geo.locale).toBe('en-US');
      expect(geo.latitude).toBeCloseTo(40.7128);
    });

    it('should find CN and JP defaults', () => {
      const cn = findGeoByCountryCode('cn');
      expect(cn.country).toBe('CN');
      expect(cn.timezone).toBe('Asia/Shanghai');
      expect(cn.locale).toBe('zh-CN');

      const jp = findGeoByCountryCode('JP');
      expect(jp.country).toBe('JP');
      expect(jp.timezone).toBe('Asia/Tokyo');
      expect(jp.locale).toBe('ja-JP');
    });

    it('should fallback to default for unknown country code', () => {
      const unknown = findGeoByCountryCode('ZZ');
      expect(unknown).toEqual(DEFAULT_GEO);
    });
  });

  describe('alignGeoEnvironment', () => {
    it('leaves request-specific headers to the browser', () => {
      expect(alignGeoEnvironment({ countryCode: 'JP' }).extraHeaders).toEqual({
        'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
      });
    });

    it('uses the selected timezone coordinates unless location is explicit', () => {
      const aligned = alignGeoEnvironment({ countryCode: 'US', timezone: 'America/Los_Angeles' });
      expect(aligned.geolocation).toEqual({ latitude: 34.0522, longitude: -118.2437, accuracy: 100 });
      const manual = alignGeoEnvironment({
        timezone: 'America/Los_Angeles',
        geolocation: { latitude: 0, longitude: 0, accuracy: 0 },
      });
      expect(manual.geolocation).toEqual({ latitude: 0, longitude: 0, accuracy: 0 });
    });

    it('does not treat inherited object properties as timezone coordinates', () => {
      expect(findCoordinatesByTimezone('constructor')).toBeUndefined();
      expect(findCoordinatesByTimezone('__proto__')).toBeUndefined();
      expect(alignGeoEnvironment({ timezone: 'Etc/UTC' }).geolocation.latitude).toBe(DEFAULT_GEO.latitude);
    });

    it('does not share mutable language arrays between sessions', () => {
      const first = alignGeoEnvironment({ countryCode: 'JP' });
      (first.languages as string[]).push('invalid');
      expect(alignGeoEnvironment({ countryCode: 'JP' }).languages).not.toContain('invalid');
    });

    it('keeps an explicit locale consistent in generated profiles and launch headers', () => {
      const options = { countryCode: 'JP', locale: 'de-DE' };
      const profile = generateFingerprint({ seed: 123, ...options });
      const aligned = alignGeoEnvironment(options);
      expect(profile.geo.locale).toBe(aligned.locale);
      expect(profile.geo.languages).toEqual(aligned.languages);
      expect(profile.geo.languages[0]).toBe(aligned.extraHeaders['Accept-Language']);
    });

    it('copies explicit language preferences into each generated profile', () => {
      const languages = ['de-DE', 'de'];
      const profile = generateFingerprint({ seed: 123, locale: 'de-DE', languages });
      languages.push('en');
      expect(profile.geo.languages).toEqual(['de-DE', 'de']);
    });

    it('should calculate aligned timezone and headers for country', () => {
      const aligned = alignGeoEnvironment({ countryCode: 'JP' });
      expect(aligned.timezoneId).toBe('Asia/Tokyo');
      expect(aligned.locale).toBe('ja-JP');
      expect(aligned.geolocation.latitude).toBeCloseTo(35.6762);
      expect(aligned.extraHeaders['Accept-Language']).toContain('ja-JP');
    });

    it('should allow manual overrides for timezone and locale', () => {
      const aligned = alignGeoEnvironment({
        countryCode: 'US',
        timezone: 'America/Los_Angeles',
        locale: 'en-GB',
        geolocation: { latitude: 34.0522, longitude: -118.2437 },
      });
      expect(aligned.timezoneId).toBe('America/Los_Angeles');
      expect(aligned.extraHeaders['Accept-Language']).toBe('en-GB');
      expect(aligned.locale).toBe('en-GB');
      expect(aligned.geolocation.latitude).toBeCloseTo(34.0522);
      expect(aligned.geolocation.longitude).toBeCloseTo(-118.2437);
    });
  });
});
