import { z } from 'zod';

export const LoginCapabilitySchema = z.enum([
  'cookie',
  'localStorage',
  'indexedDB',
  'oauth_redirect',
  'challenge_takeover',
  'virtual_webauthn',
]);
export type LoginCapability = z.infer<typeof LoginCapabilitySchema>;

export const LoginOutcomeSchema = z.enum(['pass', 'fail', 'blocked']);
export type LoginOutcome = z.infer<typeof LoginOutcomeSchema>;

export const ObservationRecordSchema = z.object({
  status: LoginOutcomeSchema,
  evidence: z.string().trim().min(1).max(2_048),
  observedAt: z.string().datetime({ offset: true }),
  notes: z.string().trim().max(2_048).optional(),
}).strict();
export type ObservationRecord = z.infer<typeof ObservationRecordSchema>;

export const ProviderConfigSchema = z.object({
  providerId: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  requiredCapabilities: z.array(LoginCapabilitySchema)
    .min(1)
    .max(LoginCapabilitySchema.options.length)
    .refine((values) => new Set(values).size === values.length, 'Capabilities must be unique'),
  hasCredentials: z.boolean(),
  hasAuthorization: z.boolean(),
  observations: z.partialRecord(LoginCapabilitySchema, ObservationRecordSchema).optional(),
}).strict();
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export interface MatrixResult {
  providerId: string;
  outcome: LoginOutcome;
  failedCapabilities: LoginCapability[];
  reason?: string;
}

export class LoginProviderMatrix {
  evaluate(config: ProviderConfig): MatrixResult {
    // Dedup required capabilities
    const requiredSet = new Set(config.requiredCapabilities);

    if (!config.hasCredentials || !config.hasAuthorization) {
      return {
        providerId: config.providerId,
        outcome: 'blocked',
        failedCapabilities: [],
        reason: 'Missing required credentials or authorization',
      };
    }

    const failed: LoginCapability[] = [];
    let hasBlocked = false;
    
    for (const cap of requiredSet) {
      const observation = config.observations?.[cap];
      if (!observation) {
        hasBlocked = true;
        continue;
      }

      if (observation.status === 'fail') {
        failed.push(cap);
      } else if (observation.status === 'blocked') {
        hasBlocked = true;
      }
    }

    // Any failure produces fail
    if (failed.length > 0) {
      return {
        providerId: config.providerId,
        outcome: 'fail',
        failedCapabilities: failed,
        reason: `Failed required capabilities: ${failed.join(', ')}`,
      };
    }

    // Missing evidence or explicitly blocked observation -> blocked
    if (hasBlocked) {
      return {
        providerId: config.providerId,
        outcome: 'blocked',
        failedCapabilities: [],
        reason: 'Missing required evidence or explicitly blocked',
      };
    }

    return {
      providerId: config.providerId,
      outcome: 'pass',
      failedCapabilities: [],
    };
  }
}
