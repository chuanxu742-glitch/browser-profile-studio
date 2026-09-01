export const SERVER_VERSION = '0.1.0';

/**
 * Capabilities deliberately absent from the public browser contract. Keep this
 * registry shared by MCP and manager projections so the advertised policy
 * cannot drift between transports.
 */
export const FORBIDDEN_CAPABILITIES = Object.freeze([
  'raw_evaluate',
  'raw_selector',
  'coordinate_input',
  'arbitrary_download',
  'arbitrary_upload',
  'arbitrary_download_path',
  'credential_export',
  'raw_http_write',
  'raw_cdp',
  'raw_bidi',
  'unmanaged_extension_loading',
  'arbitrary_extension_path',
  'shell',
] as const);

export type ForbiddenCapability = (typeof FORBIDDEN_CAPABILITIES)[number];
