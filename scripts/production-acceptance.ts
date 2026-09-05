import { isIP } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.js';
import { UrlPolicy } from '../src/policy/url-policy.js';
import { SessionManager } from '../src/browser/session-manager.js';
import { BrowserToolError } from '../src/domain.js';

interface CheckResult {
  readonly name: string;
  readonly status: 'PASS' | 'FAIL' | 'SKIP';
  readonly detail: string;
}

interface AcceptanceReport {
  readonly mode: 'fixture' | 'production';
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly checks: readonly CheckResult[];
  readonly complete: boolean;
}

const env = process.env;
const fixtureMode = process.argv.includes('--fixture');
const checks: CheckResult[] = [];
const startedAt = new Date().toISOString();

function add(name: string, status: CheckResult['status'], detail: string): void {
  checks.push({ name, status, detail });
}

function csv(name: string): string[] {
  return (env[name] ?? '').split(',').map((value) => value.trim()).filter(Boolean);
}

function safeOrigin(rawUrl: string): string {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return '[invalid-url]';
  }
}

function errorDetail(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown-error';
  const details = error as Error & { details?: Record<string, unknown> };
  const field = typeof details.details?.field === 'string' ? details.details.field : undefined;
  const reason = typeof details.details?.reason === 'string' ? details.details.reason : undefined;
  return field && reason ? `${field}: ${reason}` : error.message;
}

function fixturePolicy(): { policy: UrlPolicy; hosts: readonly string[] } {
  const hosts = ['example.test'];
  return {
    hosts,
    policy: new UrlPolicy({
      allowedHosts: hosts,
      resourceHosts: hosts,
      resolver: () => ['93.184.216.34'],
      allowHttp: false,
      allowPrivateNetwork: false,
    }),
  };
}

function productionPolicy(): { policy: UrlPolicy; hosts: readonly string[] } {
  const config = loadConfig(env);
  return {
    hosts: config.allowedHosts,
    policy: new UrlPolicy(config),
  };
}

async function checkPolicyMatrix(policy: UrlPolicy, hosts: readonly string[]): Promise<void> {
  const approvedHost = hosts.find((host) => !host.startsWith('*.')) ?? hosts[0]?.replace(/^\*\./, 'acceptance.');
  if (!approvedHost) {
    add('allowlist-not-empty', 'FAIL', '没有可用的允许域名');
    return;
  }

  try {
    await policy.assertAllowed(`https://${approvedHost}/`, 'navigation');
    add('approved-https', 'PASS', `允许 HTTPS Origin ${safeOrigin(`https://${approvedHost}/`)}`);
  } catch (error: unknown) {
    add('approved-https', 'FAIL', error instanceof Error ? error.message : '允许 HTTPS 检查失败');
  }

  for (const [name, rawUrl, expectedCode, expectedReason] of [
    ['unauthorized-host', 'https://not-in-allowlist.invalid/', 'DOMAIN_NOT_ALLOWED', undefined],
    ['loopback-blocked', 'https://127.0.0.1/', 'PRIVATE_NETWORK_DENIED', 'loopback'],
    ['metadata-blocked', 'https://169.254.169.254/', 'PRIVATE_NETWORK_DENIED', 'metadata'],
    ['http-blocked', `http://${approvedHost}/`, 'NAVIGATION_BLOCKED', 'scheme-not-allowed'],
  ] as const) {
    // Include the protected literal in the probe allowlist so this tests the
    // network guard, not an earlier unrelated host denial.
    const probePolicy = name === 'loopback-blocked' || name === 'metadata-blocked'
      ? new UrlPolicy({ allowedHosts: [new URL(rawUrl).hostname], allowPrivateNetwork: policy.allowPrivateNetwork })
      : policy;
    try {
      await probePolicy.assertAllowed(rawUrl, 'navigation');
      add(name, 'FAIL', `策略错误放行 ${safeOrigin(rawUrl)}`);
    } catch (error: unknown) {
      const blocked = error instanceof BrowserToolError && error.code === expectedCode
        && (expectedReason === undefined || error.details?.reason === expectedReason);
      add(name, blocked ? 'PASS' : 'FAIL', blocked ? `已验证阻断 ${safeOrigin(rawUrl)}` : `未观察到预期策略阻断：${errorDetail(error)}`);
    }
  }
}

async function checkTargetUrl(policy: UrlPolicy, rawUrl: string): Promise<void> {
  const origin = safeOrigin(rawUrl);
  try {
    await policy.assertAllowed(rawUrl, 'navigation');
  } catch (error: unknown) {
    add(`target-policy:${origin}`, 'FAIL', error instanceof Error ? error.message : '目标 URL 未通过策略');
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(env.ACCEPTANCE_TIMEOUT_MS ?? 15_000));
  try {
    const response = await fetch(rawUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1' },
      signal: controller.signal,
    });
    const location = response.headers.get('location');
    if (location) {
      const redirectUrl = new URL(location, rawUrl).toString();
      try {
        await policy.assertAllowed(redirectUrl, 'navigation');
        add(`redirect-policy:${origin}`, 'PASS', `重定向目标仍在策略内，未自动跟随（HTTP ${response.status}）`);
      } catch (error: unknown) {
        add(`redirect-policy:${origin}`, 'FAIL', `重定向目标未获批准，未跟随（HTTP ${response.status}）：${errorDetail(error)}`);
      }
    }
    add(`target-network:${origin}`, response.ok ? 'PASS' : response.status >= 300 && response.status < 400 ? 'SKIP' : 'FAIL', `Node GET HTTP ${response.status}；仅直连 HTTP 观测，不证明浏览器/代理路径或业务成功`);
    await response.body?.cancel();
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.name : 'network-error';
    add(`target-network:${origin}`, 'FAIL', detail);
  } finally {
    clearTimeout(timer);
  }
}

async function checkBrowserTargets(policy: UrlPolicy, targets: readonly string[]): Promise<void> {
  if (targets.length === 0) {
    add('browser-target-domains', 'SKIP', '未设置业务目标；未采集浏览器路径');
    return;
  }
  const manager = new SessionManager({ maxSessions: 1, urlPolicy: policy });
  try {
    const session = await manager.start({
      engine: 'chromium', headless: true, fingerprint: true,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...(env.ACCEPTANCE_PROXY_URL ? { proxy: { server: env.ACCEPTANCE_PROXY_URL } } : {}),
    });
    for (const target of targets) {
      const name = `browser-target:${safeOrigin(target)}`;
      try {
        const result = await manager.open(session.sessionId, target, { timeoutMs: 15_000, waitUntil: 'load' });
        if (!result.url || result.state !== 'READY') {
          add(name, 'FAIL', '未观察到获批准的浏览器最终 URL 或 READY 状态');
          continue;
        }
        await policy.assertAllowed(result.url, 'navigation');
        if (result.navigationCompleted !== true || result.httpStatus === undefined) {
          add(name, 'SKIP', '浏览器完整加载或 HTTP 状态未验证；部分加载不视为通过');
          continue;
        }
        const ok = result.httpStatus >= 200 && result.httpStatus < 300;
        add(name, ok ? 'PASS' : 'FAIL', `Chromium GET HTTP ${result.httpStatus}；最终 Origin ${safeOrigin(result.url)}；仅证明本次导航，不证明业务或检测成功`);
      } catch (error: unknown) {
        add(name, 'FAIL', errorDetail(error));
      }
    }
  } catch (error: unknown) {
    add('browser-target-domains', 'FAIL', errorDetail(error));
  } finally {
    try {
      await manager.shutdown();
    } catch (error: unknown) {
      add('browser-target-cleanup', 'FAIL', errorDetail(error));
    }
  }
}

async function checkEgress(): Promise<void> {
  const expected = csv('ACCEPTANCE_EXPECTED_EGRESS_IPS');
  if (expected.some((value) => isIP(value) === 0)) {
    add('egress-ip', 'FAIL', 'ACCEPTANCE_EXPECTED_EGRESS_IPS 包含非法 IP');
    return;
  }
  if (expected.length === 0) {
    add('browser-egress-ip', 'SKIP', '未设置 ACCEPTANCE_EXPECTED_EGRESS_IPS；浏览器实际出口尚未验证');
    return;
  }
  const probeUrl = env.ACCEPTANCE_EGRESS_IP_URL?.trim();
  if (!probeUrl) {
    add('egress-ip', 'FAIL', '设置了预期出口 IP，但缺少 ACCEPTANCE_EGRESS_IP_URL');
    return;
  }
  try {
    const parsedProbe = new URL(probeUrl);
    if (parsedProbe.protocol !== 'https:') {
      add('egress-ip', 'FAIL', '出口探针必须使用 HTTPS');
      return;
    }
  } catch {
    add('egress-ip', 'FAIL', '出口探针 URL 无效');
    return;
  }
  const probeHost = new URL(probeUrl).hostname;
  const manager = new SessionManager({
    maxSessions: 1,
    urlPolicy: new UrlPolicy({ allowedHosts: [probeHost], resourceHosts: [probeHost] }),
  });
  try {
    const session = await manager.start({
      engine: 'chromium', headless: true, fingerprint: true,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...(env.ACCEPTANCE_PROXY_URL ? { proxy: { server: env.ACCEPTANCE_PROXY_URL } } : {}),
    });
    const navigation = await manager.open(session.sessionId, probeUrl, { timeoutMs: 15_000, waitUntil: 'load' });
    if (navigation.navigationCompleted !== true || navigation.httpStatus === undefined) {
      add('browser-egress-ip', 'SKIP', '出口探针的完整加载或 HTTP 状态未验证');
      return;
    }
    if (navigation.state !== 'READY' || navigation.httpStatus < 200 || navigation.httpStatus >= 300) {
      add('browser-egress-ip', 'FAIL', `出口探针未成功完成：HTTP ${navigation.httpStatus}`);
      return;
    }
    const snapshot = await manager.snapshot(session.sessionId, { includeText: true, maxChars: 1024 });
    if (snapshot.textTruncated) {
      add('browser-egress-ip', 'FAIL', '出口探针文本被截断，不能作为完整 IP 响应');
      return;
    }
    let observed = (snapshot.text ?? '').trim();
    if (observed.startsWith('{')) {
      const payload: unknown = JSON.parse(observed);
      observed = payload && typeof payload === 'object' && 'ip' in payload && typeof payload.ip === 'string' ? payload.ip.trim() : '';
    }
    if (isIP(observed) === 0) {
      add('browser-egress-ip', 'FAIL', '浏览器出口探针未返回合法 IP');
      return;
    }
    add('browser-egress-ip', expected.includes(observed) ? 'PASS' : 'FAIL', `Chromium 浏览器实际 GET 观测 ${observed}；预期 ${expected.join(',')}`);
  } catch (error: unknown) {
    add('browser-egress-ip', 'FAIL', errorDetail(error));
  } finally {
    try {
      await manager.shutdown();
    } catch (error: unknown) {
      add('browser-egress-cleanup', 'FAIL', errorDetail(error));
    }
  }
}

async function main(): Promise<void> {
  let policy: UrlPolicy;
  let hosts: readonly string[];
  try {
    ({ policy, hosts } = fixtureMode ? fixturePolicy() : productionPolicy());
    add('configuration', 'PASS', fixtureMode ? 'fixture：HTTPS、私网阻断已固定启用' : `生产配置：${hosts.length} 条 allowlist 规则`);
    if (!fixtureMode && (policy.allowHttp || policy.allowPrivateNetwork)) {
      add('production-safe-defaults', 'FAIL', '生产配置必须保持 BROWSER_ALLOW_HTTP=false 且 BROWSER_ALLOW_PRIVATE_NETWORK=false');
      await finish('production');
      return;
    }
    add('production-safe-defaults', 'PASS', '仅允许 HTTPS，已阻断私网与元数据地址');
  } catch (error: unknown) {
    add('configuration', 'FAIL', errorDetail(error));
    await finish('production');
    return;
  }

  await checkPolicyMatrix(policy, hosts);
  if (fixtureMode) {
    add('target-domains', 'SKIP', 'fixture 模式不访问业务域名，即使已配置目标 URL');
    add('browser-egress-ip', 'SKIP', 'fixture 模式不启动浏览器或访问出口探针');
    await finish('fixture');
    return;
  }
  const targets = csv('ACCEPTANCE_TARGET_URLS');
  if (targets.length === 0) {
    add('target-domains', 'SKIP', '未设置 ACCEPTANCE_TARGET_URLS；未访问任何业务域名');
  } else {
    for (const target of targets) await checkTargetUrl(policy, target);
  }
  await checkBrowserTargets(policy, targets);
  await checkEgress();
  await finish(fixtureMode ? 'fixture' : 'production');
}

async function finish(mode: AcceptanceReport['mode']): Promise<void> {
  const report: AcceptanceReport = {
    mode,
    startedAt,
    finishedAt: new Date().toISOString(),
    checks,
    complete: mode === 'production' && checks.every(check => check.status === 'PASS'),
  };
  for (const check of checks) console.log(`[${check.status}] ${check.name}: ${check.detail}`);
  const reportPath = env.ACCEPTANCE_REPORT_PATH?.trim();
  if (reportPath) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  if (checks.some((check) => check.status === 'FAIL') || (mode === 'production' && !report.complete)) process.exitCode = 1;
}

void main();
