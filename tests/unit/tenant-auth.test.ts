import { describe, expect, it } from 'vitest';

import { TenantAuthenticator } from '../../src/auth/tenant-auth.js';

describe('跨租户认证', () => {
  it('应当用恒定时间比较校验 token 并返回租户身份', () => {
    const authenticator = new TenantAuthenticator({
      'tenant-a': { token: 'a'.repeat(32), roles: ['read'] },
      'tenant-b': 'b'.repeat(32),
    });

    expect(authenticator.authenticate('tenant-a', 'a'.repeat(32), 'read')).toMatchObject({ tenantId: 'tenant-a' });
    expect(() => authenticator.authenticate('tenant-a', 'a'.repeat(32), 'submit')).toThrowError(
      expect.objectContaining({ code: 'PERMISSION_DENIED' }),
    );
    expect(() => authenticator.authenticate('tenant-a', 'wrong-token-that-is-long-enough-32', 'read')).toThrowError(
      expect.objectContaining({ code: 'UNAUTHENTICATED' }),
    );
  });

  it('应当拒绝无效的环境配置，而不是在运行时抛出 TypeError', () => {
    expect(() => TenantAuthenticator.fromEnvironment({
      TENANT_CREDENTIALS_JSON: JSON.stringify({ 'tenant-a': { token: 'a'.repeat(32), roles: 'read' } }),
    })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });
});
