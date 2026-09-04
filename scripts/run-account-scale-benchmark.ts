import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProfileStore } from '../src/profile/profile-store.js';
import type { BrowserStorageState, ProfileMetadata } from '../src/profile/types.js';
import { SecretVault } from '../src/security/secret-vault.js';

interface BenchmarkResult {
  passed: boolean;
  metrics: {
    createLatencyMs: number;
    storageWriteLatencyMs: number;
    listLatencyMs: number;
    readLatencyMs: number;
    storageReadLatencyMs: number;
    memoryUsageMB: number;
  };
  details: {
    totalAccounts: number;
    uniqueness: {
      uniqueIds: number;
      uniqueSeeds: number;
      proxyBindings: number;
      loginStates: number;
    };
    failures: string[];
  };
}

async function runWithConcurrency<T, U>(
  tasks: readonly T[],
  concurrency: number,
  iterator: (task: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(tasks.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    async () => {
      while (nextIndex < tasks.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await iterator(tasks[index]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function readPositiveNumber(name: string, fallback: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be greater than 0 and at most ${maximum}`);
  }
  return value;
}

function readPositiveInteger(name: string, fallback: number, maximum: number): number {
  const value = readPositiveNumber(name, fallback, maximum);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function storageStateFor(profile: ProfileMetadata): BrowserStorageState {
  return {
    cookies: [{
      name: 'benchmark_session',
      value: `session-${profile.profileId}`,
      domain: 'example.com',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    }],
    origins: [{
      origin: 'https://example.com',
      localStorage: [{ name: 'account', value: profile.profileId }],
    }],
  };
}

async function runBenchmark(): Promise<void> {
  const smallTest = process.env.BENCHMARK_SMALL_TEST === '1';
  const targetCount = smallTest ? 10 : readPositiveInteger('BENCHMARK_TARGET_COUNT', 1_000, 10_000);
  const concurrency = readPositiveInteger('BENCHMARK_CONCURRENCY', 50, 200);
  const maxCreateLatency = readPositiveNumber('BENCHMARK_MAX_CREATE_LATENCY', smallTest ? 5_000 : 30_000, 600_000);
  const maxListLatency = readPositiveNumber('BENCHMARK_MAX_LIST_LATENCY', 5_000, 600_000);
  const maxReadLatency = readPositiveNumber('BENCHMARK_MAX_READ_LATENCY', smallTest ? 5_000 : 20_000, 600_000);
  const storeDir = join(tmpdir(), `scale-harness-${randomUUID()}`);
  const store = new ProfileStore(storeDir, {
    vault: new SecretVault('0123456789abcdef0123456789abcdef'),
  });
  const failures: string[] = [];

  try {
    const createTasks = Array.from({ length: targetCount }, (_, index) => ({
      name: `Account ${index}`,
      fingerprint: { seed: index + 1 },
      proxy: {
        server: `http://127.0.0.1:${10_000 + index}`,
        username: `user${index}`,
        password: `pass${index}`,
      },
    }));

    const createStart = performance.now();
    const createdProfiles = await runWithConcurrency(
      createTasks,
      concurrency,
      (task) => store.createProfile(task),
    );
    const createLatencyMs = performance.now() - createStart;

    const storageWriteStart = performance.now();
    await runWithConcurrency(createdProfiles, concurrency, (profile) => (
      store.saveStorageState(profile.profileId, storageStateFor(profile))
    ));
    const storageWriteLatencyMs = performance.now() - storageWriteStart;

    const ids = new Set(createdProfiles.map((profile) => profile.profileId));
    const seeds = new Set(createdProfiles.map((profile) => profile.fingerprint.seed));
    const proxies = new Set(createdProfiles.map((profile) => profile.proxy?.server));

    if (createdProfiles.length !== targetCount) {
      failures.push(`Expected ${targetCount} created profiles, got ${createdProfiles.length}`);
    }
    if (ids.size !== targetCount) {
      failures.push(`Duplicate profile IDs detected: expected ${targetCount}, got ${ids.size}`);
    }
    if (seeds.size !== targetCount) {
      failures.push(`Duplicate fingerprint seeds detected: expected ${targetCount}, got ${seeds.size}`);
    }
    if (proxies.size !== targetCount) {
      failures.push(`Duplicate proxies detected: expected ${targetCount}, got ${proxies.size}`);
    }

    const listStart = performance.now();
    const listedProfiles = await store.listProfiles();
    const listLatencyMs = performance.now() - listStart;
    if (listedProfiles.length !== targetCount) {
      failures.push(`List returned ${listedProfiles.length} profiles, expected ${targetCount}`);
    }

    const readStart = performance.now();
    const readProfiles = await runWithConcurrency(
      listedProfiles,
      concurrency,
      (profile) => store.getProfile(profile.profileId),
    );
    const readLatencyMs = performance.now() - readStart;
    if (readProfiles.filter((profile) => profile !== null).length !== targetCount) {
      failures.push(`Silently dropped accounts during read: expected ${targetCount}`);
    }

    const storageReadStart = performance.now();
    const storageStates = await runWithConcurrency(
      createdProfiles,
      concurrency,
      async (profile) => ({
        profile,
        state: await store.getStorageState(profile.profileId),
      }),
    );
    const storageReadLatencyMs = performance.now() - storageReadStart;
    const validLoginStates = storageStates.filter(({ profile, state }) => (
      state?.cookies[0]?.value === `session-${profile.profileId}`
      && state.origins[0]?.localStorage[0]?.value === profile.profileId
    )).length;
    if (validLoginStates !== targetCount) {
      failures.push(`Login-state isolation failed: expected ${targetCount}, got ${validLoginStates}`);
    }

    if (createLatencyMs > maxCreateLatency) {
      failures.push(`Create latency ${createLatencyMs.toFixed(2)}ms exceeded max ${maxCreateLatency}ms`);
    }
    if (storageWriteLatencyMs > maxCreateLatency) {
      failures.push(`Storage write latency ${storageWriteLatencyMs.toFixed(2)}ms exceeded max ${maxCreateLatency}ms`);
    }
    if (listLatencyMs > maxListLatency) {
      failures.push(`List latency ${listLatencyMs.toFixed(2)}ms exceeded max ${maxListLatency}ms`);
    }
    if (readLatencyMs > maxReadLatency) {
      failures.push(`Read latency ${readLatencyMs.toFixed(2)}ms exceeded max ${maxReadLatency}ms`);
    }
    if (storageReadLatencyMs > maxReadLatency) {
      failures.push(`Storage read latency ${storageReadLatencyMs.toFixed(2)}ms exceeded max ${maxReadLatency}ms`);
    }

    const result: BenchmarkResult = {
      passed: failures.length === 0,
      metrics: {
        createLatencyMs,
        storageWriteLatencyMs,
        listLatencyMs,
        readLatencyMs,
        storageReadLatencyMs,
        memoryUsageMB: process.memoryUsage().heapUsed / 1024 / 1024,
      },
      details: {
        totalAccounts: targetCount,
        uniqueness: {
          uniqueIds: ids.size,
          uniqueSeeds: seeds.size,
          proxyBindings: proxies.size,
          loginStates: validLoginStates,
        },
        failures,
      },
    };

    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ passed: false, error: message }, null, 2));
    process.exitCode = 1;
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
}

void runBenchmark();
