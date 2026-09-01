import { join } from 'node:path';

import { AuditLogger } from './audit.js';
import { SessionManager } from './browser/session-manager.js';
import { loadConfig } from './config.js';
import { createControlPlane } from './control-plane/server.js';
import { UrlPolicy } from './policy/url-policy.js';
import { McpRuntimeGuard } from './mcp/runtime-guard.js';

const config = loadConfig();
const port = boundedPort(process.env.CONTROL_PLANE_PORT ?? '8081');
const host = process.env.CONTROL_PLANE_HOST?.trim() || '127.0.0.1';
const audit = new AuditLogger(config.auditPath);
const manager = new SessionManager({
  cluster: false,
  maxSessions: config.maxSessions,
  ...(config.sessionTtlMs !== undefined ? { sessionTtlMs: config.sessionTtlMs } : {}),
  ...(config.workspaceTtlMs !== undefined ? { workspaceTtlMs: config.workspaceTtlMs } : {}),
  policyProfile: config.automationPolicy,
  persistentProfile: config.persistentProfiles,
  profileRoot: join(config.dataDir, 'profiles'),
  artifactsRoot: join(config.dataDir, 'artifacts'),
  urlPolicy: new UrlPolicy(config),
  audit,
  defaultTimeoutMs: config.timeoutMs,
  privateNetworkEnabled: config.allowPrivateNetwork,
});
const runtimeGuard = new McpRuntimeGuard({
  ...(config.mcpRatePerSecond !== undefined ? { ratePerSecond: config.mcpRatePerSecond } : {}),
  ...(config.mcpBurst !== undefined ? { burst: config.mcpBurst } : {}),
});
const control = createControlPlane(manager, {
  host,
  port,
  ...(process.env.CONTROL_PLANE_TOKEN ? { token: process.env.CONTROL_PLANE_TOKEN } : {}),
  statePath: join(config.dataDir, 'control-plane.json'),
  runtimeGuard,
  audit,
});

await control.start();
console.error(`[browser-control-plane] listening on http://${host}:${port}`);

let stopping: Promise<void> | undefined;
const stop = () => {
  stopping ??= control.close().finally(() => manager.shutdown());
  return stopping;
};
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });

function boundedPort(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error('CONTROL_PLANE_PORT must be an integer');
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('CONTROL_PLANE_PORT is out of range');
  return port;
}
