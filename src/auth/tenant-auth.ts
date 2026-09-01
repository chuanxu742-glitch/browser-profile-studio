import { timingSafeEqual } from 'node:crypto';

import { BrowserToolError } from '../domain.js';
import { isTenantId, normalizeTenantId } from '../distributed/tenant.js';

export type TenantRole = 'read' | 'submit';

interface TenantCredentialConfig {
  token: string;
  roles?: readonly TenantRole[] | undefined;
}

export interface TenantIdentity {
  tenantId: string;
  roles: readonly TenantRole[];
}

/**
 * Small opaque-token authenticator for the local MCP control plane. Tokens are
 * compared in constant time and are never copied into task records, audit
 * events, or error details. Redis authentication remains a separate concern.
 */
export class TenantAuthenticator {
  private readonly credentials = new Map<string, { token: Buffer; roles: readonly TenantRole[] }>();

  public constructor(credentials: Readonly<Record<string, string | TenantCredentialConfig>>) {
    for (const [tenantIdValue, value] of Object.entries(credentials)) {
      const tenantId = normalizeTenantId(tenantIdValue);
      const isConfigObject = value !== null && typeof value === 'object' && !Array.isArray(value);
      const token = typeof value === 'string' ? value : isConfigObject ? value.token : undefined;
      if (typeof token !== 'string' || token.length < 32 || token.length > 4_096) {
        throw new BrowserToolError('INVALID_INPUT', 'Invalid tenant authentication configuration.', {
          details: { field: 'TENANT_CREDENTIALS_JSON', reason: 'token-length' },
        });
      }
      const configuredRoles = typeof value === 'string' || !isConfigObject ? undefined : value.roles;
      if (configuredRoles !== undefined && !Array.isArray(configuredRoles)) {
        throw new BrowserToolError('INVALID_INPUT', 'Invalid tenant authentication configuration.', {
          details: { field: 'TENANT_CREDENTIALS_JSON', reason: 'roles-array-required' },
        });
      }
      const roles = configuredRoles === undefined
        ? (['read', 'submit'] as const)
        : [...new Set(configuredRoles)].filter((role): role is TenantRole => role === 'read' || role === 'submit');
      if (roles.length === 0) {
        throw new BrowserToolError('INVALID_INPUT', 'Invalid tenant authentication configuration.', {
          details: { field: 'TENANT_CREDENTIALS_JSON', reason: 'roles-required' },
        });
      }
      this.credentials.set(tenantId, { token: Buffer.from(token, 'utf8'), roles });
    }
    if (this.credentials.size === 0) {
      throw new BrowserToolError('INVALID_INPUT', 'Invalid tenant authentication configuration.', {
        details: { field: 'TENANT_CREDENTIALS_JSON', reason: 'at-least-one-tenant-required' },
      });
    }
  }

  public static fromEnvironment(env: Readonly<Record<string, string | undefined>> = process.env): TenantAuthenticator | undefined {
    const raw = env.TENANT_CREDENTIALS_JSON?.trim();
    if (!raw) return undefined;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new BrowserToolError('INVALID_INPUT', 'Invalid tenant authentication configuration.', {
        details: { field: 'TENANT_CREDENTIALS_JSON', reason: 'invalid-json' },
      });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new BrowserToolError('INVALID_INPUT', 'Invalid tenant authentication configuration.', {
        details: { field: 'TENANT_CREDENTIALS_JSON', reason: 'object-required' },
      });
    }
    return new TenantAuthenticator(parsed as Record<string, string | TenantCredentialConfig>);
  }

  public authenticate(tenantIdValue: unknown, tokenValue: unknown, role: TenantRole): TenantIdentity {
    if (!isTenantId(tenantIdValue) || typeof tokenValue !== 'string') throw unauthenticated();
    const credential = this.credentials.get(tenantIdValue);
    if (!credential) throw unauthenticated();
    const supplied = Buffer.from(tokenValue, 'utf8');
    if (supplied.length !== credential.token.length || !timingSafeEqual(supplied, credential.token)) {
      throw unauthenticated();
    }
    if (!credential.roles.includes(role)) {
      throw new BrowserToolError('PERMISSION_DENIED', 'The tenant is not authorized for this operation.', {
        details: { role },
        retryable: false,
      });
    }
    return { tenantId: normalizeTenantId(tenantIdValue), roles: credential.roles };
  }

}

function unauthenticated(): BrowserToolError {
  return new BrowserToolError('UNAUTHENTICATED', 'Tenant authentication is required.', {
    retryable: false,
  });
}
