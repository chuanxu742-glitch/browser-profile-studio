import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SessionManager } from '../../src/browser/session-manager.js';
import { UrlPolicy } from '../../src/policy/url-policy.js';
import { AuditLogger } from '../../src/audit.js';

describe('Real Browser Stealth and Anti-Detect Benchmark Test', () => {
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

  it('runs fingerprint benchmark in real browser and verifies stealth masking and human simulation', async () => {
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

    // Start with fingerprint spoofing and human-paced input scheduler
    const session = await manager.start({
      headless: true,
      inputProfile: 'paced', // Human-paced input mode
      fingerprint: true,
      fingerprintSeed: 998877,
      countryCode: 'US',
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
      expect(completedSnapshot.text).toContain('Action executed by human simulation: StealthOperator_007');

      // Verify the in-page benchmark results from snapshot text
      expect(completedSnapshot.text).toContain('"webdriverRemoved": true');
      expect(completedSnapshot.text).toContain('"hasChromeRuntime": false');
      expect(completedSnapshot.text).toContain('"toStringProtected": true');
      expect(completedSnapshot.text).toContain('hardwareConcurrency');
      expect(completedSnapshot.text).toContain('deviceMemory');
    } finally {
      await manager.stop(session.sessionId, 'test_finish');
      await manager.shutdown('test_cleanup');
    }
  }, 45_000);
});
