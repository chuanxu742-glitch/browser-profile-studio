import { z } from "zod";
import { HARD_AUTOMATION_LIMITS } from '../browser/automation-policy.js';

/**
 * Schemas are intentionally strict. Privileged browser controls are not part
 * of the public MCP contract; callers receive only bounded high-level inputs.
 */

const SessionId = z.string().min(8).max(128);
const TenantId = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'tenantId contains invalid characters');
const TenantToken = z.string().min(32).max(4096);
const TenantAuthFields = {
  tenantId: TenantId.optional(),
  tenantToken: TenantToken.optional(),
};
const TabId = z.string().min(1).max(128).regex(/^tab_[A-Za-z0-9_-]+$/);
const SafeProfile = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "profile must be a name, not a path");

export const ViewportSchema = z
  .object({
    width: z.number().int().min(800).max(2560),
    height: z.number().int().min(600).max(1440),
  })
  .strict();

const RoleTarget = z
  .object({
    role: z.string().min(1).max(64),
    name: z.string().min(1).max(500),
    exact: z.boolean().default(true),
  })
  .strict();

const LabelTarget = z
  .object({
    label: z.string().min(1).max(500),
    exact: z.boolean().default(true),
  })
  .strict();

const TestIdTarget = z
  .object({
    testId: z.string().min(1).max(128),
  })
  .strict();

const RefTarget = z
  .object({
    ref: z.string().min(1).max(100),
  })
  .strict();

export const TargetSchema = z.union([RoleTarget, LabelTarget, TestIdTarget, RefTarget]);
export const SemanticTargetInputSchema = TargetSchema;

const ActionId = z.string().uuid().max(64);
const WriteGuardFields = {
  actionId: ActionId.optional(),
  expectedPageRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  expectedTabId: TabId.optional(),
};

export const ProxyConfigSchema = z.object({
  server: z.string().min(1).max(2048),
  type: z.enum(['http', 'https', 'socks4', 'socks5']).optional(),
  username: z.string().max(256).optional(),
  password: z.string().max(256).optional(),
  bypass: z.string().max(2048).optional(),
}).strict();

export const ProxyInputSchema = z.union([z.string().min(1).max(2048), ProxyConfigSchema]);

export const GeoInputSchema = z.object({
  countryCode: z.string().min(2).max(4).optional(),
  timezone: z.string().min(1).max(64).optional(),
  locale: z.string().min(1).max(32).optional(),
  geolocation: z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracy: z.number().min(0).max(10000).optional(),
  }).strict().optional(),
}).strict();

export const CookieRecordSchema = z.object({
  name: z.string().min(1).max(256),
  value: z.string().max(10000),
  domain: z.string().min(1).max(256),
  path: z.string().min(1).max(512).default('/'),
  expires: z.number().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
}).strict();

export const BrowserStartSchema = z
  .object({
    headless: z.boolean().default(true),
    engine: z.enum(['firefox', 'chromium']).default('firefox'),
    profile: SafeProfile.optional(),
    profileId: z.string().min(1).max(128).optional(),
    proxy: ProxyInputSchema.optional(),
    countryCode: z.string().min(2).max(4).optional(),
    timezone: z.string().min(1).max(64).optional(),
    locale: z.string().min(1).max(32).optional(),
    geolocation: z.object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      accuracy: z.number().min(0).max(10000).optional(),
    }).strict().optional(),
    userAgent: z.string().min(1).max(1024).optional(),
    fingerprint: z.boolean().default(true).optional(),
    fingerprintSeed: z.number().int().min(0).max(2_147_483_647).optional(),
    viewport: ViewportSchema.optional(),
    seed: z.number().int().min(0).max(2_147_483_647).optional(),
    workspaceName: z.string().min(1).max(128).optional(),
    workspaceRetention: z.enum(['destroy', 'keep_until']).default('destroy'),
    ...TenantAuthFields,
  })
  .strict();

export const ProfileCreateSchema = z.object({
  name: z.string().min(1).max(128),
  profileId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/).optional(),
  description: z.string().max(1000).optional(),
  tags: z.array(z.string().max(64)).max(20).optional(),
  proxy: ProxyInputSchema.optional(),
  geo: GeoInputSchema.optional(),
  engine: z.enum(['firefox', 'chromium']).default('firefox'),
  userAgent: z.string().max(1024).optional(),
  initialCookies: z.union([z.string().max(500000), z.array(CookieRecordSchema).max(1000)]).optional(),
  cookieFormat: z.enum(['json', 'netscape']).default('json'),
  ...TenantAuthFields,
}).strict();

export const ProfileListSchema = z.object({
  ...TenantAuthFields,
}).strict();

export const ProfileGetSchema = z.object({
  profileId: z.string().min(1).max(128),
  ...TenantAuthFields,
}).strict();

export const ProfileDeleteSchema = z.object({
  profileId: z.string().min(1).max(128),
  ...TenantAuthFields,
}).strict();

export const ProfileExportCookiesSchema = z.object({
  profileId: z.string().min(1).max(128),
  format: z.enum(['json', 'netscape']).default('json'),
  ...TenantAuthFields,
}).strict();

export const ProfileImportCookiesSchema = z.object({
  profileId: z.string().min(1).max(128),
  cookies: z.union([z.string().max(500000), z.array(CookieRecordSchema).max(1000)]),
  format: z.enum(['json', 'netscape']).default('json'),
  ...TenantAuthFields,
}).strict();

export const ProxyCheckSchema = z.object({
  proxy: ProxyInputSchema,
  ...TenantAuthFields,
}).strict();

export const BrowserStatusSchema = z
  .object({ sessionId: SessionId, ...TenantAuthFields })
  .strict();

export const BrowserStopSchema = z
  .object({ sessionId: SessionId, ...TenantAuthFields })
  .strict();

export const BrowserReopenHeadedSchema = z
  .object({ sessionId: SessionId, ...TenantAuthFields })
  .strict();

export const BrowserResumeSchema = z
  .object({
    sessionId: SessionId,
    humanConfirmed: z.literal(true),
    ...TenantAuthFields,
  })
  .strict();

export const BrowserHandoffSchema = z
  .object({
    sessionId: SessionId,
    ttlMs: z.number().int().min(30_000).max(15 * 60_000).default(5 * 60_000),
    reason: z.enum(['user_requested', 'sensitive_step', 'operator_review', 'challenge']).default('user_requested'),
    ...TenantAuthFields,
  })
  .strict();

export const BrowserTakeoverSchema = z
  .object({
    sessionId: SessionId,
    leaseToken: z.string().min(32).max(256).regex(/^[A-Za-z0-9_-]+$/),
    humanConfirmed: z.literal(true),
    ...TenantAuthFields,
  })
  .strict();
const WorkspaceId = z.string().min(8).max(128).regex(/^wsp_[A-Za-z0-9_-]+$/);
const LeaseToken = z.string().min(32).max(256).regex(/^[A-Za-z0-9_-]+$/);

export const WorkspaceListSchema = z.object({ ...TenantAuthFields }).strict();

export const WorkspaceGetSchema = z.object({
  workspaceId: WorkspaceId,
  ...TenantAuthFields,
}).strict();

export const WorkspaceHandoffSchema = z.object({
  workspaceId: WorkspaceId,
  reason: z.string().min(1).max(256).optional(),
  ...TenantAuthFields,
}).strict();

export const WorkspaceResumeSchema = z.object({
  workspaceId: WorkspaceId,
  leaseId: LeaseToken,
  humanConfirmed: z.literal(true),
  ...TenantAuthFields,
}).strict();

export const PageListTabsSchema = z.object({
  sessionId: SessionId,
  ...TenantAuthFields,
}).strict();

export const PageSwitchTabSchema = z.object({
  sessionId: SessionId,
  tabId: TabId,
  ...TenantAuthFields,
}).strict();

export const PageCloseTabSchema = z.object({
  sessionId: SessionId,
  tabId: TabId,
  ...TenantAuthFields,
}).strict();

export const BrowserCapabilitiesSchema = z.object({}).strict();


const HttpUrl = z
  .string()
  .min(1)
  .max(2048)
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
    } catch {
      return false;
    }
  }, "url must be an absolute http(s) URL without credentials");

export const PageOpenSchema = z
  .object({
    sessionId: SessionId,
    url: HttpUrl,
    waitUntil: z.enum(["domcontentloaded", "load"]).default("domcontentloaded"),
    timeoutMs: z.number().int().min(1_000).max(60_000).optional(),
    ...WriteGuardFields,
    ...TenantAuthFields,
  })
  .strict();

export const PageSnapshotSchema = z
  .object({
    sessionId: SessionId,
    maxChars: z.number().int().min(100).max(50_000).default(12_000),
    maxBytes: z.number().int().min(100).max(HARD_AUTOMATION_LIMITS.snapshotMaxSnapshotBytes).default(16_000),
    format: z.enum(['structured', 'compact']).default('structured'),
    sinceSnapshotId: z.string().min(8).max(180).regex(/^snp_[A-Za-z0-9_-]+$/).optional(),
    ...TenantAuthFields,
  })
  .strict();

export const PageScreenshotSchema = z
  .object({
    sessionId: SessionId,
    fullPage: z.boolean().default(false),
    ...TenantAuthFields,
  })
  .strict();

const ActionBase = z.object({
  sessionId: SessionId,
  target: TargetSchema,
  ...WriteGuardFields,
  ...TenantAuthFields,
});


export const PageClickSchema = ActionBase.extend({
  button: z.literal("left").default("left"),
  timeoutMs: z.number().int().min(500).max(30_000).optional(),
}).strict();

export const PageTypeSchema = ActionBase.extend({
  text: z.string().max(10_000),
  clear: z.boolean().default(false),
  submit: z.boolean().default(false),
  sensitive: z.boolean().default(false),
  timeoutMs: z.number().int().min(500).max(30_000).optional(),
}).strict();

export const PageSelectSchema = ActionBase.extend({
  value: z.string().min(1).max(1_000).optional(),
  label: z.string().min(1).max(1_000).optional(),
  timeoutMs: z.number().int().min(500).max(30_000).optional(),
})
  .strict()
  .refine(({ value, label }) => (value !== undefined) !== (label !== undefined), {
    message: "exactly one of value or label is required",
    path: ["value"],
  });

export const PageScrollSchema = z
  .object({
    sessionId: SessionId,
    direction: z.enum(["up", "down", "left", "right"]),
    amount: z.number().int().min(1).max(HARD_AUTOMATION_LIMITS.maxScrollAmount).default(1),
    target: TargetSchema.optional(),
    ...WriteGuardFields,
    ...TenantAuthFields,
  })
  .strict();

const WaitConditionSchema = z
  .object({
    ref: z.string().min(1).max(100),
    state: z.enum(["visible", "hidden", "enabled"]),
  })
  .strict();

export const PageWaitSchema = z
  .object({
    sessionId: SessionId,
    milliseconds: z.number().int().min(50).max(10_000).optional(),
    condition: WaitConditionSchema.optional(),
    timeoutMs: z.number().int().min(500).max(10_000).optional(),
    ...TenantAuthFields,
  })
  .strict()
  .refine(({ milliseconds, condition }) => (milliseconds !== undefined) !== (condition !== undefined), {
    message: "exactly one of milliseconds or condition is required",
    path: ["milliseconds"],
  });


const WorkflowOpenStep = z.object({
  op: z.literal('open'),
  url: HttpUrl,
  waitUntil: z.enum(['domcontentloaded', 'load']).default('domcontentloaded'),
  timeoutMs: z.number().int().min(1_000).max(HARD_AUTOMATION_LIMITS.maxWorkflowDurationMs).optional(),
}).strict();

const WorkflowClickStep = z.object({
  op: z.literal('click'),
  target: TargetSchema,
  timeoutMs: z.number().int().min(500).max(HARD_AUTOMATION_LIMITS.maxWorkflowDurationMs).optional(),
}).strict();

const WorkflowTypeStep = z.object({
  op: z.literal('type'),
  target: TargetSchema,
  text: z.string().max(10_000),
  clear: z.boolean().default(false),
  submit: z.boolean().default(false),
  sensitive: z.boolean().default(false),
  timeoutMs: z.number().int().min(500).max(HARD_AUTOMATION_LIMITS.maxWorkflowDurationMs).optional(),
}).strict();

const WorkflowSelectStep = z.object({
  op: z.literal('select'),
  target: TargetSchema,
  value: z.string().min(1).max(1_000).optional(),
  label: z.string().min(1).max(1_000).optional(),
  timeoutMs: z.number().int().min(500).max(HARD_AUTOMATION_LIMITS.maxWorkflowDurationMs).optional(),
}).strict().refine(({ value, label }) => (value !== undefined) !== (label !== undefined), {
  message: 'exactly one of value or label is required',
  path: ['value'],
});

const WorkflowScrollStep = z.object({
  op: z.literal('scroll'),
  direction: z.enum(['up', 'down', 'left', 'right']),
  amount: z.number().int().min(1).max(HARD_AUTOMATION_LIMITS.maxScrollAmount).default(1),
  target: TargetSchema.optional(),
}).strict();

const WorkflowWaitStep = z.object({
  op: z.literal('wait'),
  milliseconds: z.number().int().min(50).max(10_000).optional(),
  condition: WaitConditionSchema.optional(),
  timeoutMs: z.number().int().min(500).max(HARD_AUTOMATION_LIMITS.maxWorkflowDurationMs).optional(),
}).strict().refine(({ milliseconds, condition }) => (milliseconds !== undefined) !== (condition !== undefined), {
  message: 'exactly one of milliseconds or condition is required',
  path: ['milliseconds'],
});

const WorkflowSnapshotStep = z.object({
  op: z.literal('snapshot'),
  maxChars: z.number().int().min(100).max(50_000).default(12_000),
  maxBytes: z.number().int().min(100).max(HARD_AUTOMATION_LIMITS.snapshotMaxSnapshotBytes).default(16_000),
  format: z.enum(['structured', 'compact']).default('compact'),
}).strict();

export const LegacyWorkflowStepSchema = z.union([
  WorkflowOpenStep,
  WorkflowClickStep,
  WorkflowTypeStep,
  WorkflowSelectStep,
  WorkflowScrollStep,
  WorkflowWaitStep,
  WorkflowSnapshotStep,
]);

export const WorkflowStepSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('type'),
    target: SemanticTargetInputSchema,
    text: z.string().max(1_000),
  }).strict(),
  z.object({
    op: z.literal('click'),
    target: SemanticTargetInputSchema,
  }).strict(),
  z.object({
    op: z.literal('select'),
    target: SemanticTargetInputSchema,
    values: z.array(z.string().min(1).max(200)).min(1).max(32),
  }).strict(),
  z.object({
    op: z.literal('scroll'),
    direction: z.enum(['up', 'down']),
    amount: z.number().int().min(1).max(HARD_AUTOMATION_LIMITS.maxScrollAmount).optional(),
  }).strict(),

  z.object({
    op: z.literal('wait'),
    milliseconds: z.number().int().min(1).max(10_000).optional(),
    target: SemanticTargetInputSchema.optional(),
  }).strict().refine(
    ({ milliseconds, target }) => milliseconds !== undefined || target !== undefined,
    { message: 'one of milliseconds or target is required', path: ['milliseconds'] },
  ),
  z.object({
    op: z.literal('snapshot'),
    maxBytes: z.number().int().min(500).max(HARD_AUTOMATION_LIMITS.snapshotMaxSnapshotBytes).optional(),
    compact: z.boolean().optional(),
  }).strict(),
]);

export const PageWorkflowSchema = z.object({
  sessionId: SessionId,
  steps: z.array(LegacyWorkflowStepSchema).min(1).max(HARD_AUTOMATION_LIMITS.maxWorkflowSteps),
  timeoutMs: z.number().int().min(1_000).max(HARD_AUTOMATION_LIMITS.maxWorkflowDurationMs).optional(),
  maxResultBytes: z.number().int().min(1_000).max(HARD_AUTOMATION_LIMITS.maxWorkflowResultBytes).optional(),
  ...WriteGuardFields,
  ...TenantAuthFields,
}).strict();

export const PageWorkflowExecuteSchema = z.object({
  sessionId: SessionId,
  steps: z.array(WorkflowStepSchema).min(1).max(HARD_AUTOMATION_LIMITS.maxWorkflowSteps),
  stopOn: z.array(z.enum(['navigation', 'challenge', 'dialog', 'download', 'ambiguity']))
    .min(1)
    .max(5)
    .default(['challenge', 'dialog', 'ambiguity']),
  ...WriteGuardFields,
  ...TenantAuthFields,
}).strict();

export const CandidateWorkflowStepSchema = WorkflowStepSchema;

export const PageFetchSchema = z
  .object({
    url: HttpUrl,
    method: z.enum(['GET', 'HEAD']).default('GET'),
    timeoutMs: z.number().int().min(500).max(60_000).optional(),
    followRedirects: z.boolean().default(true),
  })
  .strict();

const FieldExtractorSchema = z
  .object({
    name: z.string().min(1).max(64),
    selector: z.string().max(2048).optional(),
    attribute: z.string().max(64).optional(),
    trim: z.boolean().default(true),
    defaultValue: z.string().max(10_000).optional(),
  })
  .strict();

export const PageExtractSchema = z
  .object({
    sessionId: SessionId,
    containerSelector: z.string().min(1).max(2048),
    fields: z.array(FieldExtractorSchema).min(1).max(32),
    maxItems: z.number().int().min(1).max(1000).default(100),
    ...TenantAuthFields,
  })
  .strict();

const ClusterTaskSchema = z
  .object({
    url: HttpUrl,
    mode: z.enum(['fetch', 'browser']).default('fetch'),
    priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'CRITICAL']).default('NORMAL'),
    extractionSchema: PageExtractSchema.omit({ sessionId: true }).optional(),
    maxRetries: z.number().int().min(0).max(10).default(3),
    timeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
  })
  .strict();

export const ClusterSubmitTaskSchema = ClusterTaskSchema.extend(TenantAuthFields).strict();

export const ClusterBatchSubmitSchema = z
  .object({
    tasks: z.array(ClusterTaskSchema).min(1).max(500),
    ...TenantAuthFields,
  })
  .strict();

export const ClusterStatusSchema = z.object({ ...TenantAuthFields }).strict();

export const ClusterGetTaskSchema = z
  .object({
    taskId: z.string().min(1).max(128),
    ...TenantAuthFields,
  })
  .strict();

export const TOOL_SCHEMAS = {
  browser_start: BrowserStartSchema,
  browser_status: BrowserStatusSchema,
  browser_stop: BrowserStopSchema,
  browser_reopen_headed: BrowserReopenHeadedSchema,
  browser_resume: BrowserResumeSchema,
  browser_handoff: BrowserHandoffSchema,
  browser_takeover: BrowserTakeoverSchema,
  page_fetch: PageFetchSchema,
  page_open: PageOpenSchema,
  page_snapshot: PageSnapshotSchema,
  page_extract: PageExtractSchema,
  page_screenshot: PageScreenshotSchema,
  page_click: PageClickSchema,
  page_type: PageTypeSchema,
  page_select: PageSelectSchema,
  page_scroll: PageScrollSchema,
  page_wait: PageWaitSchema,
  page_workflow: PageWorkflowSchema,
  workspace_list: WorkspaceListSchema,
  workspace_get: WorkspaceGetSchema,
  workspace_handoff: WorkspaceHandoffSchema,
  workspace_resume: WorkspaceResumeSchema,
  page_workflow_execute: PageWorkflowExecuteSchema,
  page_list_tabs: PageListTabsSchema,
  page_switch_tab: PageSwitchTabSchema,
  page_close_tab: PageCloseTabSchema,
  browser_capabilities: BrowserCapabilitiesSchema,
  cluster_submit_task: ClusterSubmitTaskSchema,
  cluster_batch_submit: ClusterBatchSubmitSchema,
  cluster_status: ClusterStatusSchema,
  cluster_get_task: ClusterGetTaskSchema,
  profile_create: ProfileCreateSchema,
  profile_list: ProfileListSchema,
  profile_get: ProfileGetSchema,
  profile_delete: ProfileDeleteSchema,
  profile_export_cookies: ProfileExportCookiesSchema,
  profile_import_cookies: ProfileImportCookiesSchema,
  proxy_check: ProxyCheckSchema,
} as const;

export type ToolName = keyof typeof TOOL_SCHEMAS;
export type ToolInput<Name extends ToolName> = z.infer<(typeof TOOL_SCHEMAS)[Name]>;

const WRITE_GUARD_JSON_PROPERTIES = {
  actionId: { type: 'string', format: 'uuid', maxLength: 64 },
  expectedPageRevision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  expectedTabId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^tab_[A-Za-z0-9_-]+$' },
} as const;


/** JSON Schema exposed by tools/list. Keep this hand-authored beside Zod so
 * the public contract is stable across Zod versions. */
export const TOOL_INPUT_SCHEMAS: Record<string, Record<string, unknown>> & Record<ToolName, Record<string, unknown>> = {
  browser_start: {
    type: "object",
    additionalProperties: false,
    properties: {
      headless: { type: "boolean", default: true },
      engine: { type: "string", enum: ["firefox", "chromium"], default: "firefox" },
      profile: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" },
      profileId: { type: "string", minLength: 1, maxLength: 128 },
      proxy: {
        oneOf: [
          { type: "string", minLength: 1, maxLength: 2048 },
          {
            type: "object",
            additionalProperties: false,
            properties: {
              server: { type: "string", minLength: 1, maxLength: 2048 },
              type: { type: "string", enum: ["http", "https", "socks4", "socks5"] },
              username: { type: "string", maxLength: 256 },
              password: { type: "string", maxLength: 256 },
              bypass: { type: "string", maxLength: 2048 },
            },
            required: ["server"],
          },
        ],
      },
      countryCode: { type: "string", minLength: 2, maxLength: 4 },
      timezone: { type: "string", minLength: 1, maxLength: 64 },
      locale: { type: "string", minLength: 1, maxLength: 32 },
      geolocation: {
        type: "object",
        additionalProperties: false,
        properties: {
          latitude: { type: "number", minimum: -90, maximum: 90 },
          longitude: { type: "number", minimum: -180, maximum: 180 },
          accuracy: { type: "number", minimum: 0, maximum: 10000 },
        },
        required: ["latitude", "longitude"],
      },
      userAgent: { type: "string", minLength: 1, maxLength: 1024 },
      fingerprint: { type: "boolean", default: true },
      fingerprintSeed: { type: "integer", minimum: 0, maximum: 2_147_483_647 },
      viewport: {
        type: "object",
        additionalProperties: false,
        properties: {
          width: { type: "integer", minimum: 800, maximum: 2560 },
          height: { type: "integer", minimum: 600, maximum: 1440 },
        },
        required: ["width", "height"],
      },
      seed: { type: "integer", minimum: 0, maximum: 2_147_483_647 },
      workspaceName: { type: "string", minLength: 1, maxLength: 128 },
      workspaceRetention: { type: "string", enum: ["destroy", "keep_until"], default: "destroy" },
    },
  },
  browser_status: {
    type: "object",
    additionalProperties: false,
    properties: { sessionId: { type: "string", minLength: 8, maxLength: 128 } },
    required: ["sessionId"],
  },
  browser_stop: {
    type: "object",
    additionalProperties: false,
    properties: {
      sessionId: { type: "string", minLength: 8, maxLength: 128 },
    },
    required: ["sessionId"],
  },
  browser_reopen_headed: {
    type: "object",
    additionalProperties: false,
    properties: {
      sessionId: { type: "string", minLength: 8, maxLength: 128 },
    },
    required: ["sessionId"],
  },
  browser_resume: {
    type: "object",
    additionalProperties: false,
    properties: {
      sessionId: { type: "string", minLength: 8, maxLength: 128 },
      humanConfirmed: { const: true },
    },
    required: ["sessionId", "humanConfirmed"],
  },
  browser_handoff: {
    type: "object",
    additionalProperties: false,
    properties: {
      sessionId: { type: "string", minLength: 8, maxLength: 128 },
      ttlMs: { type: "integer", minimum: 30_000, maximum: 900_000, default: 300_000 },
      reason: { type: "string", enum: ["user_requested", "sensitive_step", "operator_review", "challenge"], default: "user_requested" },
    },
    required: ["sessionId"],
  },
  browser_takeover: {
    type: "object",
    additionalProperties: false,
    properties: {
      sessionId: { type: "string", minLength: 8, maxLength: 128 },
      leaseToken: { type: "string", minLength: 32, maxLength: 256, pattern: "^[A-Za-z0-9_-]+$" },
      humanConfirmed: { const: true },
    },
    required: ["sessionId", "leaseToken", "humanConfirmed"],
  },
  workspace_list: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  workspace_get: {
    type: "object",
    additionalProperties: false,
    properties: {
      workspaceId: { type: "string", minLength: 8, maxLength: 128, pattern: "^wsp_[A-Za-z0-9_-]+$" },
    },
    required: ["workspaceId"],
  },
  workspace_handoff: {
    type: "object",
    additionalProperties: false,
    properties: {
      workspaceId: { type: "string", minLength: 8, maxLength: 128, pattern: "^wsp_[A-Za-z0-9_-]+$" },
      reason: { type: "string", minLength: 1, maxLength: 256 },
    },
    required: ["workspaceId"],
  },
  workspace_resume: {
    type: "object",
    additionalProperties: false,
    properties: {
      workspaceId: { type: "string", minLength: 8, maxLength: 128, pattern: "^wsp_[A-Za-z0-9_-]+$" },
      leaseId: { type: "string", minLength: 32, maxLength: 256, pattern: "^[A-Za-z0-9_-]+$" },
      humanConfirmed: { const: true },
    },
    required: ["workspaceId", "leaseId", "humanConfirmed"],
  },
  page_fetch: {
    type: "object",
    additionalProperties: false,
    properties: {
      url: { type: "string", format: "uri", maxLength: 2048 },
      method: { type: "string", enum: ["GET", "HEAD"], default: "GET" },
      timeoutMs: { type: "integer", minimum: 500, maximum: 60_000 },
      followRedirects: { type: "boolean", default: true },
    },
    required: ["url"],
  },
  page_open: {
    type: "object",
    additionalProperties: false,
    properties: {
      sessionId: { type: "string", minLength: 8, maxLength: 128 },
      url: { type: "string", format: "uri", maxLength: 2048 },
      waitUntil: { type: "string", enum: ["domcontentloaded", "load"], default: "domcontentloaded" },
      timeoutMs: { type: "integer", minimum: 1_000, maximum: 60_000 },
      ...WRITE_GUARD_JSON_PROPERTIES,
    },
    required: ["sessionId", "url"],
  },
  page_snapshot: {
    type: "object",
    additionalProperties: false,
    properties: {
      sessionId: { type: "string", minLength: 8, maxLength: 128 },
      maxChars: { type: "integer", minimum: 100, maximum: 50_000, default: 12_000 },
      maxBytes: { type: "integer", minimum: 100, maximum: HARD_AUTOMATION_LIMITS.snapshotMaxSnapshotBytes, default: 16_000 },
      format: { type: "string", enum: ["structured", "compact"], default: "structured" },
      sinceSnapshotId: { type: "string", minLength: 8, maxLength: 180, pattern: "^snp_[A-Za-z0-9_-]+$" },
    },
    required: ["sessionId"],
  },
  page_extract: {
    type: "object",
    additionalProperties: false,
    properties: {
      sessionId: { type: "string", minLength: 8, maxLength: 128 },
      containerSelector: { type: "string", minLength: 1, maxLength: 2048 },
      fields: {
        type: "array",
        minItems: 1,
        maxItems: 32,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 64 },
            selector: { type: "string", maxLength: 2048 },
            attribute: { type: "string", maxLength: 64 },
            trim: { type: "boolean", default: true },
            defaultValue: { type: "string", maxLength: 10_000 },
          },
          required: ["name"],
        },
      },
      maxItems: { type: "integer", minimum: 1, maximum: 1000, default: 100 },
    },
    required: ["sessionId", "containerSelector", "fields"],
  },
  page_screenshot: {
    type: "object",
    additionalProperties: false,
    properties: {
      sessionId: { type: "string", minLength: 8, maxLength: 128 },
      fullPage: { type: "boolean", default: false },
    },
    required: ["sessionId"],
  },
  page_click: {
    type: "object",
    additionalProperties: false,
    properties: {
      sessionId: { type: "string", minLength: 8, maxLength: 128 },
      target: { oneOf: [{ "$ref": "#/$defs/roleTarget" }, { "$ref": "#/$defs/labelTarget" }, { "$ref": "#/$defs/testIdTarget" }, { "$ref": "#/$defs/refTarget" }] },
      button: { type: "string", enum: ["left"], default: "left" },
      timeoutMs: { type: "integer", minimum: 500, maximum: 30_000 },
      ...WRITE_GUARD_JSON_PROPERTIES,
    },
    required: ["sessionId", "target"],
    $defs: {
      roleTarget: { type: "object", additionalProperties: false, properties: { role: { type: "string", minLength: 1, maxLength: 64 }, name: { type: "string", minLength: 1, maxLength: 500 }, exact: { type: "boolean", default: true } }, required: ["role", "name"] },
      labelTarget: { type: "object", additionalProperties: false, properties: { label: { type: "string", minLength: 1, maxLength: 500 }, exact: { type: "boolean", default: true } }, required: ["label"] },
      testIdTarget: { type: "object", additionalProperties: false, properties: { testId: { type: "string", minLength: 1, maxLength: 128 } }, required: ["testId"] },
      refTarget: { type: "object", additionalProperties: false, properties: { ref: { type: "string", minLength: 1, maxLength: 100 } }, required: ["ref"] },
    },
  },
  page_type: {
    type: "object",
    additionalProperties: false,
    properties: {
      sessionId: { type: "string", minLength: 8, maxLength: 128 },
      target: { oneOf: [{ "$ref": "#/$defs/roleTarget" }, { "$ref": "#/$defs/labelTarget" }, { "$ref": "#/$defs/testIdTarget" }, { "$ref": "#/$defs/refTarget" }] },
      text: { type: "string", maxLength: 10_000 },
      clear: { type: "boolean", default: false },
      submit: { type: "boolean", default: false },
      sensitive: { type: "boolean", default: false },
      timeoutMs: { type: "integer", minimum: 500, maximum: 30_000 },
      ...WRITE_GUARD_JSON_PROPERTIES,
    },
    required: ["sessionId", "target", "text"],
    $defs: {
      roleTarget: { type: "object", additionalProperties: false, properties: { role: { type: "string", minLength: 1, maxLength: 64 }, name: { type: "string", minLength: 1, maxLength: 500 }, exact: { type: "boolean", default: true } }, required: ["role", "name"] },
      labelTarget: { type: "object", additionalProperties: false, properties: { label: { type: "string", minLength: 1, maxLength: 500 }, exact: { type: "boolean", default: true } }, required: ["label"] },
      testIdTarget: { type: "object", additionalProperties: false, properties: { testId: { type: "string", minLength: 1, maxLength: 128 } }, required: ["testId"] },
      refTarget: { type: "object", additionalProperties: false, properties: { ref: { type: "string", minLength: 1, maxLength: 100 } }, required: ["ref"] },
    },
  },
  page_select: {
    type: "object",
    additionalProperties: false,
    properties: {
      sessionId: { type: "string", minLength: 8, maxLength: 128 },
      target: { oneOf: [{ "$ref": "#/$defs/roleTarget" }, { "$ref": "#/$defs/labelTarget" }, { "$ref": "#/$defs/testIdTarget" }, { "$ref": "#/$defs/refTarget" }] },
      value: { type: "string", minLength: 1, maxLength: 1_000 },
      label: { type: "string", minLength: 1, maxLength: 1_000 },
      timeoutMs: { type: "integer", minimum: 500, maximum: 30_000 },
      ...WRITE_GUARD_JSON_PROPERTIES,
    },
    required: ["sessionId", "target"],
    // JSON Schema consumers must be able to enforce the same invariant as
    // PageSelectSchema: exactly one selection mode is accepted.
    oneOf: [
      { required: ["value"], not: { required: ["label"] } },
      { required: ["label"], not: { required: ["value"] } },
    ],
    $defs: {
      roleTarget: { type: "object", additionalProperties: false, properties: { role: { type: "string", minLength: 1, maxLength: 64 }, name: { type: "string", minLength: 1, maxLength: 500 }, exact: { type: "boolean", default: true } }, required: ["role", "name"] },
      labelTarget: { type: "object", additionalProperties: false, properties: { label: { type: "string", minLength: 1, maxLength: 500 }, exact: { type: "boolean", default: true } }, required: ["label"] },
      testIdTarget: { type: "object", additionalProperties: false, properties: { testId: { type: "string", minLength: 1, maxLength: 128 } }, required: ["testId"] },
      refTarget: { type: "object", additionalProperties: false, properties: { ref: { type: "string", minLength: 1, maxLength: 100 } }, required: ["ref"] },
    },
  },
  page_scroll: {
    type: "object",
    additionalProperties: false,
    properties: {
      sessionId: { type: "string", minLength: 8, maxLength: 128 },
      direction: { type: "string", enum: ["up", "down", "left", "right"] },
      amount: { type: "integer", minimum: 1, maximum: HARD_AUTOMATION_LIMITS.maxScrollAmount, default: 1 },
      target: { oneOf: [{ "$ref": "#/$defs/roleTarget" }, { "$ref": "#/$defs/labelTarget" }, { "$ref": "#/$defs/testIdTarget" }, { "$ref": "#/$defs/refTarget" }] },
      ...WRITE_GUARD_JSON_PROPERTIES,
    },
    required: ["sessionId", "direction"],
    $defs: {
      roleTarget: { type: "object", additionalProperties: false, properties: { role: { type: "string", minLength: 1, maxLength: 64 }, name: { type: "string", minLength: 1, maxLength: 500 }, exact: { type: "boolean", default: true } }, required: ["role", "name"] },
      labelTarget: { type: "object", additionalProperties: false, properties: { label: { type: "string", minLength: 1, maxLength: 500 }, exact: { type: "boolean", default: true } }, required: ["label"] },
      testIdTarget: { type: "object", additionalProperties: false, properties: { testId: { type: "string", minLength: 1, maxLength: 128 } }, required: ["testId"] },
      refTarget: { type: "object", additionalProperties: false, properties: { ref: { type: "string", minLength: 1, maxLength: 100 } }, required: ["ref"] },
    },
  },
  page_wait: {
    type: "object",
    additionalProperties: false,
    properties: {
      sessionId: { type: "string", minLength: 8, maxLength: 128 },
      milliseconds: { type: "integer", minimum: 50, maximum: 10_000 },
      condition: {
        type: "object",
        additionalProperties: false,
        properties: { ref: { type: "string", minLength: 1, maxLength: 100 }, state: { type: "string", enum: ["visible", "hidden", "enabled"] } },
        required: ["ref", "state"],
      },
      timeoutMs: { type: "integer", minimum: 500, maximum: 10_000 },
    },
    required: ["sessionId"],
    oneOf: [
      { required: ["milliseconds"], not: { required: ["condition"] } },
      { required: ["condition"], not: { required: ["milliseconds"] } },
    ],
  },
  page_workflow: {
    type: "object",
    additionalProperties: false,
    properties: {
      sessionId: { type: "string", minLength: 8, maxLength: 128 },
      steps: {
        type: "array",
        minItems: 1,
        maxItems: HARD_AUTOMATION_LIMITS.maxWorkflowSteps,
        items: {
          oneOf: [
            {
              type: "object", additionalProperties: false,
              properties: { op: { const: "open" }, url: { type: "string", format: "uri", maxLength: 2048 }, waitUntil: { type: "string", enum: ["domcontentloaded", "load"], default: "domcontentloaded" }, timeoutMs: { type: "integer", minimum: 1_000, maximum: HARD_AUTOMATION_LIMITS.maxWorkflowDurationMs } },
              required: ["op", "url"],
            },
            {
              type: "object", additionalProperties: false,
              properties: { op: { const: "click" }, target: { oneOf: [{ "$ref": "#/$defs/roleTarget" }, { "$ref": "#/$defs/labelTarget" }, { "$ref": "#/$defs/testIdTarget" }, { "$ref": "#/$defs/refTarget" }] }, timeoutMs: { type: "integer", minimum: 500, maximum: HARD_AUTOMATION_LIMITS.maxWorkflowDurationMs } },
              required: ["op", "target"],
            },
            {
              type: "object", additionalProperties: false,
              properties: { op: { const: "type" }, target: { oneOf: [{ "$ref": "#/$defs/roleTarget" }, { "$ref": "#/$defs/labelTarget" }, { "$ref": "#/$defs/testIdTarget" }, { "$ref": "#/$defs/refTarget" }] }, text: { type: "string", maxLength: 10_000 }, clear: { type: "boolean", default: false }, submit: { type: "boolean", default: false }, sensitive: { type: "boolean", default: false }, timeoutMs: { type: "integer", minimum: 500, maximum: HARD_AUTOMATION_LIMITS.maxWorkflowDurationMs } },
              required: ["op", "target", "text"],
            },
            {
              type: "object", additionalProperties: false,
              properties: { op: { const: "select" }, target: { oneOf: [{ "$ref": "#/$defs/roleTarget" }, { "$ref": "#/$defs/labelTarget" }, { "$ref": "#/$defs/testIdTarget" }, { "$ref": "#/$defs/refTarget" }] }, value: { type: "string", minLength: 1, maxLength: 1_000 }, label: { type: "string", minLength: 1, maxLength: 1_000 }, timeoutMs: { type: "integer", minimum: 500, maximum: HARD_AUTOMATION_LIMITS.maxWorkflowDurationMs } },
              required: ["op", "target"],
              oneOf: [{ required: ["value"], not: { required: ["label"] } }, { required: ["label"], not: { required: ["value"] } }],
            },
            {
              type: "object", additionalProperties: false,
              properties: { op: { const: "scroll" }, direction: { type: "string", enum: ["up", "down", "left", "right"] }, amount: { type: "integer", minimum: 1, maximum: HARD_AUTOMATION_LIMITS.maxScrollAmount, default: 1 }, target: { oneOf: [{ "$ref": "#/$defs/roleTarget" }, { "$ref": "#/$defs/labelTarget" }, { "$ref": "#/$defs/testIdTarget" }, { "$ref": "#/$defs/refTarget" }] } },
              required: ["op", "direction"],
            },
            {
              type: "object", additionalProperties: false,
              properties: { op: { const: "wait" }, milliseconds: { type: "integer", minimum: 50, maximum: 10_000 }, condition: { type: "object", additionalProperties: false, properties: { ref: { type: "string", minLength: 1, maxLength: 100 }, state: { type: "string", enum: ["visible", "hidden", "enabled"] } }, required: ["ref", "state"] }, timeoutMs: { type: "integer", minimum: 500, maximum: 10_000 } },
              required: ["op"],
              oneOf: [{ required: ["milliseconds"], not: { required: ["condition"] } }, { required: ["condition"], not: { required: ["milliseconds"] } }],
            },
            {
              type: "object", additionalProperties: false,
              properties: { op: { const: "snapshot" }, maxChars: { type: "integer", minimum: 100, maximum: 50_000, default: 12_000 }, maxBytes: { type: "integer", minimum: 100, maximum: HARD_AUTOMATION_LIMITS.snapshotMaxSnapshotBytes, default: 16_000 }, format: { type: "string", enum: ["structured", "compact"], default: "compact" } },
            },
          ],
        },
      },
      timeoutMs: { type: "integer", minimum: 1_000, maximum: HARD_AUTOMATION_LIMITS.maxWorkflowDurationMs },
      maxResultBytes: { type: "integer", minimum: 1_000, maximum: HARD_AUTOMATION_LIMITS.maxWorkflowResultBytes },
      ...WRITE_GUARD_JSON_PROPERTIES,
    },
    required: ["sessionId", "steps"],
    $defs: {
      roleTarget: { type: "object", additionalProperties: false, properties: { role: { type: "string", minLength: 1, maxLength: 64 }, name: { type: "string", minLength: 1, maxLength: 500 }, exact: { type: "boolean", default: true } }, required: ["role", "name"] },
      labelTarget: { type: "object", additionalProperties: false, properties: { label: { type: "string", minLength: 1, maxLength: 500 }, exact: { type: "boolean", default: true } }, required: ["label"] },
      testIdTarget: { type: "object", additionalProperties: false, properties: { testId: { type: "string", minLength: 1, maxLength: 128 } }, required: ["testId"] },
      refTarget: { type: "object", additionalProperties: false, properties: { ref: { type: "string", minLength: 1, maxLength: 100 } }, required: ["ref"] },
    },
  },
  page_workflow_execute: {
    type: "object",
    additionalProperties: false,
    properties: {
      sessionId: { type: "string", minLength: 8, maxLength: 128 },
      steps: {
        type: "array",
        minItems: 1,
        maxItems: HARD_AUTOMATION_LIMITS.maxWorkflowSteps,
        items: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              properties: {
                op: { const: "type" },
                target: { oneOf: [{ "$ref": "#/$defs/roleTarget" }, { "$ref": "#/$defs/labelTarget" }, { "$ref": "#/$defs/testIdTarget" }, { "$ref": "#/$defs/refTarget" }] },
                text: { type: "string", maxLength: 1_000 },
              },
              required: ["op", "target", "text"],
            },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                op: { const: "click" },
                target: { oneOf: [{ "$ref": "#/$defs/roleTarget" }, { "$ref": "#/$defs/labelTarget" }, { "$ref": "#/$defs/testIdTarget" }, { "$ref": "#/$defs/refTarget" }] },
              },
              required: ["op", "target"],
            },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                op: { const: "select" },
                target: { oneOf: [{ "$ref": "#/$defs/roleTarget" }, { "$ref": "#/$defs/labelTarget" }, { "$ref": "#/$defs/testIdTarget" }, { "$ref": "#/$defs/refTarget" }] },
                values: { type: "array", minItems: 1, maxItems: 32, items: { type: "string", minLength: 1, maxLength: 200 } },
              },
              required: ["op", "target", "values"],
            },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                op: { const: "scroll" },
                direction: { type: "string", enum: ["up", "down"] },
                amount: { type: "integer", minimum: 1, maximum: HARD_AUTOMATION_LIMITS.maxScrollAmount },
              },
              required: ["op", "direction"],
            },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                op: { const: "wait" },
                milliseconds: { type: "integer", minimum: 1, maximum: 10_000 },
                target: { oneOf: [{ "$ref": "#/$defs/roleTarget" }, { "$ref": "#/$defs/labelTarget" }, { "$ref": "#/$defs/testIdTarget" }, { "$ref": "#/$defs/refTarget" }] },
              },
              required: ["op"],
              anyOf: [{ required: ["milliseconds"] }, { required: ["target"] }],
            },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                op: { const: "snapshot" },
                maxBytes: { type: "integer", minimum: 500, maximum: HARD_AUTOMATION_LIMITS.snapshotMaxSnapshotBytes },
                compact: { type: "boolean" },
              },
              required: ["op"],
            },
          ],
        },
      },
      stopOn: {
        type: "array",
        minItems: 1,
        maxItems: 5,
        items: { type: "string", enum: ["navigation", "challenge", "dialog", "download", "ambiguity"] },
        default: ["challenge", "dialog", "ambiguity"],
      },
      ...WRITE_GUARD_JSON_PROPERTIES,
    },
    required: ["sessionId", "steps"],
    $defs: {
      roleTarget: { type: "object", additionalProperties: false, properties: { role: { type: "string", minLength: 1, maxLength: 64 }, name: { type: "string", minLength: 1, maxLength: 500 }, exact: { type: "boolean", default: true } }, required: ["role", "name"] },
      labelTarget: { type: "object", additionalProperties: false, properties: { label: { type: "string", minLength: 1, maxLength: 500 }, exact: { type: "boolean", default: true } }, required: ["label"] },
      testIdTarget: { type: "object", additionalProperties: false, properties: { testId: { type: "string", minLength: 1, maxLength: 128 } }, required: ["testId"] },
      refTarget: { type: "object", additionalProperties: false, properties: { ref: { type: "string", minLength: 1, maxLength: 100 } }, required: ["ref"] },
    },
  },
  page_list_tabs: {
    type: "object",
    additionalProperties: false,
    properties: { sessionId: { type: "string", minLength: 8, maxLength: 128 } },
    required: ["sessionId"],
  },
  page_switch_tab: {
    type: "object",
    additionalProperties: false,
    properties: {
      sessionId: { type: "string", minLength: 8, maxLength: 128 },
      tabId: { type: "string", minLength: 1, maxLength: 128, pattern: "^tab_[A-Za-z0-9_-]+$" },
    },
    required: ["sessionId", "tabId"],
  },
  page_close_tab: {
    type: "object",
    additionalProperties: false,
    properties: {
      sessionId: { type: "string", minLength: 8, maxLength: 128 },
      tabId: { type: "string", minLength: 1, maxLength: 128, pattern: "^tab_[A-Za-z0-9_-]+$" },
    },
    required: ["sessionId", "tabId"],
  },
  browser_capabilities: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  cluster_submit_task: {
    type: "object",
    additionalProperties: false,
    properties: {
      url: { type: "string", format: "uri", maxLength: 2048 },
      mode: { type: "string", enum: ["fetch", "browser"], default: "fetch" },
      priority: { type: "string", enum: ["LOW", "NORMAL", "HIGH", "CRITICAL"], default: "NORMAL" },
      extractionSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          containerSelector: { type: "string", minLength: 1, maxLength: 2048 },
          fields: {
            type: "array",
            minItems: 1,
            maxItems: 32,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string", minLength: 1, maxLength: 64 },
                selector: { type: "string", maxLength: 2048 },
                attribute: { type: "string", maxLength: 64 },
                trim: { type: "boolean", default: true },
                defaultValue: { type: "string", maxLength: 10_000 },
              },
              required: ["name"],
            },
          },
          maxItems: { type: "integer", minimum: 1, maximum: 1000, default: 100 },
        },
        required: ["containerSelector", "fields"],
      },
      maxRetries: { type: "integer", minimum: 0, maximum: 10, default: 3 },
      timeoutMs: { type: "integer", minimum: 1000, maximum: 120_000, default: 30_000 },
      tenantId: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" },
      tenantToken: { type: "string", minLength: 32, maxLength: 4096 },
    },
    required: ["url"],
  },
  cluster_batch_submit: {
    type: "object",
    additionalProperties: false,
    properties: {
      tenantId: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" },
      tenantToken: { type: "string", minLength: 32, maxLength: 4096 },
      tasks: {
        type: "array",
        minItems: 1,
        maxItems: 500,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            url: { type: "string", format: "uri", maxLength: 2048 },
            mode: { type: "string", enum: ["fetch", "browser"], default: "fetch" },
            priority: { type: "string", enum: ["LOW", "NORMAL", "HIGH", "CRITICAL"], default: "NORMAL" },
            extractionSchema: {
              type: "object",
              additionalProperties: false,
              properties: {
                containerSelector: { type: "string", minLength: 1, maxLength: 2048 },
                fields: {
                  type: "array",
                  minItems: 1,
                  maxItems: 32,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      name: { type: "string", minLength: 1, maxLength: 64 },
                      selector: { type: "string", maxLength: 2048 },
                      attribute: { type: "string", maxLength: 64 },
                      trim: { type: "boolean", default: true },
                      defaultValue: { type: "string", maxLength: 10_000 },
                    },
                    required: ["name"],
                  },
                },
                maxItems: { type: "integer", minimum: 1, maximum: 1000, default: 100 },
              },
              required: ["containerSelector", "fields"],
            },
            maxRetries: { type: "integer", minimum: 0, maximum: 10, default: 3 },
            timeoutMs: { type: "integer", minimum: 1000, maximum: 120_000, default: 30_000 },
          },
          required: ["url"],
        },
      },
    },
    required: ["tasks"],
  },
  cluster_status: {
    type: "object",
    additionalProperties: false,
    properties: {
      tenantId: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" },
      tenantToken: { type: "string", minLength: 32, maxLength: 4096 },
    },
  },
  cluster_get_task: {
    type: "object",
    additionalProperties: false,
    properties: {
      taskId: { type: "string", minLength: 1, maxLength: 128 },
      tenantId: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" },
      tenantToken: { type: "string", minLength: 32, maxLength: 4096 },
    },
    required: ["taskId"],
  },
  profile_create: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string", minLength: 1, maxLength: 128 },
      profileId: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" },
      description: { type: "string", maxLength: 1000 },
      tags: { type: "array", items: { type: "string", maxLength: 64 }, maxItems: 20 },
      proxy: {
        oneOf: [
          { type: "string", minLength: 1, maxLength: 2048 },
          {
            type: "object",
            additionalProperties: false,
            properties: {
              server: { type: "string", minLength: 1, maxLength: 2048 },
              type: { type: "string", enum: ["http", "https", "socks4", "socks5"] },
              username: { type: "string", maxLength: 256 },
              password: { type: "string", maxLength: 256 },
              bypass: { type: "string", maxLength: 2048 },
            },
            required: ["server"],
          },
        ],
      },
      geo: {
        type: "object",
        additionalProperties: false,
        properties: {
          countryCode: { type: "string", minLength: 2, maxLength: 4 },
          timezone: { type: "string", minLength: 1, maxLength: 64 },
          locale: { type: "string", minLength: 1, maxLength: 32 },
          geolocation: {
            type: "object",
            additionalProperties: false,
            properties: {
              latitude: { type: "number", minimum: -90, maximum: 90 },
              longitude: { type: "number", minimum: -180, maximum: 180 },
              accuracy: { type: "number", minimum: 0, maximum: 10000 },
            },
            required: ["latitude", "longitude"],
          },
        },
      },
      engine: { type: "string", enum: ["firefox", "chromium"], default: "firefox" },
      userAgent: { type: "string", maxLength: 1024 },
      initialCookies: {
        oneOf: [
          { type: "string", maxLength: 500000 },
          {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string", minLength: 1, maxLength: 256 },
                value: { type: "string", maxLength: 10000 },
                domain: { type: "string", minLength: 1, maxLength: 256 },
                path: { type: "string", minLength: 1, maxLength: 512, default: "/" },
                expires: { type: "number" },
                httpOnly: { type: "boolean" },
                secure: { type: "boolean" },
                sameSite: { type: "string", enum: ["Strict", "Lax", "None"] },
              },
              required: ["name", "value", "domain"],
            },
            maxItems: 1000,
          },
        ],
      },
      cookieFormat: { type: "string", enum: ["json", "netscape"], default: "json" },
    },
    required: ["name"],
  },
  profile_list: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  profile_get: {
    type: "object",
    additionalProperties: false,
    properties: {
      profileId: { type: "string", minLength: 1, maxLength: 128 },
    },
    required: ["profileId"],
  },
  profile_delete: {
    type: "object",
    additionalProperties: false,
    properties: {
      profileId: { type: "string", minLength: 1, maxLength: 128 },
    },
    required: ["profileId"],
  },
  profile_export_cookies: {
    type: "object",
    additionalProperties: false,
    properties: {
      profileId: { type: "string", minLength: 1, maxLength: 128 },
      format: { type: "string", enum: ["json", "netscape"], default: "json" },
    },
    required: ["profileId"],
  },
  profile_import_cookies: {
    type: "object",
    additionalProperties: false,
    properties: {
      profileId: { type: "string", minLength: 1, maxLength: 128 },
      cookies: {
        oneOf: [
          { type: "string", maxLength: 500000 },
          {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string", minLength: 1, maxLength: 256 },
                value: { type: "string", maxLength: 10000 },
                domain: { type: "string", minLength: 1, maxLength: 256 },
                path: { type: "string", minLength: 1, maxLength: 512, default: "/" },
                expires: { type: "number" },
                httpOnly: { type: "boolean" },
                secure: { type: "boolean" },
                sameSite: { type: "string", enum: ["Strict", "Lax", "None"] },
              },
              required: ["name", "value", "domain"],
            },
            maxItems: 1000,
          },
        ],
      },
      format: { type: "string", enum: ["json", "netscape"], default: "json" },
    },
    required: ["profileId", "cookies"],
  },
  proxy_check: {
    type: "object",
    additionalProperties: false,
    properties: {
      proxy: {
        oneOf: [
          { type: "string", minLength: 1, maxLength: 2048 },
          {
            type: "object",
            additionalProperties: false,
            properties: {
              server: { type: "string", minLength: 1, maxLength: 2048 },
              type: { type: "string", enum: ["http", "https", "socks4", "socks5"] },
              username: { type: "string", maxLength: 256 },
              password: { type: "string", maxLength: 256 },
              bypass: { type: "string", maxLength: 2048 },
            },
            required: ["server"],
          },
        ],
      },
    },
    required: ["proxy"],
  },
};

const TENANT_AUTH_JSON_PROPERTIES = {
  tenantId: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' },
  tenantToken: { type: 'string', minLength: 32, maxLength: 4096 },
} as const;

const TENANT_SCOPED_TOOL_NAMES: readonly ToolName[] = [
  'browser_start',
  'browser_status',
  'browser_stop',
  'browser_reopen_headed',
  'browser_resume',
  'browser_handoff',
  'browser_takeover',
  'page_open',
  'page_snapshot',
  'page_extract',
  'page_screenshot',
  'page_click',
  'page_type',
  'page_select',
  'page_scroll',
  'page_wait',
  'page_workflow',
  'workspace_list',
  'workspace_get',
  'workspace_handoff',
  'workspace_resume',
  'page_workflow_execute',
  'page_list_tabs',
  'page_switch_tab',
  'page_close_tab',
  'profile_create',
  'profile_list',
  'profile_get',
  'profile_delete',
  'profile_export_cookies',
  'profile_import_cookies',
  'proxy_check',
];

for (const toolName of TENANT_SCOPED_TOOL_NAMES) {
  const properties = TOOL_INPUT_SCHEMAS[toolName].properties;
  TOOL_INPUT_SCHEMAS[toolName].properties = {
    ...(properties && typeof properties === 'object' ? properties as Record<string, unknown> : {}),
    ...TENANT_AUTH_JSON_PROPERTIES,
  };
}
