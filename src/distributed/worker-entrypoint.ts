import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Cluster, Redis } from 'ioredis';

import { AuditLogger } from '../audit.js';
import { loadConfig } from '../config.js';
import { SessionManager } from '../browser/session-manager.js';
import { RedisQueueAdapter } from './redis-adapter.js';
import { WorkerDaemon } from './worker-daemon.js';
import { UrlPolicy } from '../policy/url-policy.js';
import { DEFAULT_TENANT_ID, normalizeTenantId } from './tenant.js';
import { AccountAdmissionController } from '../operations/account-admission.js';
import { AccountMetrics, DefaultClock } from '../operations/account-metrics.js';
import { ProfileStore } from '../profile/profile-store.js';
import { VersionedCheckpointStore } from '../profile/versioned-checkpoint-store.js';
import { AccountHealthStore } from '../account/account-health-store.js';
import { SecretVault } from '../security/secret-vault.js';
import { loadOrCreatePlatformSecret } from '../security/platform-secret.js';
import { RedisLeaseManager } from './profile-lease.js';
import { RedisSharedAccountStateStore, type AccountPlacementRecord } from './account-placement.js';

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
  const metrics = new AccountMetrics();
  metrics.addAlertRule({ id: 'high_checkpoint_failures', metric: 'checkpoint_failures', threshold: 5, windowMs: 15 * 60_000 });
  metrics.addAlertRule({ id: 'high_proxy_quarantine', metric: 'proxy_quarantine', threshold: 10, windowMs: 15 * 60_000 });
  const profileRoot = join(config.dataDir, 'profiles');
  const secret = process.env.BROWSER_MASTER_KEY
    ?? process.env.STUDIO_MASTER_KEY
    ?? await loadOrCreatePlatformSecret(join(config.dataDir, '.worker-master-key'));
  const vault = new SecretVault(secret);
  const profileStore = new ProfileStore(profileRoot, { vault });
  await profileStore.init();
  const checkpointStore = new VersionedCheckpointStore(join(config.dataDir, 'checkpoints'), { vault });
  const accountHealthStore = new AccountHealthStore(profileStore);
  const adapter = new RedisQueueAdapter({ redisUrl: process.env.REDIS_URL });
  const placementStore = new RedisSharedAccountStateStore<AccountPlacementRecord>(
    adapter.underlyingRedisClient as Redis | Cluster,
  );
  const sessionManager = new SessionManager({
    maxSessions: config.maxSessions,
    ...(config.sessionTtlMs !== undefined ? { sessionTtlMs: config.sessionTtlMs } : {}),
    ...(config.workspaceTtlMs !== undefined ? { workspaceTtlMs: config.workspaceTtlMs } : {}),
    policyProfile: config.automationPolicy,
    persistentProfile: config.persistentProfiles,
    profileRoot,
    artifactsRoot: join(config.dataDir, 'artifacts'),
    profileStore,
    checkpointStore,
    checkpointIntervalMs: config.checkpointIntervalMs,
    accountHealthStore,
    accountMetrics: metrics,
    profileLeaseManager: new RedisLeaseManager(adapter.underlyingRedisClient as Redis | Cluster),
    urlPolicy,
    audit: new AuditLogger(config.auditPath),
    defaultTimeoutMs: config.timeoutMs,
    cluster: false,
  });
  const admissionController = new AccountAdmissionController(DefaultClock, {
    concurrency: { tenant: 100, account: 5, domain: 10, proxy: 50 },
    rateLimit: { burst: 200, ratePerSecond: 10 },
  });

  const worker = new WorkerDaemon({
    workerId: process.env.WORKER_ID,
    concurrency: boundedConcurrency(process.env.WORKER_CONCURRENCY),
    allowedTenants: configuredTenants(process.env.WORKER_TENANTS),
    storageNamespace: process.env.WORKER_STORAGE_NAMESPACE,
    adapter,
    sessionManager,
    urlPolicy,
    admissionController,
    metrics,
    accountPlacementStore: placementStore,
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
