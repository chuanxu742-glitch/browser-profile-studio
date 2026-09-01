import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { atomicWriteFile, readJsonWithBackup } from '../storage/atomic-file.js';

export type TeamRole = 'viewer' | 'operator' | 'manager' | 'owner';
export type ResourceKind = 'profile' | 'proxy' | 'workflow' | 'extension';

export interface TeamWorkspace { readonly workspaceId: string; readonly name: string; readonly createdAt: number; readonly updatedAt: number; }
export interface TeamMember {
  readonly memberId: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly role: TeamRole;
  readonly state: 'active' | 'suspended';
  readonly grants: Partial<Record<ResourceKind, readonly string[]>>;
  readonly createdAt: number;
  readonly updatedAt: number;
}
interface StoredApiKey { readonly keyId: string; readonly memberId: string; readonly tokenHash: string; readonly label: string; readonly createdAt: number; lastUsedAt?: number; revokedAt?: number; }
interface TeamState { workspaces: TeamWorkspace[]; members: TeamMember[]; apiKeys: StoredApiKey[]; }
export interface TeamIdentity { readonly memberId: string; readonly workspaceId: string; readonly role: TeamRole; readonly label: string; readonly grants: TeamMember['grants']; }

export class TeamAccessStore {
  private state: TeamState = { workspaces: [], members: [], apiKeys: [] };
  private loaded = false;
  private writeTail: Promise<void> = Promise.resolve();
  public constructor(private readonly path: string) {}

  public async init(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (existsSync(this.path)) this.state = await readJsonWithBackup<TeamState>(this.path);
  }

  public authenticate(token: string): TeamIdentity | undefined {
    const hash = digestToken(token);
    const key = this.state.apiKeys.find((item) => !item.revokedAt && safeEqual(item.tokenHash, hash));
    if (!key) return undefined;
    const member = this.state.members.find((item) => item.memberId === key.memberId && item.state === 'active');
    if (!member) return undefined;
    key.lastUsedAt = Date.now();
    void this.persist();
    return { memberId: member.memberId, workspaceId: member.workspaceId, role: member.role, label: member.name, grants: cloneGrants(member.grants) };
  }

  public canAccess(identity: TeamIdentity, kind: ResourceKind, resourceId: string): boolean {
    if (identity.role === 'owner') return true;
    const grants = identity.grants[kind];
    return !grants || grants.includes('*') || grants.includes(resourceId);
  }

  public listWorkspaces(): TeamWorkspace[] { return this.state.workspaces.map((item) => ({ ...item })); }
  public listMembers(workspaceId?: string): TeamMember[] { return this.state.members.filter((item) => !workspaceId || item.workspaceId === workspaceId).map(cloneMember); }

  public async createWorkspace(name: string): Promise<TeamWorkspace> {
    const trimmed = name?.trim(); if (!trimmed) throw new Error('WORKSPACE_NAME_REQUIRED');
    const now = Date.now();
    const workspace = { workspaceId: `wsp_${randomUUID().slice(0, 8)}`, name: trimmed, createdAt: now, updatedAt: now };
    this.state.workspaces.push(workspace); await this.persist(); return { ...workspace };
  }

  public async createMember(input: { workspaceId: string; name: string; role: TeamRole; grants?: TeamMember['grants'] }): Promise<TeamMember> {
    if (!this.state.workspaces.some((item) => item.workspaceId === input.workspaceId)) throw new Error('WORKSPACE_NOT_FOUND');
    if (!input.name?.trim()) throw new Error('MEMBER_NAME_REQUIRED');
    if (!['viewer', 'operator', 'manager', 'owner'].includes(input.role)) throw new Error('MEMBER_ROLE_INVALID');
    const now = Date.now();
    const member: TeamMember = { memberId: `mem_${randomUUID().slice(0, 8)}`, workspaceId: input.workspaceId, name: input.name.trim(), role: input.role, state: 'active', grants: normalizeGrants(input.grants), createdAt: now, updatedAt: now };
    this.state.members.push(member); await this.persist(); return cloneMember(member);
  }

  public async updateMember(memberId: string, input: { role?: TeamRole; state?: TeamMember['state']; grants?: TeamMember['grants'] }): Promise<TeamMember> {
    const index = this.state.members.findIndex((item) => item.memberId === memberId); if (index < 0) throw new Error('MEMBER_NOT_FOUND');
    const current = this.state.members[index]!;
    const updated: TeamMember = { ...current, ...(input.role ? { role: input.role } : {}), ...(input.state ? { state: input.state } : {}), ...(input.grants ? { grants: normalizeGrants(input.grants) } : {}), updatedAt: Date.now() };
    this.state.members[index] = updated; await this.persist(); return cloneMember(updated);
  }

  public async issueApiKey(memberId: string, label = 'API key'): Promise<{ keyId: string; token: string; createdAt: number }> {
    if (!this.state.members.some((item) => item.memberId === memberId)) throw new Error('MEMBER_NOT_FOUND');
    const token = `abs_${randomBytes(32).toString('base64url')}`; const createdAt = Date.now(); const keyId = `key_${randomUUID().slice(0, 8)}`;
    this.state.apiKeys.push({ keyId, memberId, tokenHash: digestToken(token), label: label.trim() || 'API key', createdAt });
    await this.persist(); return { keyId, token, createdAt };
  }

  public listApiKeys(memberId?: string): Array<Omit<StoredApiKey, 'tokenHash'>> {
    return this.state.apiKeys.filter((item) => !memberId || item.memberId === memberId).map(({ tokenHash: _hash, ...item }) => ({ ...item }));
  }

  public async revokeApiKey(keyId: string): Promise<boolean> {
    const key = this.state.apiKeys.find((item) => item.keyId === keyId); if (!key || key.revokedAt) return false;
    key.revokedAt = Date.now(); await this.persist(); return true;
  }

  private persist(): Promise<void> {
    const operation = this.writeTail.then(() => atomicWriteFile(this.path, JSON.stringify(this.state, null, 2)));
    this.writeTail = operation.catch(() => undefined); return operation;
  }
}

function digestToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }
function safeEqual(left: string, right: string): boolean { if (left.length !== right.length) return false; let mismatch = 0; for (let i = 0; i < left.length; i += 1) mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i); return mismatch === 0; }
function normalizeGrants(grants?: TeamMember['grants']): TeamMember['grants'] { const result: Partial<Record<ResourceKind, string[]>> = {}; for (const kind of ['profile', 'proxy', 'workflow', 'extension'] as const) if (grants?.[kind]) result[kind] = [...new Set(grants[kind]!.filter((id) => typeof id === 'string' && id.length <= 128))]; return result; }
function cloneGrants(grants: TeamMember['grants']): TeamMember['grants'] { return Object.fromEntries(Object.entries(grants).map(([key, value]) => [key, [...(value ?? [])]])); }
function cloneMember(member: TeamMember): TeamMember { return { ...member, grants: cloneGrants(member.grants) }; }
