import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { AuditLogger } from "./audit.js";
import { TenantAuthenticator } from "./auth/tenant-auth.js";
import { SessionManager } from "./browser/session-manager.js";
import { loadConfig, type AppConfig } from "./config.js";
import { createMcpServer } from "./mcp/server.js";
import { McpRuntimeGuard } from "./mcp/runtime-guard.js";
import type { SessionManagerLike } from "./mcp/types.js";
import { UrlPolicy } from "./policy/url-policy.js";
import { RestApiServer } from "./api/server.js";

export interface RuntimeHandle {
  manager: SessionManagerLike;
  server: ReturnType<typeof createMcpServer>;
  transport: StdioServerTransport;
  runtimeGuard: McpRuntimeGuard;
  restApiServer?: RestApiServer | undefined;
  shutdown(reason?: string): Promise<void>;
}

export interface StartOptions {
  /** Dependency injection keeps startup and signal handling contract-testable. */
  loadConfig?: () => AppConfig;
  createManager?: (config: AppConfig) => Promise<SessionManagerLike> | SessionManagerLike;
  createTransport?: () => StdioServerTransport;
  tenantAuthenticator?: TenantAuthenticator | undefined;
  audit?: AuditLogger | undefined;
  runtimeGuard?: McpRuntimeGuard | undefined;
  httpPort?: number | undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500);
  return "Unknown startup failure.";
}

async function createDefaultManager(config: AppConfig, audit: AuditLogger): Promise<SessionManagerLike> {
  // SessionManager accepts BrowserSessionOptions, while allowlist/audit paths
  // live in AppConfig. Build those server-owned dependencies here; callers
  // never get a chance to replace them through an MCP request.
  return new SessionManager({
    maxSessions: config.maxSessions,
    ...(config.sessionTtlMs !== undefined ? { sessionTtlMs: config.sessionTtlMs } : {}),
    ...(config.workspaceTtlMs !== undefined ? { workspaceTtlMs: config.workspaceTtlMs } : {}),
    policyProfile: config.automationPolicy,
    persistentProfile: config.persistentProfiles,
    profileRoot: join(config.dataDir, "profiles"),
    artifactsRoot: join(config.dataDir, "artifacts"),
    urlPolicy: new UrlPolicy(config),
    audit,
    defaultTimeoutMs: config.timeoutMs,
    privateNetworkEnabled: config.allowPrivateNetwork,
  });
}

/** Start the MCP server over stdio. No startup text is written to stdout. */
export async function startStdioServer(options: StartOptions = {}): Promise<RuntimeHandle> {
  const config = (options.loadConfig ?? (() => loadConfig()))();
  if (config.allowPrivateNetwork) {
    console.error("[compliant-firefox] WARNING: private-network access is explicitly enabled for this process.");
  }
  if (config.allowHttp) {
    console.error("[compliant-firefox] WARNING: plain HTTP navigation is explicitly enabled for this process.");
  }
  const tenantAuthenticator = options.tenantAuthenticator ?? TenantAuthenticator.fromEnvironment();
  const audit = options.audit ?? new AuditLogger(config.auditPath);
  const runtimeGuard = options.runtimeGuard ?? new McpRuntimeGuard({
    ...(config.mcpRatePerSecond !== undefined ? { ratePerSecond: config.mcpRatePerSecond } : {}),
    ...(config.mcpBurst !== undefined ? { burst: config.mcpBurst } : {}),
  });
  const manager = options.createManager
    ? await options.createManager(config)
    : await createDefaultManager(config, audit);
  const server = createMcpServer(manager, { tenantAuthenticator, audit, runtimeGuard });
  const transport = (options.createTransport ?? (() => new StdioServerTransport()))();
  await server.connect(transport);

  let restApiServer: RestApiServer | undefined;
  const httpPort = options.httpPort ?? (process.env.HTTP_PORT ? parseInt(process.env.HTTP_PORT, 10) : undefined);
  if (httpPort && manager instanceof SessionManager) {
    restApiServer = new RestApiServer(manager, { port: httpPort });
    await restApiServer.start().catch((err) => {
      console.error(`[compliant-firefox] HTTP REST API failed to start on port ${httpPort}: ${errorMessage(err)}`);
    });
  }

  let closed = false;
  let onSigint: (() => void) | undefined;
  let onSigterm: (() => void) | undefined;
  let onUncaught: ((error: Error) => void) | undefined;
  let onRejected: ((reason: unknown) => void) | undefined;
  const shutdown = async (reason = "shutdown"): Promise<void> => {
    if (closed) return;
    closed = true;
    if (onSigint) process.removeListener("SIGINT", onSigint);
    if (onSigterm) process.removeListener("SIGTERM", onSigterm);
    if (onUncaught) process.removeListener("uncaughtException", onUncaught);
    if (onRejected) process.removeListener("unhandledRejection", onRejected);
    if (restApiServer) {
      try {
        await restApiServer.stop();
      } catch (error) {
        console.error(`[${reason}] HTTP REST API stop failed: ${errorMessage(error)}`);
      }
    }
    try {
      await manager.shutdown();
    } catch (error) {
      // Cleanup errors are diagnostic only; they must never be sent over
      // stdout, which is reserved for MCP protocol frames.
      console.error(`[${reason}] browser cleanup failed: ${errorMessage(error)}`);
    }
    try {
      await server.close();
    } catch (error) {
      console.error(`[${reason}] MCP server close failed: ${errorMessage(error)}`);
    }
    try {
      await transport.close();
    } catch (error) {
      console.error(`[${reason}] stdio transport close failed: ${errorMessage(error)}`);
    }
  };

  const processObject = process;
  const onSignal = (signal: string) => {
    void shutdown(signal).finally(() => {
      processObject.exitCode = 0;
    });
  };
  const onFatal = (error: unknown, kind: string) => {
    console.error(`[${kind}] ${errorMessage(error)}`);
    void shutdown(kind).finally(() => {
      processObject.exitCode = 1;
    });
  };

  onSigint = () => onSignal("SIGINT");
  onSigterm = () => onSignal("SIGTERM");
  onUncaught = (error) => onFatal(error, "uncaughtException");
  onRejected = (error) => onFatal(error, "unhandledRejection");
  processObject.once("SIGINT", onSigint);
  processObject.once("SIGTERM", onSigterm);
  processObject.once("uncaughtException", onUncaught);
  processObject.once("unhandledRejection", onRejected);

  return { manager, server, transport, runtimeGuard, restApiServer, shutdown };
}

/** CLI entrypoint. Configuration errors are explicit and produce no protocol noise. */
export async function main(options: StartOptions = {}): Promise<RuntimeHandle | undefined> {
  try {
    return await startStdioServer(options);
  } catch (error) {
    console.error(`[${"compliant-firefox"}] startup failed: ${errorMessage(error)}`);
    process.exitCode = 1;
    return undefined;
  }
}

const entryPath = process.argv[1];
if (entryPath && resolve(fileURLToPath(import.meta.url)) === resolve(entryPath)) {
  void main();
}
