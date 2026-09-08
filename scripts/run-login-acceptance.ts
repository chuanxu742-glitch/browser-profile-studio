import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { LoginProviderMatrix, ProviderConfigSchema } from '../src/acceptance/login-provider-matrix.js';
import { z } from 'zod';

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (!configPath) {
    console.error(JSON.stringify({ error: 'Usage: npm run acceptance:login -- <path-to-config.json>' }));
    process.exit(1);
  }

  let configs: unknown;
  try {
    const data = await readFile(resolve(process.cwd(), configPath), 'utf8');
    configs = JSON.parse(data);
  } catch (error) {
    console.error(JSON.stringify({ error: 'Failed to read or parse config file', details: String(error) }));
    process.exit(1);
  }

  const ConfigArraySchema = z.array(ProviderConfigSchema).min(1);
  const parseResult = ConfigArraySchema.safeParse(configs);

  if (!parseResult.success) {
    console.error(JSON.stringify({ error: 'Invalid configuration format', issues: parseResult.error.issues }));
    process.exit(1);
  }

  const validConfigs = parseResult.data;
  const matrix = new LoginProviderMatrix();
  const results = validConfigs.map(config => matrix.evaluate(config));

  let passed = 0;
  let failed = 0;
  let blocked = 0;

  for (const result of results) {
    if (result.outcome === 'pass') passed++;
    else if (result.outcome === 'fail') failed++;
    else if (result.outcome === 'blocked') blocked++;
  }

  const output = {
    summary: {
      passed,
      failed,
      blocked,
      total: results.length,
    },
    results,
  };

  console.log(JSON.stringify(output, null, 2));

  if (failed > 0) {
    process.exitCode = 1;
  } else if (blocked > 0) {
    process.exitCode = 2;
  }
}

void main().catch((error: unknown) => {
  console.error(JSON.stringify({ error: 'Unexpected error', details: String(error) }));
  process.exitCode = 1;
});
