import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AuditLogger } from '../audit.js';
import { loadConfig } from '../config.js';
import { SessionManager } from '../browser/session-manager.js';
import { RedisQueueAdapter } from './redis-adapter.js';
import { WorkerDaemon } from './worker-daemon.js';
import { UrlPolicy } from '../policy/url-policy.js';
import { DEFAULT_TENANT_ID, normalizeTenantId } from './tenant.js';

function boundedConcurrency(raw: string | undefined): number {
  if (raw === undefined || !/^\d+$/.test(raw)) return 1;
  return Math.max(1, Math.min(32, Number(raw)));
}

function configuredTenants(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === '') return [DEFAULT_TENANT_ID];
  const values = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (values.length === 0) return [DEFAULT_TENANT_ID];
  return Object.freeze([...new Set(values.map(normalizeTenantId))]);
}

export async function startWorker(): Promise<WorkerDaemon> {
  const config = loadConfig();
  const urlPolicy = new UrlPolicy(config);
  const sessionManager = new SessionManager({
    maxSessions: config.maxSessions,
    ...(config.sessionTtlMs !== undefined ? { sessionTtlMs: config.sessionTtlMs } : {}),
    ...(config.workspaceTtlMs !== undefined ? { workspaceTtlMs: config.workspaceTtlMs } : {}),
    policyProfile: config.automationPolicy,
    profileRoot: join(config.dataDir, 'profiles'),
    artifactsRoot: join(config.dataDir, 'artifacts'),
    urlPolicy,
    audit: new AuditLogger(config.auditPath),
    defaultTimeoutMs: config.timeoutMs,
  });
  const adapter = new RedisQueueAdapter({ redisUrl: process.env.REDIS_URL });
  const worker = new WorkerDaemon({
    workerId: process.env.WORKER_ID,
    concurrency: boundedConcurrency(process.env.WORKER_CONCURRENCY),
    allowedTenants: configuredTenants(process.env.WORKER_TENANTS),
    adapter,
    sessionManager,
    urlPolicy,
  });

  await worker.start();
  return worker;
}

async function main(): Promise<void> {
  const worker = await startWorker();
  let stopping: Promise<void> | undefined;
  const stop = (): void => {
    stopping ??= worker.stop().finally(() => {
      process.exitCode = 0;
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await new Promise<void>((resolvePromise) => {
    const poll = (): void => {
      if (stopping) {
        void stopping.finally(resolvePromise);
        return;
      }
      setTimeout(poll, 250);
    };
    poll();
  });
}

const entryPath = process.argv[1];
if (entryPath && resolve(fileURLToPath(import.meta.url)) === resolve(entryPath)) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown worker startup failure.';
    console.error(`[worker] ${message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500)}`);
    process.exitCode = 1;
  });
}
