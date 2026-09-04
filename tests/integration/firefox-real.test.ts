import { createServer, type Server } from 'node:http';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditLogger } from '../../src/audit.js';
import { SessionManager } from '../../src/browser/session-manager.js';
import { UrlPolicy } from '../../src/policy/url-policy.js';

const shouldRunRealFirefox =
  process.env.RUN_FIREFOX_SMOKE === '1' || process.env.npm_lifecycle_event === 'test:firefox';
const realFirefox = shouldRunRealFirefox ? describe : describe.skip;

realFirefox('real Playwright Firefox smoke test', () => {
  let server: Server;
  let origin: string;
  let workRoot: string;

  beforeAll(async () => {
    const fixtureRoot = join(process.cwd(), 'tests', 'fixtures', 'pages');
    server = createServer(async (request, response) => {
      const file = request.url?.startsWith('/challenge') ? 'challenge.html' : 'normal.html';
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(await readFile(join(fixtureRoot, file)));
    });
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise);
      server.listen(0, '127.0.0.1', resolvePromise);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture server did not bind a TCP port.');
    origin = `http://127.0.0.1:${address.port}`;
    workRoot = await mkdtemp(join(tmpdir(), 'compliant-firefox-smoke-'));
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    if (workRoot) await rm(workRoot, { recursive: true, force: true });
  });

  it('operates an approved page and freezes on a local challenge fixture', async () => {
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

    const session = await manager.start({ headless: true, inputProfile: 'direct' });
    const profileDirectory = session.profileDirectory;
    try {
      const diagnostics = await manager.environmentDiagnostics(session.sessionId);
      expect(diagnostics.engine).toBe('firefox');
      expect(diagnostics.observed?.userAgent).toBeTruthy();
      expect(diagnostics.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'webdriver-signal', status: expect.any(String) }),
      ]));
      await manager.open(session.sessionId, `${origin}/normal`);
      const first = await manager.snapshot(session.sessionId, { includeText: true });
      const email = first.targets.find((target) => target.testId === 'email-input');
      const choice = first.targets.find((target) => target.tag === 'select');
      const save = first.targets.find((target) => target.testId === 'save-button');
      expect(email?.ref).toBeTruthy();
      expect(choice?.ref).toBeTruthy();
      expect(save?.ref).toBeTruthy();

      await manager.type(session.sessionId, email!.ref, 'qa@example.test', { clearFirst: true });
      await manager.select(session.sessionId, choice!.ref, 'two');
      await manager.click(session.sessionId, save!.ref);
      const completed = await manager.snapshot(session.sessionId, { includeText: true });
      expect(completed.text).toContain('Saved');

      await expect(manager.open(session.sessionId, `${origin}/challenge`)).rejects.toMatchObject({
        code: 'SESSION_PAUSED_CHALLENGE',
      });
      expect(manager.status(session.sessionId).state).toBe('PAUSED_CHALLENGE');
      await expect(manager.click(session.sessionId, save!.ref)).rejects.toMatchObject({
        code: 'SESSION_PAUSED_CHALLENGE',
      });
      const screenshot = await manager.screenshot(session.sessionId);
      expect(screenshot.image.mimeType).toBe('image/png');
      expect(Buffer.from(screenshot.image.data, 'base64').byteLength).toBeGreaterThan(0);
      const artifactPath = join(workRoot, 'artifacts', session.sessionId, `${screenshot.artifactRef}.png`);
      await expect(access(artifactPath)).resolves.toBeUndefined();
    } finally {
      await manager.stop(session.sessionId, 'smoke-test');
      await manager.shutdown('smoke-test-cleanup');
    }
    await expect(access(profileDirectory)).rejects.toBeDefined();
    await expect(access(join(workRoot, 'artifacts', session.sessionId))).rejects.toBeDefined();
    const auditLog = await readFile(join(workRoot, 'audit.jsonl'), 'utf8');
    expect(auditLog).toContain('browser_environment_diagnostics');
  }, 60_000);
});
