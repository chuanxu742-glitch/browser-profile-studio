import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { RawCdpConnection } from '../../src/browser/raw-cdp-connection.js';

describe('RawCdpConnection', () => {
  const roots: string[] = [];
  const servers: WebSocketServer[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it('connects only through the browser profile endpoint and routes flat-session commands/events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'raw-cdp-'));
    roots.push(root);
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/devtools/browser/test' });
    servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Unexpected pipe endpoint');
    await writeFile(join(root, 'DevToolsActivePort'), `${address.port}\n/devtools/browser/test\n`);
    server.on('connection', (socket) => socket.on('message', (raw) => {
      const command = JSON.parse(raw.toString()) as { id: number; method: string; sessionId?: string };
      socket.send(JSON.stringify({ id: command.id, result: { echoed: command.method, sessionId: command.sessionId } }));
      socket.send(JSON.stringify({ method: 'Target.attachedToTarget', params: { sessionId: 'child' } }));
    }));

    const connection = await RawCdpConnection.connect(root);
    const events: string[] = [];
    connection.onEvent((event) => events.push(event.method));
    await expect(connection.send('Runtime.evaluate', {}, 'child')).resolves.toMatchObject({
      echoed: 'Runtime.evaluate',
      sessionId: 'child',
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(events).toContain('Target.attachedToTarget');
    connection.close();
  });

  it('rejects an invalid or missing DevTools endpoint within the caller deadline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'raw-cdp-invalid-'));
    roots.push(root);
    await writeFile(join(root, 'DevToolsActivePort'), '0\n/not-a-browser-target\n');
    await expect(RawCdpConnection.connect(root, 75)).rejects.toThrow('RAW_CDP_ENDPOINT_UNAVAILABLE');
  });
});
