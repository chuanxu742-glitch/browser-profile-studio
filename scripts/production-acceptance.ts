import { isIP } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.js';
import { UrlPolicy } from '../src/policy/url-policy.js';

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
  const approvedHost = hosts.find((host) => !host.startsWith('*.'))?.replace(/^\*\./, '') ?? hosts[0];
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

  for (const [name, rawUrl] of [
    ['unauthorized-host', 'https://not-in-allowlist.invalid/'],
    ['loopback-blocked', 'https://127.0.0.1/'],
    ['metadata-blocked', 'https://169.254.169.254/'],
    ['http-blocked', `http://${approvedHost}/`],
  ] as const) {
    try {
      await policy.assertAllowed(rawUrl, 'navigation');
      add(name, 'FAIL', `策略错误放行 ${safeOrigin(rawUrl)}`);
    } catch {
      add(name, 'PASS', `已阻断 ${safeOrigin(rawUrl)}`);
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
      } catch {
        add(`redirect-policy:${origin}`, 'PASS', `已阻断未授权重定向（HTTP ${response.status}）`);
      }
    }
    add(`target-network:${origin}`, response.status < 500 ? 'PASS' : 'FAIL', `GET HTTP ${response.status}`);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.name : 'network-error';
    add(`target-network:${origin}`, 'FAIL', detail);
  } finally {
    clearTimeout(timer);
  }
}

async function checkEgress(): Promise<void> {
  const expected = csv('ACCEPTANCE_EXPECTED_EGRESS_IPS');
  if (expected.some((value) => isIP(value) === 0)) {
    add('egress-ip', 'FAIL', 'ACCEPTANCE_EXPECTED_EGRESS_IPS 包含非法 IP');
    return;
  }
  if (expected.length === 0) {
    add('egress-ip', 'SKIP', '未设置 ACCEPTANCE_EXPECTED_EGRESS_IPS；仅完成应用层策略验收');
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
  try {
    const response = await fetch(probeUrl, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000) });
    const observed = (await response.text()).trim().slice(0, 64);
    if (isIP(observed) === 0) {
      add('egress-ip', 'FAIL', '出口探针未返回合法 IP');
      return;
    }
    add('egress-ip', expected.includes(observed) ? 'PASS' : 'FAIL', `观测 ${observed}；预期 ${expected.join(',')}`);
  } catch (error: unknown) {
    add('egress-ip', 'FAIL', errorDetail(error));
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
  const targets = csv('ACCEPTANCE_TARGET_URLS');
  if (targets.length === 0) {
    add('target-domains', 'SKIP', '未设置 ACCEPTANCE_TARGET_URLS；未访问任何业务域名');
  } else {
    for (const target of targets) await checkTargetUrl(policy, target);
  }
  await checkEgress();
  await finish(fixtureMode ? 'fixture' : 'production');
}

async function finish(mode: AcceptanceReport['mode']): Promise<void> {
  const report: AcceptanceReport = {
    mode,
    startedAt,
    finishedAt: new Date().toISOString(),
    checks,
  };
  for (const check of checks) console.log(`[${check.status}] ${check.name}: ${check.detail}`);
  const reportPath = env.ACCEPTANCE_REPORT_PATH?.trim();
  if (reportPath) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  if (checks.some((check) => check.status === 'FAIL')) process.exitCode = 1;
}

void main();
