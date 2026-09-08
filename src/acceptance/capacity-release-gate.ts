import { z } from 'zod';

const BenchmarkMetricsSchema = z.object({
  createLatencyMs: z.number().finite().nonnegative(),
  storageWriteLatencyMs: z.number().finite().nonnegative(),
  listLatencyMs: z.number().finite().nonnegative(),
  readLatencyMs: z.number().finite().nonnegative(),
  storageReadLatencyMs: z.number().finite().nonnegative(),
  memoryUsageMB: z.number().finite().nonnegative(),
}).strict();

const UniquenessDetailsSchema = z.object({
  uniqueIds: z.number().int().nonnegative(),
  uniqueSeeds: z.number().int().nonnegative(),
  proxyBindings: z.number().int().nonnegative(),
  loginStates: z.number().int().nonnegative(),
}).strict();

const BenchmarkDetailsSchema = z.object({
  totalAccounts: z.number().int().positive(),
  uniqueness: UniquenessDetailsSchema,
  failures: z.array(z.string()),
}).strict();

export const BenchmarkResultSchema = z.object({
  passed: z.boolean(),
  metrics: BenchmarkMetricsSchema,
  details: BenchmarkDetailsSchema,
  error: z.string().optional(),
}).strict();
export type BenchmarkResult = z.infer<typeof BenchmarkResultSchema>;

export const BaselineSchema = z.object({
  version: z.literal(1),
  metrics: BenchmarkMetricsSchema,
  details: BenchmarkDetailsSchema,
  updatedAt: z.string().datetime({ offset: true }),
}).strict().superRefine((baseline, context) => {
  const total = baseline.details.totalAccounts;
  for (const [name, value] of Object.entries(baseline.details.uniqueness)) {
    if (value !== total) {
      context.addIssue({
        code: 'custom',
        path: ['details', 'uniqueness', name],
        message: `Baseline ${name} must equal totalAccounts`,
      });
    }
  }
  if (baseline.details.failures.length > 0) {
    context.addIssue({ code: 'custom', path: ['details', 'failures'], message: 'Baseline must have no failures' });
  }
});
export type Baseline = z.infer<typeof BaselineSchema>;

const GateConfigSchema = z.object({
  maxLatencyRatio: z.number().finite().positive().default(1.5),
  absoluteMaxLatencyMs: z.number().finite().positive().default(60_000),
  maxMemoryRatio: z.number().finite().positive().default(1.5),
  absoluteMaxMemoryMB: z.number().finite().positive().default(2_048),
}).strict();
export type GateConfig = z.input<typeof GateConfigSchema>;

const LATENCY_METRICS = [
  'createLatencyMs',
  'storageWriteLatencyMs',
  'listLatencyMs',
  'readLatencyMs',
  'storageReadLatencyMs',
] as const;

export interface GateEvaluation {
  passed: boolean;
  errors: string[];
}

function formatZodError(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || 'value'}: ${issue.message}`).join('; ');
}

export class CapacityReleaseGate {
  calibrate(input: unknown): Baseline {
    const result = BenchmarkResultSchema.parse(input);
    const invariantErrors = this.invariantErrors(result);
    if (!result.passed || invariantErrors.length > 0) {
      const details = [...result.details.failures, ...invariantErrors];
      throw new Error(`Cannot calibrate from an unsuccessful benchmark${details.length > 0 ? `: ${details.join('; ')}` : ''}`);
    }

    return BaselineSchema.parse({
      version: 1,
      metrics: { ...result.metrics },
      details: {
        totalAccounts: result.details.totalAccounts,
        uniqueness: { ...result.details.uniqueness },
        failures: [],
      },
      updatedAt: new Date().toISOString(),
    });
  }

  parseBaseline(input: unknown): Baseline {
    return BaselineSchema.parse(input);
  }

  evaluateGate(resultInput: unknown, baselineInput: unknown, configInput: GateConfig = {}): GateEvaluation {
    const resultParse = BenchmarkResultSchema.safeParse(resultInput);
    if (!resultParse.success) {
      return { passed: false, errors: [`Invalid benchmark result: ${formatZodError(resultParse.error)}`] };
    }
    const baselineParse = BaselineSchema.safeParse(baselineInput);
    if (!baselineParse.success) {
      return { passed: false, errors: [`Invalid capacity baseline: ${formatZodError(baselineParse.error)}`] };
    }
    const configParse = GateConfigSchema.safeParse(configInput);
    if (!configParse.success) {
      return { passed: false, errors: [`Invalid capacity gate configuration: ${formatZodError(configParse.error)}`] };
    }

    const result = resultParse.data;
    const baseline = baselineParse.data;
    const config = configParse.data;
    const errors = this.invariantErrors(result);

    if (!result.passed) errors.push('Benchmark reported passed=false');
    if (result.details.totalAccounts !== baseline.details.totalAccounts) {
      errors.push(`Total accounts mismatch: expected ${baseline.details.totalAccounts}, got ${result.details.totalAccounts}`);
    }

    for (const metric of LATENCY_METRICS) {
      const actual = result.metrics[metric];
      const reference = baseline.metrics[metric];
      if (actual > config.absoluteMaxLatencyMs) {
        errors.push(`${metric} exceeded absolute maximum: ${actual}ms > ${config.absoluteMaxLatencyMs}ms`);
      }
      if (reference > 0 && actual / reference > config.maxLatencyRatio) {
        errors.push(`${metric} regressed: ${actual}ms / ${reference}ms > ${config.maxLatencyRatio}`);
      }
    }

    const actualMemory = result.metrics.memoryUsageMB;
    const referenceMemory = baseline.metrics.memoryUsageMB;
    if (actualMemory > config.absoluteMaxMemoryMB) {
      errors.push(`memoryUsageMB exceeded absolute maximum: ${actualMemory}MB > ${config.absoluteMaxMemoryMB}MB`);
    }
    if (referenceMemory > 0 && actualMemory / referenceMemory > config.maxMemoryRatio) {
      errors.push(`memoryUsageMB regressed: ${actualMemory}MB / ${referenceMemory}MB > ${config.maxMemoryRatio}`);
    }

    return { passed: errors.length === 0, errors };
  }

  private invariantErrors(result: BenchmarkResult): string[] {
    const errors = [...result.details.failures];
    const total = result.details.totalAccounts;
    for (const [name, value] of Object.entries(result.details.uniqueness)) {
      if (value !== total) errors.push(`${name} mismatch: expected ${total}, got ${value}`);
    }
    return errors;
  }
}
