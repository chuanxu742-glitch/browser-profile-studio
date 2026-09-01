import { createHash, randomUUID } from 'node:crypto';

import { BrowserToolError } from '../domain.js';
import type { Workspace } from '../domain.js';

export function createWorkspaceId(): string {
  try {
    return `wsp_${randomUUID().replace(/-/g, '')}`;
  } catch {
    return `wsp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}`;
  }
}

export function normalizeWorkspaceName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new BrowserToolError('INVALID_ARGUMENT', { details: { field: 'workspaceName' } });
  }
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 128);
  if (!normalized) {
    throw new BrowserToolError('INVALID_ARGUMENT', { details: { field: 'workspaceName' } });
  }
  return normalized;
}

export function cloneWorkspace(workspace: Workspace): Workspace {
  return { ...workspace };
}

export function digestWorkspaceLease(leaseToken: string): string {
  return createHash('sha256').update(leaseToken).digest('hex');
}
