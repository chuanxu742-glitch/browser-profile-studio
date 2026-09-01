export type ExternalRuntimeKind = 'cloud-browser' | 'android-cloud-phone';

export interface ExternalRuntimeProvider {
  readonly id: string;
  readonly name: string;
  readonly kind: ExternalRuntimeKind;
  readonly configured: boolean;
  health(): Promise<{ available: boolean; message?: string }>;
  create?(options: Record<string, unknown>): Promise<{ runtimeId: string; connectionUrl?: string }>;
  stop?(runtimeId: string): Promise<void>;
}

/** Honest adapter boundary for infrastructure-backed runtimes; no provider is fabricated. */
export class ExternalRuntimeRegistry {
  private readonly providers = new Map<string, ExternalRuntimeProvider>();
  public register(provider: ExternalRuntimeProvider): void { if (this.providers.has(provider.id)) throw new Error('PROVIDER_ALREADY_REGISTERED'); this.providers.set(provider.id, provider); }
  public list(): Array<Pick<ExternalRuntimeProvider, 'id' | 'name' | 'kind' | 'configured'>> { return [...this.providers.values()].map(({ id, name, kind, configured }) => ({ id, name, kind, configured })); }
  public get(id: string): ExternalRuntimeProvider { const value = this.providers.get(id); if (!value) throw new Error('PROVIDER_NOT_FOUND'); return value; }
  public async create(providerId: string, options: Record<string, unknown> = {}): Promise<{ providerId: string; kind: ExternalRuntimeKind; runtimeId: string; connectionUrl?: string }> {
    const provider = this.get(providerId);
    if (!provider.configured) throw new Error('PROVIDER_NOT_CONFIGURED');
    if (!provider.create) throw new Error('PROVIDER_CREATE_UNSUPPORTED');
    const created = await provider.create(options);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(created.runtimeId)) throw new Error('PROVIDER_RUNTIME_ID_INVALID');
    if (created.connectionUrl) assertSafeConnectionUrl(created.connectionUrl);
    return { providerId, kind: provider.kind, runtimeId: created.runtimeId, ...(created.connectionUrl ? { connectionUrl: created.connectionUrl } : {}) };
  }
  public async stop(providerId: string, runtimeId: string): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(runtimeId)) throw new Error('PROVIDER_RUNTIME_ID_INVALID');
    const provider = this.get(providerId);
    if (!provider.configured) throw new Error('PROVIDER_NOT_CONFIGURED');
    if (!provider.stop) throw new Error('PROVIDER_STOP_UNSUPPORTED');
    await provider.stop(runtimeId);
  }
  public async health(): Promise<Array<{ id: string; kind: ExternalRuntimeKind; configured: boolean; available: boolean; message?: string }>> {
    return Promise.all([...this.providers.values()].map(async (provider) => {
      if (!provider.configured) return { id: provider.id, kind: provider.kind, configured: false, available: false, message: 'Provider credentials are not configured' };
      try { return { id: provider.id, kind: provider.kind, configured: true, ...(await provider.health()) }; }
      catch (error) { return { id: provider.id, kind: provider.kind, configured: true, available: false, message: error instanceof Error ? error.message : String(error) }; }
    }));
  }
}

function assertSafeConnectionUrl(value: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('PROVIDER_CONNECTION_URL_INVALID'); }
  if (!['https:', 'wss:'].includes(url.protocol) || url.username || url.password || value.length > 2_048) {
    throw new Error('PROVIDER_CONNECTION_URL_INVALID');
  }
}
