import { describe, it, expect } from 'vitest';
import { findGeoByCountryCode, DEFAULT_GEO } from '../../src/geoip/database.js';
import { alignGeoEnvironment } from '../../src/geoip/aligner.js';

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
