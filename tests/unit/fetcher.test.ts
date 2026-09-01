import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { PassThrough } from 'node:stream';
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage, RequestOptions } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchPage } from '../../src/fetcher/http-client.js';
import type { FetchUrlPolicy } from '../../src/fetcher/types.js';
import { UrlPolicy } from '../../src/policy/url-policy.js';

interface MockResponse {
  statusCode: number;
  statusMessage?: string;
  headers?: IncomingHttpHeaders;
  body?: string;
}

interface MockClientRequest extends EventEmitter {
  end(): void;
  destroy(error?: Error): MockClientRequest;
}

function mockHttpResponses(responses: readonly MockResponse[]): {
  requestSpy: ReturnType<typeof vi.spyOn>;
  httpsSpy: ReturnType<typeof vi.spyOn>;
  options: Array<RequestOptions & { servername?: string }>;
  lookupResults: Array<{ address: string; family?: number }>;
} {
  const pending = [...responses];
  const options: Array<RequestOptions & { servername?: string }> = [];
  const lookupResults: Array<{ address: string; family?: number }> = [];
  const implementation = ((requestOptions: RequestOptions, callback: (response: IncomingMessage) => void) => {
    const captured = requestOptions as RequestOptions & { servername?: string };
    options.push(captured);
    const request = new EventEmitter() as MockClientRequest;
    request.end = (): void => {
      const next = pending.shift();
      if (!next) {
        request.emit('error', new Error('No mocked HTTP response remains.'));
        return;
      }
      const lookup = captured.lookup;
      const deliver = (): void => {
        const response = new PassThrough();
        const incoming = response as unknown as IncomingMessage & { statusCode?: number; statusMessage?: string; headers: IncomingHttpHeaders };
        incoming.statusCode = next.statusCode;
        incoming.statusMessage = next.statusMessage ?? 'OK';
        incoming.headers = next.headers ?? {};
        callback(incoming);
        queueMicrotask(() => response.end(next.body ?? ''));
      };
      if (!lookup) {
        deliver();
        return;
      }
      lookup(captured.hostname ?? '', { all: false }, (error, address, family) => {
        if (error || typeof address !== 'string') {
          request.emit('error', error ?? new Error('Mock lookup failed.'));
          return;
        }
        lookupResults.push({ address, ...(family !== undefined ? { family } : {}) });
        deliver();
      });
    };
    request.destroy = (error?: Error): MockClientRequest => {
      if (error) request.emit('error', error);
      return request;
    };
    return request as unknown as ClientRequest;
  }) as typeof http.request;
  const requestSpy = vi.spyOn(http, 'request').mockImplementation(implementation);
  const httpsSpy = vi.spyOn(https, 'request').mockImplementation(implementation as typeof https.request);
  return { requestSpy, httpsSpy, options, lookupResults };
}

function pinnedPolicy(addresses: readonly string[] = ['93.184.216.34']): FetchUrlPolicy {
  return {
    assertAllowed: vi.fn(),
    resolveAllowed: vi.fn(async (rawUrl: string) => ({
      url: new URL(rawUrl),
      addresses,
    })),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('受策略约束的轻量级 HTTP 抓取器', () => {
  it('应当经过服务端策略、固定地址并保留原始 Host', async () => {
    const { requestSpy, options, lookupResults } = mockHttpResponses([{
      statusCode: 200,
      statusMessage: 'OK',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ message: 'success' }),
    }]);
    const urlPolicy = pinnedPolicy();

    const result = await fetchPage({
      url: 'http://example.com/api/data',
      urlPolicy,
    });

    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(options[0]?.headers).toMatchObject({
      Accept: expect.stringContaining('text/html'),
      host: 'example.com',
    });
    expect(lookupResults).toEqual([{ address: '93.184.216.34', family: 4 }]);
    expect(urlPolicy.resolveAllowed).toHaveBeenCalledWith('http://example.com/api/data', 'navigation');
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body).toContain('success');
  });

  it('HTTPS 连接保留原始主机名用于 Host 和 TLS SNI', async () => {
    const { httpsSpy, options, lookupResults } = mockHttpResponses([{
      statusCode: 200,
      headers: { 'content-type': 'text/plain' },
      body: 'secure',
    }]);

    const result = await fetchPage({
      url: 'https://example.com/secure',
      urlPolicy: pinnedPolicy(),
    });

    expect(httpsSpy).toHaveBeenCalledTimes(1);
    expect(options[0]).toMatchObject({
      hostname: 'example.com',
      servername: 'example.com',
      headers: { host: 'example.com' },
    });
    expect(lookupResults).toEqual([{ address: '93.184.216.34', family: 4 }]);
    expect(result.body).toBe('secure');
  });

  it('只暴露安全响应头并过滤 Cookie 和认证凭据', async () => {
    mockHttpResponses([{
      statusCode: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-length': '15',
        etag: '"page-v1"',
        'last-modified': 'Sat, 30 Aug 2026 00:00:00 GMT',
        'cache-control': 'no-store',
        location: 'http://example.com/account',
        'set-cookie': ['session=secret; HttpOnly; Secure'],
        authorization: 'Bearer secret-token',
        'www-authenticate': 'Basic realm="private"',
        server: 'internal-server',
      },
      body: '<html>ok</html>',
    }]);

    const result = await fetchPage({
      url: 'http://example.com/account',
      urlPolicy: pinnedPolicy(),
    });

    expect(result.headers).toEqual({
      'cache-control': 'no-store',
      'content-length': '15',
      'content-type': 'text/html; charset=utf-8',
      etag: '"page-v1"',
      'last-modified': 'Sat, 30 Aug 2026 00:00:00 GMT',
      location: 'http://example.com/account',
    });
    expect(result.headers).not.toHaveProperty('set-cookie');
    expect(result.headers).not.toHaveProperty('cookie');
    expect(result.headers).not.toHaveProperty('authorization');
    expect(result.headers).not.toHaveProperty('proxy-authenticate');
    expect(result.headers).not.toHaveProperty('www-authenticate');
    expect(result.headers).not.toHaveProperty('server');
  });

  it('拒绝没有 DNS 地址固定能力的 URL 策略', async () => {
    await expect(fetchPage({
      url: 'http://example.com/api/data',
      urlPolicy: { assertAllowed: vi.fn() },
    })).rejects.toThrow('DNS address pinning support');
  });

  it('拒绝写请求', async () => {
    await expect(fetchPage({
      url: 'http://example.com/api/data',
      method: 'POST',
      urlPolicy: pinnedPolicy(),
    })).rejects.toThrow('only supports GET and HEAD');
  });

  it('应当在每一跳重定向和最终响应前重新检查 URL 策略', async () => {
    const { requestSpy, options } = mockHttpResponses([
      {
        statusCode: 302,
        statusMessage: 'Found',
        headers: { location: 'http://example.com/next' },
      },
      {
        statusCode: 200,
        statusMessage: 'OK',
        headers: { 'content-type': 'text/plain' },
        body: 'ok',
      },
    ]);
    const urlPolicy = pinnedPolicy();

    const result = await fetchPage({
      url: 'http://example.com/start',
      urlPolicy,
    });

    expect(requestSpy).toHaveBeenCalledTimes(2);
    expect(urlPolicy.resolveAllowed).toHaveBeenCalledWith('http://example.com/start', 'navigation');
    expect(urlPolicy.resolveAllowed).toHaveBeenCalledWith('http://example.com/next', 'navigation');
    expect(options[0]?.headers).toMatchObject({ host: 'example.com' });
    expect(options[1]?.headers).toMatchObject({ host: 'example.com' });
    expect(result.redirectCount).toBe(1);
    expect(result.body).toBe('ok');
  });

  it('应当拒绝超过上限的响应体', async () => {
    mockHttpResponses([{
      statusCode: 200,
      headers: { 'content-length': '2000' },
      body: 'x'.repeat(2_000),
    }]);

    await expect(fetchPage({
      url: 'http://example.com/large',
      maxResponseBytes: 1_024,
      urlPolicy: pinnedPolicy(),
    })).rejects.toThrow('response exceeds the server response limit');
  });

  it.each([
    ['IPv4', '93.184.216.34', 4],
    ['IPv6', '2001:4860:4860::8888', 6],
  ] as const)('DNS 首次返回公共 %s、连接阶段潜在变为私网时仍固定首个批准地址', async (_label, publicAddress, family) => {
    let resolverCalls = 0;
    const resolver = (): readonly string[] => {
      resolverCalls += 1;
      // A second resolution would return a private address. The pinned
      // transport must never invoke this resolver a second time.
      return resolverCalls === 1 ? [publicAddress] : ['127.0.0.1'];
    };
    const policy = new UrlPolicy({
      allowedHosts: ['example.com'],
      allowHttp: true,
      resolver,
    });
    const { lookupResults } = mockHttpResponses([{
      statusCode: 200,
      headers: { 'content-type': 'text/plain' },
      body: 'pinned',
    }]);

    const result = await fetchPage({
      url: 'http://example.com/rebinding',
      urlPolicy: policy,
    });

    expect(result.body).toBe('pinned');
    expect(resolverCalls).toBe(1);
    expect(lookupResults).toEqual([{ address: publicAddress, family }]);
  });
});
