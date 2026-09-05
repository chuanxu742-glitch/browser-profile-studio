import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { SessionManager, SessionStartOptions } from '../src/browser/session-manager.js';
import type { SemanticSnapshot } from '../src/browser/semantic-snapshot.js';

export interface BenchmarkSite {
  readonly name: string;
  readonly url: string;
  readonly category?: string;
  readonly focus?: string;
}

type Outcome = 'passed' | 'failed' | 'inconclusive' | 'unavailable';
type Row = Record<string, string | null>;
interface Assessment {
  status: Outcome;
  reason: string;
  ready: boolean;
  evidence?: unknown;
}
interface Observation {
  at: string;
  snapshot: SemanticSnapshot;
  resultRows: Row[];
  assessment: Assessment;
}
interface BenchmarkResult extends Assessment {
  site: BenchmarkSite;
  startedAt: string;
  finishedAt?: string;
  timedOut: boolean;
  observations: Observation[];
  errors: unknown[];
  navigation?: unknown;
  sessionStatus?: unknown;
  diagnostics?: unknown;
  runtimeAssessment?: { status: 'passed' | 'failed' | 'unverified'; reason: string };
  screenshotPath?: string;
}

function pending(reason: string, evidence?: unknown): Assessment {
  return { status: 'inconclusive', reason, ready: false, evidence };
}

// Only actual result cells are interpreted; page prose/advertising is never a verdict.
function assessSannysoft(rows: Row[], engine: 'firefox' | 'chromium'): Assessment {
  const required = ['user-agent-result', 'webdriver-result', 'advanced-webdriver-result', 'languages-result', 'webgl-vendor', 'webgl-renderer'];
  if (engine === 'chromium') required.push('chrome-result', 'permissions-result', 'plugins-length-result', 'plugins-type-result');
  const checks = rows.filter((row) => row.name && row.value?.trim()).map((row) => {
    const chromeOnly = /^(?:HEADCHR_|CHR_)/.test(row.name!) || ['chrome-result', 'permissions-result', 'plugins-length-result', 'plugins-type-result'].includes(row.id ?? '');
    const advisory = row.id === 'broken-image-dimensions';
    const applicable = !(engine === 'firefox' && chromeOnly) && !advisory;
    return { ...row, applicable, excludedReason: applicable ? null : advisory ? 'Legacy broken-image heuristic; not an automation verdict' : 'Chrome-specific API/nonempty-plugin assumption does not apply to Firefox' };
  });
  const evidence = { checks, scope: 'Sannysoft applicable result cells only; not proof of undetectability' };
  if (required.some((id) => !checks.some((row) => row.id === id)) || !checks.some((row) => row.name === 'VIDEO_CODECS') || !checks.some((row) => row.name === 'SELENIUM_DRIVER')) {
    return pending('Sannysoft result tables have not finished rendering', evidence);
  }
  const relevant = checks.filter((row) => row.applicable);
  if (relevant.some((row) => /(?:^|\s)failed(?:\s|$)/.test(row.class ?? ''))) {
    return { status: 'failed', reason: 'Sannysoft reports failed applicable checks', ready: true, evidence };
  }
  if (relevant.some((row) => !/(?:^|\s)passed(?:\s|$)/.test(row.class ?? ''))) {
    return { status: 'inconclusive', reason: 'Sannysoft includes warnings or unclassified applicable checks', ready: true, evidence };
  }
  return { status: 'passed', reason: 'All completed, applicable Sannysoft checks report passed', ready: true, evidence };
}

function assess(site: BenchmarkSite, snapshot: SemanticSnapshot, rows: Row[], engine: 'firefox' | 'chromium'): Assessment {
  const text = snapshot.text ?? '';
  const host = new URL(site.url).hostname;
  if (/^(?:Just a moment|Access denied|Service unavailable|Bad gateway|This site can.t be reached)/im.test(text.trim()) || /verify (?:that )?you are human/i.test(text)) {
    return { status: 'unavailable', reason: 'Challenge or error page prevents observing test results', ready: true };
  }
  if (snapshot.textTruncated) return pending('Snapshot text exceeds the public API limit; complete evidence is unavailable');
  if (!text.trim()) return pending('No readable result text yet');
  if (host === 'bot.sannysoft.com') return assessSannysoft(rows, engine);
  if (host.endsWith('iphey.com')) {
    const score = text.match(/\b(\d+(?:\.\d+)?)\s*MX Score\b/i);
    const verdict = text.match(/Your Digital Identity Looks\s+(Trustworthy|Unreliable)\b/i);
    if (/Temporary value/i.test(text) || !score || Number(score[1]) === 0 || !verdict) {
      return pending('IPhey placeholders, initial zero score, or missing final identity verdict', { scoreText: score?.[0] ?? null });
    }
    return { status: verdict[1]!.toLowerCase() === 'trustworthy' ? 'passed' : 'failed', reason: `IPhey final identity verdict: ${verdict[1]} (not an independently verified IP alignment)`, ready: true, evidence: { verdict: verdict[0], scoreText: score[0], interpretation: 'Site heuristic, not a ban probability' } };
  }
  if (host === 'abrahamjuliot.github.io') {
    if (/\bComputing\b/i.test(text) || !/FP ID:\s*[a-f\d]{8,}/i.test(text)) return pending('CreepJS is still computing or has no completed fingerprint');
    return { status: 'inconclusive', ready: true, reason: 'CreepJS fingerprint rendered; its percentages are heuristics, not ban probabilities or a pass/fail contract', evidence: { heuristicLabels: text.match(/(?:\d+(?:\.\d+)?%\s*(?:like headless|headless|stealth)|(?:like headless|headless|stealth)\s*:?\s*\d+(?:\.\d+)?%)/gi) ?? [] } };
  }
  if (host.endsWith('whoer.net')) {
    const score = text.match(/Your disguise:\s*(\d+(?:\.\d+)?)\s*%/i);
    return score ? { status: 'inconclusive', ready: true, reason: 'Whoer disguise rating rendered; no validated pass threshold or independent IP alignment', evidence: { scoreText: score[0], interpretation: 'Site heuristic only' } } : pending('Whoer has not rendered a numeric Your disguise result');
  }
  if (host.endsWith('browserscan.net')) {
    const score = text.match(/Browser fingerprint authenticity:\s*(\d+(?:\.\d+)?)\s*%/i);
    // BrowserScan's server-rendered shell already says 100% with a 0%-width
    // progress bar. A visible percentage alone cannot establish completion.
    return pending('BrowserScan completion is not established by its initially populated authenticity rating', { displayedRating: score?.[0] ?? null, interpretation: 'Unverified site heuristic; not a pass or ban probability' });
  }
  if (host.endsWith('amiunique.org')) {
    const comparison = text.match(/Only\s+[\d,]+\s+browsers out of the\s+[\d,]+\s+observed browsers have exactly the same fingerprint as yours\s*\(\s*\d+(?:\.\d+)?\s*%\s*\)/i);
    if (!comparison || /\bNaN\b|No data available|Javascript is disabled/i.test(text) || !/Javascript attributes/i.test(text)) {
      return pending('AmIUnique has not rendered a populated browser fingerprint comparison');
    }
    return { status: 'inconclusive', ready: true, reason: 'AmIUnique sample comparison rendered; uniqueness is not an automation verdict', evidence: { comparison: comparison[0] } };
  }
  // Informational fingerprint sites do not define a defensible binary acceptance rule.
  // Keep polling rather than interpreting a homepage, marketing text or an arbitrary % as success.
  return pending('No verified terminal verdict parser for this site; retained evidence requires interpretation');
}

function errorDetails(error: unknown): unknown {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack, ...('code' in error ? { code: error.code } : {}), ...('details' in error ? { details: error.details } : {}), ...(error.cause ? { cause: String(error.cause) } : {}) }
    : { message: String(error) };
}

function sessionOptions(seed: number): SessionStartOptions {
  const engine = process.env.BENCHMARK_ENGINE?.trim();
  if (engine && engine !== 'firefox' && engine !== 'chromium') throw new Error('BENCHMARK_ENGINE must be firefox or chromium');
  const options: SessionStartOptions = { headless: process.env.BENCHMARK_HEADLESS !== 'false', inputProfile: 'paced', fingerprint: true, fingerprintSeed: seed };
  if (engine) options.engine = engine;
  const country = process.env.BENCHMARK_COUNTRY?.trim();
  const timezone = process.env.BENCHMARK_TIMEZONE?.trim();
  const locale = process.env.BENCHMARK_LOCALE?.trim();
  const proxy = process.env.BENCHMARK_PROXY?.trim();
  if (country) options.countryCode = country;
  if (timezone) options.timezone = timezone;
  if (locale) options.locale = locale;
  if (proxy) options.proxy = proxy;
  const latitude = process.env.BENCHMARK_LATITUDE?.trim();
  const longitude = process.env.BENCHMARK_LONGITUDE?.trim();
  if (latitude || longitude) {
    if (!latitude || !longitude || !Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude)) || Math.abs(Number(latitude)) > 90 || Math.abs(Number(longitude)) > 180) {
      throw new Error('BENCHMARK_LATITUDE and BENCHMARK_LONGITUDE must both contain valid coordinates');
    }
    options.geolocation = { latitude: Number(latitude), longitude: Number(longitude), accuracy: 25 };
  }
  return options;
}

export async function runBenchmarkSuite(manager: SessionManager, sites: readonly BenchmarkSite[], suite: string, seed: number): Promise<void> {
  const artifactsDir = join(process.cwd(), 'artifacts', 'benchmarks', `${suite}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const results: BenchmarkResult[] = [];
  const errors: unknown[] = [];
  let sessionId: string | undefined;
  let configuration: unknown = {
    requestedEngine: process.env.BENCHMARK_ENGINE ?? null,
    country: process.env.BENCHMARK_COUNTRY ?? null,
    timezone: process.env.BENCHMARK_TIMEZONE ?? null,
    locale: process.env.BENCHMARK_LOCALE ?? null,
    proxyConfigured: Boolean(process.env.BENCHMARK_PROXY),
    ipAlignment: 'not_verified',
  };
  const startedAt = new Date().toISOString();
  try {
    await mkdir(artifactsDir, { recursive: true });
    const options = sessionOptions(seed);
    configuration = { ...options, proxy: options.proxy ? '[configured via BENCHMARK_PROXY; credentials omitted]' : null, ipAlignment: 'not_verified', countrySource: options.countryCode ? 'explicit BENCHMARK_COUNTRY' : 'SessionManager default (not GeoIP verification)' };
    const timeoutMs = Number(process.env.BENCHMARK_RESULT_TIMEOUT_MS ?? 60_000);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000) throw new Error('BENCHMARK_RESULT_TIMEOUT_MS must be an integer from 1000 to 300000');
    const session = await manager.start(options);
    sessionId = session.sessionId;
    const engine = manager.status(sessionId).engine;
    if (engine !== 'firefox' && engine !== 'chromium') throw new Error('SessionManager did not report the actual browser engine');
    const maxBytes = Math.min(256 * 1024, manager.capabilities().limits.snapshotMaxSnapshotBytes);
    for (const site of sites) {
      const result: BenchmarkResult = { site, ...pending('Result not yet observed'), startedAt: new Date().toISOString(), timedOut: false, observations: [], errors: [] };
      results.push(result);
      try {
        result.navigation = await manager.open(sessionId, site.url, { timeoutMs: 45_000, waitUntil: 'domcontentloaded' });
        const deadline = Date.now() + timeoutMs;
        let previousResult = '';
        let stableObservations = 0;
        while (Date.now() < deadline) {
          const snapshot = await manager.snapshot(sessionId, { includeText: true, maxChars: 50_000, maxBytes, maxNodes: 100 });
          let resultRows: Row[] = [];
          if (new URL(site.url).hostname === 'bot.sannysoft.com') {
            const extracted = await manager.extract(sessionId, {
              containerSelector: 'body > table:first-of-type tr:has(td), #fp2 tr',
              fields: [
                { name: 'name', selector: 'td:first-child' },
                { name: 'id', selector: 'td:nth-child(2)', attribute: 'id' },
                { name: 'value', selector: 'td:nth-child(2)' },
                { name: 'class', selector: 'td:nth-child(2)', attribute: 'class' },
              ], maxItems: 100,
            });
            resultRows = extracted.items;
          }
          const assessment = assess(site, snapshot, resultRows, engine);
          result.observations.push({ at: new Date().toISOString(), snapshot, resultRows, assessment });
          Object.assign(result, assessment);
          const status = manager.status(sessionId);
          result.sessionStatus = status;
          if (status.state === 'PAUSED_CHALLENGE') {
            Object.assign(result, { status: 'unavailable', reason: 'Session paused by challenge policy', ready: true });
            break;
          }
          const signature = JSON.stringify(assessment);
          stableObservations = signature === previousResult ? stableObservations + 1 : 1;
          previousResult = signature;
          if (assessment.ready && stableObservations >= 2) break;
          await delay(Math.min(1000, Math.max(0, deadline - Date.now())));
        }
        if (!result.ready || stableObservations < 2 && result.status !== 'unavailable') {
          result.timedOut = true;
          result.ready = false;
          result.status = 'inconclusive';
          result.reason = `Result deadline exceeded: ${result.reason}`;
        }
      } catch (error) {
        result.errors.push({ phase: 'navigation_or_observation', error: errorDetails(error) });
        result.status = 'unavailable';
        result.ready = false;
        result.reason = 'Navigation or result observation failed';
        result.timedOut = /timeout|timed out/i.test(error instanceof Error ? `${error.name} ${error.message}` : String(error));
        try {
          const snapshot = await manager.snapshot(sessionId, { includeText: true, maxChars: 50_000, maxBytes, maxNodes: 100 });
          result.observations.push({ at: new Date().toISOString(), snapshot, resultRows: [], assessment: pending('Diagnostic capture after failure; not a verdict') });
        } catch (captureError) { result.errors.push({ phase: 'failure_snapshot', error: errorDetails(captureError) }); }
      }
      try {
        result.sessionStatus = manager.status(sessionId);
        const diagnostics = await manager.environmentDiagnostics(sessionId);
        result.diagnostics = diagnostics;
        result.runtimeAssessment = {
          status: diagnostics.consistency === 'inconsistent' ? 'failed' : diagnostics.consistency === 'consistent' ? 'passed' : 'unverified',
          reason: diagnostics.consistency === 'inconsistent'
            ? 'Runtime diagnostics found an explicit configuration or behavioral inconsistency; the independent site verdict is unchanged'
            : diagnostics.consistency === 'consistent' ? 'Runtime diagnostics are consistent' : 'Runtime diagnostics contain unverified warnings, not a demonstrated failure',
        };
      } catch (error) {
        result.errors.push({ phase: 'environment_diagnostics', error: errorDetails(error) });
        if (result.status === 'passed') Object.assign(result, { status: 'inconclusive', reason: 'Site passed, but engine configuration evidence could not be collected' });
      }
      try {
        const screenshot = await manager.screenshot(sessionId, { fullPage: true });
        const filename = `${site.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${result.status}.png`;
        const screenshotPath = join(artifactsDir, filename);
        await writeFile(screenshotPath, Buffer.from(screenshot.image.data, 'base64'));
        result.screenshotPath = screenshotPath;
      } catch (error) {
        result.errors.push({ phase: 'screenshot', error: errorDetails(error) });
        if (result.status === 'passed') Object.assign(result, { status: 'inconclusive', reason: 'Site passed, but screenshot evidence could not be saved' });
      }
      result.finishedAt = new Date().toISOString();
      await writeFile(join(artifactsDir, 'results.json'), JSON.stringify({ suite, startedAt, configuration, results, errors }, null, 2));
      console.log(`${site.name}: ${result.status} — ${result.reason}`);
    }
  } catch (error) {
    errors.push({ phase: 'suite', error: errorDetails(error) });
  } finally {
    if (sessionId) {
      try { await manager.stop(sessionId, `${suite}_finished`); }
      catch (error) { errors.push({ phase: 'stop', error: errorDetails(error) }); }
    }
    try { await manager.shutdown(); }
    catch (error) { errors.push({ phase: 'shutdown', error: errorDetails(error) }); }
    const failed = errors.length > 0 || results.some((result) => result.status === 'failed' || result.runtimeAssessment?.status === 'failed' || result.errors.length > 0);
    const incomplete = results.length !== sites.length || results.some((result) => result.status !== 'passed');
    const exitCode = failed ? 1 : incomplete ? 2 : 0;
    if (exitCode) process.exitCode = exitCode;
    await writeFile(join(artifactsDir, 'results.json'), JSON.stringify({ suite, startedAt, finishedAt: new Date().toISOString(), configuration, status: failed ? 'failed' : incomplete ? 'inconclusive' : 'passed', exitCode, results, errors }, null, 2));
    console.log(`Benchmark evidence: ${artifactsDir}`);
    for (const error of errors) console.error(error);
  }
}
