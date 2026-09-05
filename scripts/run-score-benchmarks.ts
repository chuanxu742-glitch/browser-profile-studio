import { SessionManager } from '../src/browser/session-manager.js';
import { UrlPolicy } from '../src/policy/url-policy.js';
import { ChallengePolicy } from '../src/challenge/policy.js';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

async function runScoreBenchmarks() {
  const startedAt = new Date().toISOString();
  const artifactsDir = join(process.cwd(), 'artifacts', 'benchmarks', startedAt.replaceAll(':', '-'));
  await mkdir(artifactsDir, { recursive: true });
  const manager = new SessionManager({
    maxSessions: 1,
    urlPolicy: new UrlPolicy({
      allowedHosts: ['browserscan.net', '*.browserscan.net', 'whoer.net', '*.whoer.net'],
      resourceHosts: ['browserscan.net', '*.browserscan.net', 'whoer.net', '*.whoer.net', '*.cloudflare.com', '*.gstatic.com', '*.googleapis.com', '*.google.com'],
    }),
    challengePolicy: new ChallengePolicy(),
  });
  const results: Array<Record<string, unknown>> = [];
  let runError: string | undefined;
  try {
    const session = await manager.start({
      engine: 'chromium', headless: process.env.BENCHMARK_HEADLESS !== 'false',
      fingerprint: true, fingerprintSeed: 654321,
      ...(process.env.BENCHMARK_COUNTRY ? { countryCode: process.env.BENCHMARK_COUNTRY } : {}),
      ...(process.env.BENCHMARK_TIMEZONE ? { timezone: process.env.BENCHMARK_TIMEZONE } : {}),
    });
    for (const [name, url] of [['browserscan', 'https://www.browserscan.net/'], ['whoer', 'https://whoer.net/']]) {
      const result: Record<string, unknown> = { name, url, loadStatus: 'ERROR', detectionResult: 'unverified' };
      results.push(result);
      try {
        await manager.open(session.sessionId, url!, { timeoutMs: 45_000, waitUntil: 'domcontentloaded' });
        // Retain each raw artifact as soon as it is captured, even when a later
        // screenshot or diagnostic fails. Reachability never becomes a score.
        result.loadStatus = 'LOADED';
        const snapshot = await manager.snapshot(session.sessionId, { includeText: true, maxChars: 100_000 });
        const textPath = join(artifactsDir, `${name}.txt`);
        await writeFile(textPath, snapshot.text ?? '', 'utf8');
        result.textPath = textPath;
        result.textTruncated = snapshot.textTruncated ?? false;
        const screenshot = await manager.screenshot(session.sessionId, { fullPage: false });
        const screenshotPath = join(artifactsDir, `${name}.png`);
        await writeFile(screenshotPath, Buffer.from(screenshot.image.data, 'base64'));
        result.screenshotPath = screenshotPath;
        result.diagnostics = await manager.environmentDiagnostics(session.sessionId);
      } catch (error: unknown) {
        result.error = error instanceof Error ? error.message : String(error);
        process.exitCode = 1;
      } finally {
        result.capturedAt = new Date().toISOString();
      }
    }
  } catch (error: unknown) {
    runError = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    try {
      await manager.shutdown();
    } catch (error: unknown) {
      runError = [runError, `shutdown: ${error instanceof Error ? error.message : String(error)}`].filter(Boolean).join('; ');
      process.exitCode = 1;
    }
    const reportPath = join(artifactsDir, 'report.json');
    await writeFile(reportPath, JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), detectionResult: 'unverified', ...(runError ? { error: runError } : {}), results }, null, 2));
    console.log(`Evidence saved: ${reportPath}. Page loads are not detector passes; no scores were inferred.`);
    console.table(results.map(({ name, loadStatus, detectionResult }) => ({ name, loadStatus, detectionResult })));
  }
}

runScoreBenchmarks().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
