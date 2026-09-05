import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  writeFile: vi.fn(), mkdir: vi.fn(), fetch: vi.fn(),
  start: vi.fn(), open: vi.fn(), snapshot: vi.fn(), screenshot: vi.fn(),
  environmentDiagnostics: vi.fn(), shutdown: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({ writeFile: mocks.writeFile, mkdir: mocks.mkdir }));
vi.mock('node:dns', () => ({ promises: { lookup: vi.fn(async () => [{ address: '93.184.216.34' }]) } }));
vi.mock('../../src/config.js', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  loadConfig: () => ({ allowedHosts: ['example.test'], resourceHosts: ['example.test'], allowHttp: false, allowPrivateNetwork: false }),
}));
vi.mock('../../src/browser/session-manager.js', () => ({
  SessionManager: class {
    start = mocks.start;
    open = mocks.open;
    snapshot = mocks.snapshot;
    screenshot = mocks.screenshot;
    environmentDiagnostics = mocks.environmentDiagnostics;
    shutdown = mocks.shutdown;
  },
}));

type Report = {
  mode?: string;
  complete?: boolean;
  detectionResult?: string;
  error?: string;
  checks: Array<{ name: string; status: string }>;
  results: Array<{ name: string; detectionResult: string; loadStatus: string; textPath?: string; screenshotPath?: string; error?: string }>;
};

const savedArgv = process.argv;
const savedExitCode = process.exitCode;

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  process.argv = ['node', 'production-acceptance.ts'];
  process.exitCode = undefined;
  vi.stubEnv('ACCEPTANCE_TARGET_URLS', 'https://example.test/health');
  vi.stubEnv('ACCEPTANCE_EXPECTED_EGRESS_IPS', '93.184.216.34');
  vi.stubEnv('ACCEPTANCE_EGRESS_IP_URL', 'https://egress.test/ip');
  vi.stubEnv('ACCEPTANCE_REPORT_PATH', 'acceptance-report.json');
  vi.stubEnv('ACCEPTANCE_PROXY_URL', '');
  vi.stubEnv('BENCHMARK_COUNTRY', '');
  vi.stubEnv('BENCHMARK_TIMEZONE', '');
  vi.stubGlobal('fetch', mocks.fetch);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'table').mockImplementation(() => undefined);
  mocks.fetch.mockImplementation(async () => new Response('', { status: 200 }));
  mocks.start.mockResolvedValue({ sessionId: 'evidence-session' });
  mocks.open.mockImplementation(async (_id: string, url: string) => ({ url, state: 'READY', httpStatus: 200, navigationCompleted: true }));
  mocks.snapshot.mockResolvedValue({ text: '93.184.216.34', textTruncated: false });
  mocks.screenshot.mockResolvedValue({ image: { data: 'cG5n' } });
  mocks.environmentDiagnostics.mockResolvedValue({ consistency: 'warning' });
});

afterEach(() => {
  process.argv = savedArgv;
  process.exitCode = savedExitCode;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function reportFor(script: 'acceptance' | 'benchmark'): Promise<Report> {
  // These CLI modules execute on import; reload after env/mock setup to test their entrypoint boundary.
  if (script === 'acceptance') await import('../../scripts/production-acceptance.js');
  else await import('../../scripts/run-score-benchmarks.js');
  const suffix = script === 'acceptance' ? 'acceptance-report.json' : 'report.json';
  let report: Report | undefined;
  await vi.waitFor(() => {
    const call = mocks.writeFile.mock.calls.find(([path]) => String(path).endsWith(suffix));
    expect(call).toBeDefined();
    report = JSON.parse(String(call![1])) as Report;
  });
  return report!;
}

describe('production acceptance evidence', () => {
  it('keeps fixture offline and incomplete even with production environment configured', async () => {
    process.argv.push('--fixture');
    const report = await reportFor('acceptance');
    expect(report.mode).toBe('fixture');
    expect(report.complete).toBe(false);
    expect(report.checks.filter(check => check.status === 'FAIL')).toEqual([]);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('requires observed successful browser targets and egress for complete acceptance', async () => {
    const report = await reportFor('acceptance');
    expect(report.complete).toBe(true);
    expect(report.checks).toContainEqual(expect.objectContaining({ name: 'browser-egress-ip', status: 'PASS' }));
    expect(report.checks).toContainEqual(expect.objectContaining({ name: 'browser-target:https://example.test', status: 'PASS' }));
  });

  it('does not count a reachable HTTP error page as successful target acceptance', async () => {
    mocks.fetch.mockResolvedValue(new Response('', { status: 403 }));
    const report = await reportFor('acceptance');
    expect(report.checks).toContainEqual(expect.objectContaining({ name: 'target-network:https://example.test', status: 'FAIL' }));
    expect(report.complete).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('keeps authorized but unfollowed redirects incomplete', async () => {
    mocks.fetch.mockResolvedValue(new Response(null, { status: 302, headers: { location: '/login' } }));
    const report = await reportFor('acceptance');
    expect(report.checks).toContainEqual(expect.objectContaining({ name: 'target-network:https://example.test', status: 'SKIP' }));
    expect(report.complete).toBe(false);
  });

  it('does not turn unexpected policy errors into successful security evidence', async () => {
    // Use the same reloaded policy class as the CLI module after resetModules.
    const { UrlPolicy } = await import('../../src/policy/url-policy.js');
    const original = UrlPolicy.prototype.assertAllowed;
    vi.spyOn(UrlPolicy.prototype, 'assertAllowed').mockImplementation(function (this: InstanceType<typeof UrlPolicy>, url, purpose) {
      if (url === 'https://not-in-allowlist.invalid/') throw new Error('resolver unavailable');
      return original.call(this, url, purpose);
    });
    const report = await reportFor('acceptance');
    expect(report.checks).toContainEqual(expect.objectContaining({ name: 'unauthorized-host', status: 'FAIL' }));
    expect(report.complete).toBe(false);
  });

  it.each([
    { boundary: 'missing status', httpStatus: undefined, navigationCompleted: true, status: 'SKIP' },
    { boundary: 'partial load', httpStatus: 200, navigationCompleted: false, status: 'SKIP' },
    { boundary: 'HTTP error', httpStatus: 403, navigationCompleted: true, status: 'FAIL' },
  ])('does not certify browser $boundary from a successful Node GET', async ({ httpStatus, navigationCompleted, status }) => {
    mocks.open.mockImplementation(async (_id: string, url: string) => ({ url, state: 'READY', httpStatus, navigationCompleted }));
    const report = await reportFor('acceptance');
    expect(report.checks).toContainEqual(expect.objectContaining({ name: 'browser-target:https://example.test', status }));
    expect(report.checks).toContainEqual(expect.objectContaining({ name: 'browser-egress-ip', status }));
    expect(report.complete).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('does not certify egress from truncated probe text', async () => {
    mocks.snapshot.mockResolvedValue({ text: '93.184.216.34', textTruncated: true });
    const report = await reportFor('acceptance');
    expect(report.checks).toContainEqual(expect.objectContaining({ name: 'browser-egress-ip', status: 'FAIL' }));
    expect(report.complete).toBe(false);
  });

  it('preserves the report and fails acceptance when browser cleanup fails', async () => {
    mocks.shutdown.mockRejectedValue(new Error('cleanup failed'));
    const report = await reportFor('acceptance');
    expect(report.checks).toContainEqual(expect.objectContaining({ name: 'browser-egress-cleanup', status: 'FAIL' }));
    expect(report.complete).toBe(false);
    expect(process.exitCode).toBe(1);
  });
});

describe('external detector evidence', () => {
  it('never turns loaded pages into detector passes', async () => {
    const report = await reportFor('benchmark');
    expect(report.detectionResult).toBe('unverified');
    expect(report.results.map(result => [result.loadStatus, result.detectionResult])).toEqual([
      ['LOADED', 'unverified'], ['LOADED', 'unverified'],
    ]);
  });

  it('retains captured raw text and unverified status after screenshot and shutdown failures', async () => {
    mocks.screenshot.mockRejectedValue(new Error('screenshot failed'));
    mocks.shutdown.mockRejectedValue(new Error('cleanup failed'));
    const report = await reportFor('benchmark');
    expect(report.error).toContain('cleanup failed');
    expect(report.detectionResult).toBe('unverified');
    for (const result of report.results) {
      expect(result.textPath).toMatch(/\.txt$/);
      expect(result.screenshotPath).toBeUndefined();
      expect(result.error).toBe('screenshot failed');
      expect(result.detectionResult).toBe('unverified');
    }
    expect(process.exitCode).toBe(1);
  });
});
