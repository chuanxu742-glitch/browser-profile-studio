export const DEFAULT_TENANT_ID = 'default';

const TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Tenant IDs are also used inside Redis hash tags, so braces and separators
 * outside this small vocabulary are rejected before they reach a key name. */
export function normalizeTenantId(value: string | undefined): string {
  const tenantId = value ?? DEFAULT_TENANT_ID;
  if (!TENANT_ID_PATTERN.test(tenantId)) throw new Error('Invalid tenant ID.');
  return tenantId;
}

export function isTenantId(value: unknown): value is string {
  return typeof value === 'string' && TENANT_ID_PATTERN.test(value);
}
