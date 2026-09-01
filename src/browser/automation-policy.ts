export const AUTOMATION_POLICY_NAMES = ['strict', 'standard', 'trusted-local'] as const;
export type AutomationPolicyName = (typeof AUTOMATION_POLICY_NAMES)[number];

/** Resource ceilings that can be tuned by an administrator, never by a tool call. */
export interface AutomationPolicyLimits {
  readonly maxTabs: number;
  readonly maxWorkflowSteps: number;
  readonly maxWorkflowDurationMs: number;
  readonly maxWorkflowResultBytes: number;
  readonly maxScrollAmount: number;
  readonly snapshotMaxSnapshots: number;
  readonly snapshotTtlMs: number;
  readonly snapshotMaxBytes: number;
  readonly snapshotMaxSnapshotBytes: number;
  readonly sessionTtlMs: number;
  readonly workspaceTtlMs: number;
}

export interface AutomationPolicy {
  readonly name: AutomationPolicyName;
  readonly limits: AutomationPolicyLimits;
}

/** Absolute ceilings retained even for trusted local deployments. */
export const HARD_AUTOMATION_LIMITS: AutomationPolicyLimits = Object.freeze({
  maxTabs: 32,
  maxWorkflowSteps: 100,
  maxWorkflowDurationMs: 5 * 60_000,
  maxWorkflowResultBytes: 1_024 * 1_024,
  maxScrollAmount: 20,
  snapshotMaxSnapshots: 256,
  snapshotTtlMs: 24 * 60 * 60_000,
  snapshotMaxBytes: 16 * 1024 * 1024,
  snapshotMaxSnapshotBytes: 4 * 1024 * 1024,
  sessionTtlMs: 24 * 60 * 60_000,
  workspaceTtlMs: 7 * 24 * 60 * 60_000,
});

const POLICY_PROFILES: Readonly<Record<AutomationPolicyName, AutomationPolicy>> = Object.freeze({
  strict: Object.freeze({
    name: 'strict',
    limits: Object.freeze({
      maxTabs: 5,
      maxWorkflowSteps: 10,
      maxWorkflowDurationMs: 30_000,
      maxWorkflowResultBytes: 64_000,
      maxScrollAmount: 3,
      snapshotMaxSnapshots: 32,
      snapshotTtlMs: 10 * 60_000,
      snapshotMaxBytes: 2 * 1024 * 1024,
      snapshotMaxSnapshotBytes: 256 * 1024,
      sessionTtlMs: 30 * 60_000,
      workspaceTtlMs: 24 * 60 * 60_000,
    }),
  }),
  standard: Object.freeze({
    name: 'standard',
    limits: Object.freeze({
      maxTabs: 12,
      maxWorkflowSteps: 50,
      maxWorkflowDurationMs: 2 * 60_000,
      maxWorkflowResultBytes: 256 * 1024,
      maxScrollAmount: 10,
      snapshotMaxSnapshots: 64,
      snapshotTtlMs: 30 * 60_000,
      snapshotMaxBytes: 4 * 1024 * 1024,
      snapshotMaxSnapshotBytes: 512 * 1024,
      sessionTtlMs: 2 * 60 * 60_000,
      workspaceTtlMs: 7 * 24 * 60 * 60_000,
    }),
  }),
  'trusted-local': Object.freeze({
    name: 'trusted-local',
    limits: Object.freeze({
      maxTabs: 20,
      maxWorkflowSteps: 100,
      maxWorkflowDurationMs: 5 * 60_000,
      maxWorkflowResultBytes: 1_024 * 1024,
      maxScrollAmount: 20,
      snapshotMaxSnapshots: 256,
      snapshotTtlMs: 24 * 60 * 60_000,
      snapshotMaxBytes: 16 * 1024 * 1024,
      snapshotMaxSnapshotBytes: 1 * 1024 * 1024,
      sessionTtlMs: 24 * 60 * 60_000,
      workspaceTtlMs: 7 * 24 * 60 * 60_000,
    }),
  }),
});

export const DEFAULT_AUTOMATION_POLICY: AutomationPolicyName = 'standard';

export function getAutomationPolicy(name: AutomationPolicyName = DEFAULT_AUTOMATION_POLICY): AutomationPolicy {
  return POLICY_PROFILES[name];
}

export function parseAutomationPolicy(value: string | undefined): AutomationPolicyName {
  const normalized = value?.trim() || DEFAULT_AUTOMATION_POLICY;
  if ((AUTOMATION_POLICY_NAMES as readonly string[]).includes(normalized)) {
    return normalized as AutomationPolicyName;
  }
  throw new Error(`Unknown automation policy: ${normalized}`);
}
