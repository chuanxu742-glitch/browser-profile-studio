import { describe, it, expect } from 'vitest';
import { normalizeProxyConfig } from '../../src/proxy/validator.js';
import { checkProxy } from '../../src/proxy/checker.js';
import { createServer } from 'node:http';
import { createServer as createTcpServer, type Socket } from 'node:net';

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

    it('preserves explicit default ports and separates IPv6 socket hosts from URL authorities', () => {
      expect(normalizeProxyConfig('http://[::1]:80')).toMatchObject({ server: 'http://[::1]:80', host: '::1', port: 80 });
      expect(normalizeProxyConfig('https://proxy.test:443')).toMatchObject({ server: 'https://proxy.test:443', port: 443 });
      expect(() => normalizeProxyConfig('http://proxy.test:0')).toThrow();
    });

    it('should throw error for unsupported protocols', () => {
      expect(() => normalizeProxyConfig('ftp://1.2.3.4:21')).toThrow(/Unsupported proxy protocol/);
    });

    it('should throw error for empty proxy', () => {
      expect(() => normalizeProxyConfig('')).toThrow(/empty/);
    });
  });

  describe('checkProxy', () => {
    it.each(['127.0.0.1', '::1'])('distinguishes socket reachability, tunnel handshake and verified egress through %s', async host => {
      let ip = 'not-an-ip';
      let country: string | undefined = 'us';
      let connectStatus = 200;
      let connectAuthority: string | undefined;
      const sockets = new Set<Socket>();
      const server = createServer();
      server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
      server.on('connect', (request, socket) => {
        connectAuthority = request.url;
        if (connectStatus !== 200) { socket.end(`HTTP/1.1 ${connectStatus} Proxy Authentication Required\r\n\r\n`); return; }
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        socket.once('data', () => {
          const body = JSON.stringify({ ip, country });
          socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
        });
      });
      try {
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
        const proxy = `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`;
        expect(await checkProxy(proxy, { ipCheckServiceUrl: false })).toMatchObject({ success: true, verified: false, checkLevel: 'connectivity' });
        const unverified = await checkProxy(proxy, { ipCheckServiceUrl: 'http://fixture.invalid/ip' });
        expect(unverified).toMatchObject({ success: true, verified: false, checkLevel: 'handshake' });
        expect(unverified.outboundIp).toBeUndefined();
        ip = '203.0.113.9';
        expect(await checkProxy(proxy, { ipCheckServiceUrl: 'http://fixture.invalid/ip' })).toMatchObject({ success: true, verified: true, checkLevel: 'egress', outboundIp: ip, country: 'US' });
        ip = '2001:db8::9';
        country = undefined;
        const ipv6 = await checkProxy(proxy, { ipCheckServiceUrl: 'http://[2001:db8::1]/ip' });
        expect(connectAuthority).toBe('[2001:db8::1]:80');
        expect(ipv6).toMatchObject({ success: true, verified: true, checkLevel: 'egress', outboundIp: ip });
        expect(ipv6.country).toBeUndefined();
        connectStatus = 407;
        const rejected = await checkProxy(proxy, { ipCheckServiceUrl: 'http://fixture.invalid/ip' });
        expect(rejected).toMatchObject({ success: true, verified: false, checkLevel: 'connectivity' });
        expect(rejected.probeError).toContain('407');
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    });

    it.each([
      { target: 'fixture.invalid', address: Buffer.concat([Buffer.from([3, 15]), Buffer.from('fixture.invalid')]) },
      { target: '192.0.2.1', address: Buffer.from([1, 192, 0, 2, 1]) },
      { target: '[2001:db8::1]', address: Buffer.from([4, 0x20, 1, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]) },
    ])('verifies SOCKS5 $target only after the entire fragmented tunnel reply', async ({ target, address }) => {
      const sockets = new Set<Socket>();
      let requestedAddress: Buffer | undefined;
      let earlyRequest = false;
      const server = createTcpServer(socket => {
        sockets.add(socket); socket.on('close', () => sockets.delete(socket));
        let stage = 0;
        let pending = Buffer.alloc(0);
        let replyComplete = false;
        socket.on('data', chunk => {
          pending = Buffer.concat([pending, chunk]);
          if (stage === 0 && pending.length >= 3) {
            pending = pending.subarray(3); stage = 1;
            socket.write(Buffer.from([5, 0]));
          }
          if (stage === 1 && pending.length >= 3 + address.length + 2) {
            requestedAddress = pending.subarray(3, 3 + address.length);
            pending = pending.subarray(3 + address.length + 2); stage = 2;
            // A SOCKS5 IPv6 bound address is 22 bytes, not merely the first five.
            socket.write(Buffer.from([5, 0, 0, 4, 0]));
            // Real TCP fragmentation needs separate delivery turns; fake time
            // cannot drive the OS socket receiving the first fragment.
            const timer = setTimeout(() => { replyComplete = true; socket.write(Buffer.alloc(17)); }, 30);
            socket.once('close', () => clearTimeout(timer));
          }
          if (stage === 2 && pending.includes('\r\n\r\n')) {
            earlyRequest = !replyComplete; stage = 3;
            const body = '{"ip":"2001:db8::9"}';
            socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
          }
        });
      });
      try {
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const bound = server.address();
        if (!bound || typeof bound === 'string') throw new Error('Fixture did not bind');
        const result = await checkProxy(`socks5://127.0.0.1:${bound.port}`, { ipCheckServiceUrl: `http://${target}/ip`, timeoutMs: 1000 });
        expect(result).toMatchObject({ verified: true, checkLevel: 'egress', outboundIp: '2001:db8::9' });
        expect(requestedAddress).toEqual(address);
        expect(earlyRequest).toBe(false);
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    });

    it.each([1, 2, 255])('rejects unoffered SOCKS5 authentication method %s without sending a destination', async method => {
      let disclosedDestination = false;
      const server = createTcpServer(socket => {
        socket.once('data', () => {
          socket.on('data', () => { disclosedDestination = true; });
          socket.end(Buffer.from([5, method]));
        });
      });
      try {
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const bound = server.address();
        if (!bound || typeof bound === 'string') throw new Error('Fixture did not bind');
        const result = await checkProxy(`socks5://127.0.0.1:${bound.port}`, { ipCheckServiceUrl: 'http://fixture.invalid/ip', timeoutMs: 1000 });
        expect(result).toMatchObject({ success: true, verified: false, checkLevel: 'connectivity' });
        expect(result.probeError).toContain('authentication negotiation failed');
        expect(disclosedDestination).toBe(false);
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    });

    it('reports SOCKS4 IPv6 destinations as unsupported without sending a tunnel request', async () => {
      let tunnelRequested = false;
      const server = createTcpServer(socket => { socket.on('data', () => { tunnelRequested = true; }); });
      try {
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const bound = server.address();
        if (!bound || typeof bound === 'string') throw new Error('Fixture did not bind');
        const result = await checkProxy(`socks4://127.0.0.1:${bound.port}`, { ipCheckServiceUrl: 'http://[2001:db8::1]/ip', timeoutMs: 1000 });
        expect(result).toMatchObject({ success: true, verified: false, checkLevel: 'connectivity' });
        expect(result.probeError).toContain('SOCKS4 does not support IPv6 destinations');
        expect(tunnelRequested).toBe(false);
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    });

    it('starts HTTPS proxy transport with TLS rather than disclosing CONNECT credentials in plaintext', async () => {
      let firstPacket = Buffer.alloc(0);
      const server = createTcpServer(socket => {
        socket.once('data', chunk => { firstPacket = Buffer.from(chunk); socket.destroy(); });
      });
      try {
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const bound = server.address();
        if (!bound || typeof bound === 'string') throw new Error('Fixture did not bind');
        const result = await checkProxy(`https://alice:secret@127.0.0.1:${bound.port}`, { ipCheckServiceUrl: 'http://fixture.invalid/ip', timeoutMs: 1000 });
        expect(firstPacket[0]).toBe(22);
        expect(firstPacket.toString('latin1')).not.toContain('Proxy-Authorization:');
        expect(result).toMatchObject({ success: true, verified: false, checkLevel: 'connectivity' });
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    });
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
