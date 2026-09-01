import { describe, it, expect } from 'vitest';
import { normalizeProxyConfig } from '../../src/proxy/validator.js';
import { checkProxy } from '../../src/proxy/checker.js';

describe('Proxy Module Unit Tests', () => {
  describe('normalizeProxyConfig', () => {
    it('should parse http proxy url string correctly', () => {
      const result = normalizeProxyConfig('http://user:pass123@1.2.3.4:8080');
      expect(result.type).toBe('http');
      expect(result.server).toBe('http://1.2.3.4:8080');
      expect(result.username).toBe('user');
      expect(result.password).toBe('pass123');
      expect(result.host).toBe('1.2.3.4');
      expect(result.port).toBe(8080);
    });

    it('should parse socks5 proxy with bypass', () => {
      const result = normalizeProxyConfig({
        server: 'socks5://192.168.1.100:1080',
        username: 'admin',
        password: 'secretPassword',
        bypass: 'localhost,*.internal',
      });
      expect(result.type).toBe('socks5');
      expect(result.server).toBe('socks5://192.168.1.100:1080');
      expect(result.username).toBe('admin');
      expect(result.password).toBe('secretPassword');
      expect(result.bypass).toBe('localhost,*.internal');
    });

    it('should auto-detect scheme and default ports', () => {
      const resultHttp = normalizeProxyConfig({
        server: '10.0.0.1',
        type: 'http',
      });
      expect(resultHttp.server).toBe('http://10.0.0.1:8080');
      expect(resultHttp.port).toBe(8080);

      const resultSocks = normalizeProxyConfig({
        server: '10.0.0.2',
        type: 'socks5',
      });
      expect(resultSocks.server).toBe('socks5://10.0.0.2:1080');
      expect(resultSocks.port).toBe(1080);
    });

    it('should throw error for unsupported protocols', () => {
      expect(() => normalizeProxyConfig('ftp://1.2.3.4:21')).toThrow(/Unsupported proxy protocol/);
    });

    it('should throw error for empty proxy', () => {
      expect(() => normalizeProxyConfig('')).toThrow(/empty/);
    });
  });

  describe('checkProxy', () => {
    it('should gracefully handle unreachable proxy connection failure', async () => {
      // Connecting to an unallocated non-listening loopback port
      const result = await checkProxy('http://127.0.0.1:59999', { timeoutMs: 500 });
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should reject invalid proxy configuration immediately', async () => {
      const result = await checkProxy('ftp://bad-proxy', { timeoutMs: 500 });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Invalid proxy config/);
    });
  });
});
