import { describe, it, expect } from 'vitest';
import { generateFingerprint } from '../../src/fingerprint/generator.js';
import { buildStealthInjectionScript } from '../../src/fingerprint/stealth-scripts.js';
import { managedBrowserIdentity } from '../../src/fingerprint/runtime-identity.js';

describe('Fingerprint and Stealth Engine Unit Tests', () => {
  describe('generateFingerprint', () => {
    it('should generate consistent deterministic fingerprint from same seed', () => {
      const fp1 = generateFingerprint(12345, 'windows');
      const fp2 = generateFingerprint(12345, 'windows');

      expect(fp1.hardware.hardwareConcurrency).toBe(fp2.hardware.hardwareConcurrency);
      expect(fp1.hardware.deviceMemory).toBe(fp2.hardware.deviceMemory);
      expect(fp1.hardware.screenWidth).toBe(fp2.hardware.screenWidth);
      expect(fp1.webgl.renderer).toBe(fp2.webgl.renderer);
      expect(fp1.canvas.seed).toBe(fp2.canvas.seed);
      expect(fp1.audio.seed).toBe(fp2.audio.seed);
      expect(fp1.hardware.platform).toBe('Win32');
    });

    it('should generate platform specific GPU and platform string for macOS', () => {
      const macFp = generateFingerprint(999, 'macos');
      expect(macFp.hardware.platform).toBe('MacIntel');
      expect(macFp.webgl.vendor).toBe('Apple Inc.');
      expect(macFp.webgl.renderer).toContain('Apple');
    });

    it('keeps engine-specific and GeoIP surfaces in one profile', () => {
      const firefoxFp = generateFingerprint({ seed: 111, engine: 'firefox', countryCode: 'JP' });
      const chromiumFp = generateFingerprint({ seed: 111, engine: 'chromium', countryCode: 'US' });

      expect(firefoxFp.engine).toBe('firefox');
      expect(firefoxFp.browserVersion).toBe(managedBrowserIdentity('firefox').fullVersion);
      expect(firefoxFp.userAgent).toContain('Firefox/');
      expect(firefoxFp.userAgent).toContain(`Firefox/${managedBrowserIdentity('firefox').majorVersion}.0`);
      expect(firefoxFp.webgpu.supported).toBe(false);
      expect(firefoxFp.geo.timezoneId).toBe('Asia/Tokyo');
      expect(firefoxFp.geo.languages[0]).toBe('ja-JP');
      expect(firefoxFp.stealth.blockServiceWorkers).toBe(false);

      expect(chromiumFp.engine).toBe('chromium');
      expect(chromiumFp.browserVersion).toBe(managedBrowserIdentity('chromium').fullVersion);
      expect(chromiumFp.userAgent).toContain('Chrome/');
      expect(chromiumFp.userAgent).toContain(`Chrome/${managedBrowserIdentity('chromium').majorVersion}.0.0.0`);
      expect(chromiumFp.webgpu.supported).toBe(true);
      expect(chromiumFp.geo.timezoneId).toBe('America/New_York');
    });

    it('uses coherent Linux platform values and validates explicit browser versions', () => {
      const linux = generateFingerprint({ seed: 7, engine: 'chromium', os: 'linux' });
      expect(linux.platform).toBe('Linux x86_64');
      expect(linux.hardware.platform).toBe('Linux x86_64');
      expect(linux.userAgent).toContain('X11; Linux x86_64');
      expect(() => generateFingerprint({ engine: 'chromium', browserVersion: 'not-a-version' })).toThrow('BROWSER_VERSION_INVALID');
    });

  });

  describe('buildStealthInjectionScript', () => {
    it('should produce valid executable JavaScript containing all anti-detect hooks', () => {
      const fp = generateFingerprint(42, 'windows');
      const script = buildStealthInjectionScript(fp);

      // Verify webdriver removal hook
      expect(script).toContain('Navigator.prototype');
      expect(script).toContain('webdriver');
      // Verify plugins spoofing
      expect(script).toContain('PDF Viewer');
      expect(script).toContain('PluginArray');
      // Verify hardware spoofing
      expect(script).toContain('hardwareConcurrency');
      expect(script).toContain('deviceMemory');
      // Verify chrome runtime mocking
      expect(script).toContain('window.chrome');
      expect(script).toContain('loadTimes');
      // Verify Canvas 2D noise hook
      expect(script).toContain('getImageData');
      // Verify WebGL hook
      expect(script).toContain('UNMASKED_VENDOR_WEBGL');
      expect(script).toContain('UNMASKED_RENDERER_WEBGL');
      // Verify WebRTC shield hook
      expect(script).toContain('RTCPeerConnection');
      // Verify Function.prototype.toString defense
      expect(script).toContain('native code');
      expect(script).toContain('if (!isFirefoxEngine && navigatorObject)');
      expect(script).toContain("config.os === 'linux' ? 'Linux' : 'Windows'");
      expect(script).toContain("String(config.browserVersion).split('.')[0]");
      expect(script).not.toContain("version: '126'");
    });
  });
});
