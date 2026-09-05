import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SessionManager } from '../../src/browser/session-manager.js';
import { UrlPolicy } from '../../src/policy/url-policy.js';
import { AuditLogger } from '../../src/audit.js';

describe('Native Firefox paced form interaction', () => {
  let server: Server;
  let origin: string;
  let workRoot: string;

  beforeAll(async () => {
    const fixturePath = join(process.cwd(), 'tests', 'fixtures', 'pages', 'fingerprint-check.html');
    const html = await readFile(fixturePath, 'utf-8');

    server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Server address not available');
    origin = `http://127.0.0.1:${addr.port}`;
    workRoot = await mkdtemp(join(tmpdir(), 'stealth-benchmark-'));
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (workRoot) await rm(workRoot, { recursive: true, force: true });
  });

  it('submits a form through snapshot references in a managed profile', async () => {
    const manager = new SessionManager({
      maxSessions: 1,
      profileRoot: join(workRoot, 'profiles'),
      artifactsRoot: join(workRoot, 'artifacts'),
      urlPolicy: new UrlPolicy({
        allowedHosts: ['127.0.0.1'],
        resourceHosts: ['127.0.0.1'],
        allowHttp: true,
        allowPrivateNetwork: true,
      }),
      audit: new AuditLogger(join(workRoot, 'audit.jsonl')),
    });

    // Exercise managed Firefox with paced input.
    const session = await manager.start({
      headless: true,
      inputProfile: 'paced', // Human-paced input mode
      fingerprint: true,
      fingerprintSeed: 998877,
    });

    try {
      await manager.open(session.sessionId, `${origin}/benchmark`);
      const snapshot = await manager.snapshot(session.sessionId, { includeText: true });

      const input = snapshot.targets.find((t) => t.testId === 'username-input');
      const submit = snapshot.targets.find((t) => t.testId === 'submit-button');

      expect(input?.ref).toBeDefined();
      expect(submit?.ref).toBeDefined();

      // Human-paced typing and clicking
      await manager.type(session.sessionId, input!.ref, 'StealthOperator_007', { clearFirst: true });
      await manager.click(session.sessionId, submit!.ref);

      const completedSnapshot = await manager.snapshot(session.sessionId, { includeText: true });
      // Only submitted output contains this value; input values are not part of body text.
      expect(completedSnapshot.text).toContain('StealthOperator_007');
    } finally {
      await manager.stop(session.sessionId, 'test_finish');
      await manager.shutdown('test_cleanup');
    }
  }, 45_000);
});
