export type ProxyType = 'http' | 'https' | 'socks4' | 'socks5';

export interface ProxyConfig {
  /** Proxy server address, e.g. http://1.2.3.4:8080 or socks5://1.2.3.4:1080 */
  readonly server: string;
  readonly type?: ProxyType;
  readonly username?: string;
  readonly password?: string;
  /** Domains or addresses to bypass proxy, comma-separated or string array */
  readonly bypass?: string;
}

export interface ProxyCheckResult {
  readonly success: boolean;
  /** True only after a request actually traversed the proxy and returned an egress IP. */
  readonly verified?: boolean;
  readonly checkLevel?: 'none' | 'connectivity' | 'egress';
  readonly server: string;
  readonly proxyType: ProxyType;
  readonly latencyMs?: number;
  readonly outboundIp?: string;
  readonly country?: string;
  readonly probeError?: string;
  readonly error?: string;
}
