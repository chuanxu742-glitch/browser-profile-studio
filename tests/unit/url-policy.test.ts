import { describe, expect, it } from 'vitest';

import { BrowserToolError } from '../../src/domain.js';
import {
  classifyAddress,
  matchesHost,
  UrlPolicy,
} from '../../src/policy/url-policy.js';

const publicResolver = async (): Promise<readonly string[]> => ['93.184.216.34'];

describe('UrlPolicy', () => {
  it('allows approved HTTPS hosts and preserves the URL for navigation', async () => {
    const policy = new UrlPolicy({ allowedHosts: ['example.test'], resolver: publicResolver });
    const result = await policy.assertAllowed('https://example.test/path?q=secret', 'navigation');
    expect(result.href).toBe('https://example.test/path?q=secret');
  });

  it('uses DNS label-boundary wildcard matching for navigation and resources', async () => {
    expect(matchesHost('a.example.com', ['*.example.com'])).toBe(true);
    expect(matchesHost('a.b.example.com', ['*.example.com'])).toBe(false);
    expect(matchesHost('example.com', ['*.example.com'])).toBe(false);
    expect(matchesHost('notexample.com', ['*.example.com'])).toBe(false);

    const policy = new UrlPolicy({
      allowedHosts: ['example.test'],
      resourceHosts: ['static.example.test'],
      resolver: publicResolver,
    });
    await expect(policy.assertAllowed('https://static.example.test/app.js', 'resource')).resolves.toBeInstanceOf(URL);
    await expect(policy.assertAllowed('https://example.test/app.js', 'resource')).rejects.toMatchObject({
      code: 'DOMAIN_NOT_ALLOWED',
    });
  });

  it('blocks unsupported schemes, credentials, and unauthorized hosts before DNS', async () => {
    let calls = 0;
    const resolver = async (): Promise<readonly string[]> => {
      calls += 1;
      return ['93.184.216.34'];
    };
    const policy = new UrlPolicy({ allowedHosts: ['example.test'], resolver });
    await expect(policy.assertAllowed('http://example.test/', 'navigation')).rejects.toMatchObject({
      code: 'NAVIGATION_BLOCKED',
    });
    await expect(policy.assertAllowed('https://user:pass@example.test/', 'navigation')).rejects.toMatchObject({
      code: 'NAVIGATION_BLOCKED',
    });
    await expect(policy.assertAllowed('https://other.test/', 'navigation')).rejects.toMatchObject({
      code: 'DOMAIN_NOT_ALLOWED',
    });
    expect(calls).toBe(0);
  });

  it('permits HTTP only when server policy opts in', async () => {
    const denied = new UrlPolicy({ allowedHosts: ['example.test'], resolver: publicResolver });
    await expect(denied.assertAllowed('http://example.test/', 'navigation')).rejects.toBeInstanceOf(BrowserToolError);

    const allowed = new UrlPolicy({ allowedHosts: ['example.test'], allowHttp: true, resolver: publicResolver });
    await expect(allowed.assertAllowed('http://example.test/', 'navigation')).resolves.toBeInstanceOf(URL);
  });

  it('blocks private, loopback, link-local, multicast, reserved, and metadata destinations', async () => {
    const cases = [
      '127.0.0.1',
      '10.0.0.2',
      '172.16.0.1',
      '192.168.1.5',
      '169.254.1.2',
      '224.0.0.1',
      '0.0.0.0',
      '169.254.169.254',
      '[::1]',
      '[fc00::1]',
      '[fe80::1]',
      '[ff02::1]',
      '[::ffff:127.0.0.1]',
    ];
    for (const host of cases) {
      const policy = new UrlPolicy({ allowedHosts: [host], allowHttp: true });
      await expect(policy.assertAllowed(`http://${host}/`, 'navigation')).rejects.toMatchObject({
        code: 'PRIVATE_NETWORK_DENIED',
      });
    }
  });
  it('allows only the explicit synthetic tunnel range without enabling private networking', async () => {
    const blocked = new UrlPolicy({
      allowedHosts: ['tunnel.test'],
      resolver: async () => ['198.18.2.22'],
    });
    await expect(blocked.assertAllowed('https://tunnel.test/', 'navigation')).rejects.toMatchObject({
      code: 'PRIVATE_NETWORK_DENIED',
    });

    const allowed = new UrlPolicy({
      allowedHosts: ['tunnel.test'],
      allowSyntheticTunnel: true,
      resolver: async () => ['198.18.2.22'],
    });
    await expect(allowed.assertAllowed('https://tunnel.test/', 'navigation')).resolves.toBeInstanceOf(URL);

    const privateNetwork = new UrlPolicy({
      allowedHosts: ['tunnel.test'],
      allowSyntheticTunnel: true,
      resolver: async () => ['192.168.1.2'],
    });
    await expect(privateNetwork.assertAllowed('https://tunnel.test/', 'navigation')).rejects.toMatchObject({
      code: 'PRIVATE_NETWORK_DENIED',
    });
  });

  it('supports explicit private-network test mode but never metadata', async () => {
    const policy = new UrlPolicy({ allowedHosts: ['127.0.0.1', 'example.test'], allowHttp: true, allowPrivateNetwork: true, resolver: async (host) => host === 'example.test' ? ['192.168.1.2'] : [] });
    await expect(policy.assertAllowed('http://127.0.0.1:8080/', 'navigation')).resolves.toBeInstanceOf(URL);
    await expect(policy.assertAllowed('http://example.test/', 'navigation')).resolves.toBeInstanceOf(URL);

    for (const metadataAddress of ['169.254.169.254', '169.254.170.2', '169.254.170.23', '100.100.100.200', '168.63.129.16']) {
      const metadata = new UrlPolicy({ allowedHosts: [metadataAddress], allowHttp: true, allowPrivateNetwork: true });
      await expect(metadata.assertAllowed(`http://${metadataAddress}/`, 'navigation')).rejects.toMatchObject({ code: 'PRIVATE_NETWORK_DENIED' });
    }

    const metadataName = new UrlPolicy({
      allowedHosts: ['metadata.google.internal'],
      allowHttp: true,
      allowPrivateNetwork: true,
      resolver: async () => ['93.184.216.34'],
    });
    await expect(metadataName.assertAllowed('http://metadata.google.internal/', 'navigation')).rejects.toMatchObject({ code: 'PRIVATE_NETWORK_DENIED' });
  });

  it('fails closed on DNS errors, empty answers, malformed answers, and rebinding', async () => {
    const errorPolicy = new UrlPolicy({ allowedHosts: ['example.test'], resolver: async () => { throw new Error('resolver failure'); } });
    await expect(errorPolicy.assertAllowed('https://example.test/', 'navigation')).rejects.toMatchObject({ code: 'NETWORK_BLOCKED' });

    const emptyPolicy = new UrlPolicy({ allowedHosts: ['example.test'], resolver: async () => [] });
    await expect(emptyPolicy.assertAllowed('https://example.test/', 'navigation')).rejects.toMatchObject({ code: 'NETWORK_BLOCKED' });

    const malformedPolicy = new UrlPolicy({ allowedHosts: ['example.test'], resolver: async () => ['not-an-ip'] });
    await expect(malformedPolicy.assertAllowed('https://example.test/', 'navigation')).rejects.toMatchObject({ code: 'NETWORK_BLOCKED' });

    const rebindingPolicy = new UrlPolicy({ allowedHosts: ['example.test'], resolver: async () => ['93.184.216.34', '127.0.0.1'] });
    await expect(rebindingPolicy.assertAllowed('https://example.test/', 'navigation')).rejects.toMatchObject({ code: 'PRIVATE_NETWORK_DENIED' });
  });

  it('classifies IPv4, IPv6, and mapped IPv6 addresses', () => {
    expect(classifyAddress('93.184.216.34').blocked).toBe(false);
    expect(classifyAddress('127.0.0.1').reason).toBe('loopback');
    expect(classifyAddress('::ffff:192.168.1.1').reason).toBe('private');
    expect(classifyAddress('fc00::1').reason).toBe('private');
    expect(classifyAddress('ff02::1').reason).toBe('multicast');
  });

  it('never puts a query string into policy errors', async () => {
    const policy = new UrlPolicy({ allowedHosts: ['example.test'], resolver: publicResolver });
    const error = await policy.assertAllowed('https://not-approved.test/path?password=do-not-log', 'navigation').catch((value: unknown) => value);
    expect(error).toBeInstanceOf(BrowserToolError);
    expect(JSON.stringify(error)).not.toContain('do-not-log');
    expect(JSON.stringify(error)).not.toContain('password=');
  });
});
