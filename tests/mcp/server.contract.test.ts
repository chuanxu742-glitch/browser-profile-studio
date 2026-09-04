import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it, vi } from "vitest";

import { BrowserToolError } from "../../src/domain.js";
import { TenantAuthenticator } from "../../src/auth/tenant-auth.js";
import { createMcpServer, handleToolCall, TOOL_NAMES } from "../../src/mcp/server.js";
import { TOOL_SCHEMAS } from "../../src/mcp/schemas.js";
import type { SessionManagerLike } from "../../src/mcp/types.js";

function stubManager(): SessionManagerLike {
  const result = async (input: Record<string, unknown>) => ({
    sessionId: input.sessionId ?? "ses_stub_1234",
    state: "READY",
    data: { accepted: true },
  });
  return {
    start: vi.fn(result),
    status: vi.fn(result),
    environmentDiagnostics: vi.fn(result),
    stop: vi.fn(result),
    reopenHeaded: vi.fn(result),
    resume: vi.fn(result),
    handoff: vi.fn(result),
    takeover: vi.fn(result),
    open: vi.fn(result),
    snapshot: vi.fn(result),
    screenshot: vi.fn(result),
    click: vi.fn(result),
    type: vi.fn(result),
    select: vi.fn(result),
    scroll: vi.fn(result),
    wait: vi.fn(result),
    workflow: vi.fn(result),
    listWorkspaces: vi.fn(async () => [{ workspaceId: "wsp_test_1234", sessionId: "ses_stub_1234", controlState: "AGENT_CONTROLLED" }]),
    getWorkspace: vi.fn(async (workspaceId: string) => ({ workspaceId, sessionId: "ses_stub_1234", controlState: "AGENT_CONTROLLED" })),
    workspaceHandoff: vi.fn(async (workspaceId: string, reason?: string) => ({ workspaceId, reason, leaseId: "lease_test_1234" })),
    workspaceResume: vi.fn(async (workspaceId: string, leaseId: string, humanConfirmed: boolean) => ({ workspaceId, leaseId, humanConfirmed })),
    listTabs: vi.fn(async (sessionId: string) => [{ tabId: "tab_1", sessionId, active: true }]),
    switchTab: vi.fn(async (sessionId: string, tabId: string) => ({ sessionId, tabId, active: true })),
    closeTab: vi.fn(async (sessionId: string, tabId: string) => ({ sessionId, closedTabId: tabId, tabs: [] })),
    capabilities: vi.fn(async (supportedTools: readonly string[]) => ({ supportedTools, maxTabsPerSession: 5 })),
    extract: vi.fn(result),
    fetch: vi.fn(result),
    submitClusterTask: vi.fn(result),
    submitClusterBatch: vi.fn(result),
    getClusterStatus: vi.fn(async () => ({ totalWorkers: 1, healthyWorkers: 1 })),
    getClusterTask: vi.fn(async (taskId: string) => ({ id: taskId, state: 'COMPLETED' })),
    listClusterTasks: vi.fn(async (filter: Record<string, unknown>, limit?: number, tenantId?: string) => ({ filter, limit, tenantId })),
    shutdown: vi.fn(async () => undefined),
  };
}

async function connectedPair(manager: SessionManagerLike) {
  const server = createMcpServer(manager);
  const client = new Client({ name: "mcp-contract-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

describe("MCP contract", () => {
  it("exposes only the policy-safe browser tool set", async () => {
    const { client, server } = await connectedPair(stubManager());
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
    expect(Object.keys(TOOL_SCHEMAS)).toEqual([...TOOL_NAMES]);
    const diagnosticsSchema = listed.tools.find((tool) => tool.name === "browser_environment_diagnostics")?.inputSchema as {
      properties?: Record<string, unknown>;
    };
    expect(diagnosticsSchema.properties).toHaveProperty("tenantId");
    expect(diagnosticsSchema.properties).toHaveProperty("tenantToken");
    expect(listed.tools.map((tool) => tool.name)).not.toContain("page_evaluate");
    expect(listed.tools.map((tool) => tool.name)).not.toContain("browser_protocol");
    await client.close();
    await server.close();
  });

  it("dispatches token-free environment diagnostics as a tenant-scoped read", async () => {
    const manager = { ...stubManager(), get: vi.fn(() => ({})) } as unknown as SessionManagerLike;
    const result = await handleToolCall(manager, "browser_environment_diagnostics", { sessionId: "ses_stub_1234" });

    expect(result.isError).not.toBe(true);
    expect(manager.environmentDiagnostics).toHaveBeenCalledWith("ses_stub_1234");
  });

  it("advertises strict object schemas and annotations", async () => {
    const { client, server } = await connectedPair(stubManager());
    const listed = await client.listTools();
    for (const tool of listed.tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.annotations).toBeDefined();
      expect(tool.annotations).toHaveProperty("readOnlyHint");
      expect(tool.annotations).toHaveProperty("destructiveHint");
      expect(tool.annotations).toHaveProperty("openWorldHint");
    }
    await client.close();
    await server.close();
  });

  it("publishes page_select as exactly one of value or label", async () => {
    const { client, server } = await connectedPair(stubManager());
    const listed = await client.listTools();
    const select = listed.tools.find((tool) => tool.name === "page_select");
    expect(select).toBeDefined();
    const schema = select?.inputSchema as {
      oneOf?: Array<{ required?: string[]; not?: { required?: string[] } }>;
    };
    expect(schema.oneOf).toHaveLength(2);
    expect(schema.oneOf).toEqual([
      { required: ["value"], not: { required: ["label"] } },
      { required: ["label"], not: { required: ["value"] } },
    ]);
    await client.close();
    await server.close();
  });
  it("advertises tenant and tab safety fields with bounded scroll amounts", async () => {
    const { client, server } = await connectedPair(stubManager());
    const listed = await client.listTools();
    const pageClick = listed.tools.find((tool) => tool.name === "page_click");
    const pageScroll = listed.tools.find((tool) => tool.name === "page_scroll");
    const clickProperties = (pageClick?.inputSchema as { properties?: Record<string, unknown> }).properties;
    const scrollProperties = (pageScroll?.inputSchema as { properties?: Record<string, unknown> }).properties;

    expect(clickProperties).toMatchObject({
      tenantId: { type: "string" },
      tenantToken: { type: "string" },
      expectedTabId: { type: "string" },
    });
    expect(scrollProperties?.amount).toMatchObject({ minimum: 1, maximum: 20 });

    await client.close();
    await server.close();
  });


  it("publishes page_wait as exactly one of milliseconds or condition", async () => {
    const { client, server } = await connectedPair(stubManager());
    const listed = await client.listTools();
    const wait = listed.tools.find((tool) => tool.name === "page_wait");
    const schema = wait?.inputSchema as {
      oneOf?: Array<{ required?: string[]; not?: { required?: string[] } }>;
    };
    expect(schema.oneOf).toEqual([
      { required: ["milliseconds"], not: { required: ["condition"] } },
      { required: ["condition"], not: { required: ["milliseconds"] } },
    ]);
    await client.close();
    await server.close();
  });

  it("returns invalid input as an isError result with stable JSON", async () => {
    const manager = stubManager();
    const { client, server } = await connectedPair(manager);
    const result = await client.callTool({
      name: "page_click",
      arguments: {
        sessionId: "ses_stub_1234",
        selector: "button.submit",
      },
    });
    expect(result.isError).toBe(true);
    const structured = result.structuredContent as { ok: false; error: { code: string } };
    expect(structured.ok).toBe(false);
    expect(structured.error.code).toBe("INVALID_INPUT");
    expect(manager.click).not.toHaveBeenCalled();
    await client.close();
    await server.close();
  });

  it("passes only the parsed high-level input to the manager", async () => {
    const manager = stubManager();
    const { client, server } = await connectedPair(manager);
    await client.callTool({
      name: "page_type",
      arguments: {
        sessionId: "ses_stub_1234",
        target: { role: "textbox", name: "Email" },
        text: "secret@example.invalid",
      },
    });
    expect(manager.type).toHaveBeenCalledWith({
      sessionId: "ses_stub_1234",
      target: { role: "textbox", name: "Email", exact: true },
      text: "secret@example.invalid",
      clear: false,
      submit: false,
      sensitive: false,
    });
    await client.close();
    await server.close();
  });

  it("rejects advanced browser controls and raw selectors at the MCP boundary", async () => {
    const manager = stubManager();
    const advancedStart = await handleToolCall(manager, "browser_start", {
      fingerprint: { userAgent: "ExampleBrowser/1.0" },
    });
    expect(advancedStart.isError).toBe(true);
    expect(manager.start).not.toHaveBeenCalled();

    const rawTarget = await handleToolCall(manager, "page_click", {
      sessionId: "ses_stub_1234",
      target: { selector: "button.submit" },
    });
    expect(rawTarget.isError).toBe(true);
    expect(manager.click).not.toHaveBeenCalled();

    const writeFetch = await handleToolCall(manager, "page_fetch", {
      url: "https://example.com",
      method: "POST",
      body: "should-not-be-accepted",
    });
    expect(writeFetch.isError).toBe(true);
    expect(manager.fetch).not.toHaveBeenCalled();
  });

  it("converts BrowserToolError into stable structured MCP error data", async () => {
    const manager = stubManager();
    manager.status = vi.fn(async () => {
      throw new BrowserToolError("SESSION_PAUSED_CHALLENGE", undefined, {
        details: { url: "https://test.example.invalid/?token=do-not-return", token: "secret" },
      });
    });
    const { client, server } = await connectedPair(manager);
    const result = await client.callTool({
      name: "browser_status",
      arguments: { sessionId: "ses_stub_1234" },
    });
    expect(result.isError).toBe(true);
    const structured = result.structuredContent as {
      ok: false;
      error: { code: string; details: Record<string, unknown> };
    };
    expect(structured.error.code).toBe("SESSION_PAUSED_CHALLENGE");
    expect(JSON.stringify(structured)).not.toContain("do-not-return");
    expect(JSON.stringify(structured)).not.toContain("secret");
    await client.close();
    await server.close();
  });

  it("redacts host paths from details of a known public error", async () => {
    const manager = stubManager();
    manager.status = vi.fn(async () => {
      throw new BrowserToolError("ACTION_TIMEOUT", undefined, {
        details: {
          root: "C:\\private\\profiles",
          reason: "/var/lib/private/profile.lock",
          filename: "C:\\private\\trace.zip",
        },
      });
    });
    const { client, server } = await connectedPair(manager);
    const result = await client.callTool({
      name: "browser_status",
      arguments: { sessionId: "ses_stub_1234" },
    });

    expect(JSON.stringify(result)).not.toContain("private");
    await client.close();
    await server.close();
  });

  it("uses a stable message when a known public error contains a host path", async () => {
    const manager = stubManager();
    manager.status = vi.fn(async () => {
      throw Object.assign(new Error("Timeout at C:\\private\\profiles\\secret.txt"), {
        code: "ACTION_TIMEOUT",
      });
    });
    const { client, server } = await connectedPair(manager);
    const result = await client.callTool({
      name: "browser_status",
      arguments: { sessionId: "ses_stub_1234" },
    });

    const structured = result.structuredContent as {
      ok: false;
      error: { code: string; message: string };
    };
    expect(structured.error.code).toBe("ACTION_TIMEOUT");
    expect(structured.error.message).toBe("The browser action timed out.");
    expect(JSON.stringify(result)).not.toContain("C:\\private\\profiles");
    await client.close();
    await server.close();
  });

  it("uses a fixed safe message for unknown internal errors", async () => {
    const manager = stubManager();
    manager.status = vi.fn(async () => {
      throw Object.assign(new Error("ENOENT C:\\private\\browser-profile\\firefox.exe"), {
        details: { path: "C:\\private\\browser-profile\\firefox.exe", cause: { path: "C:\\private\\cause" } },
      });
    });
    const { client, server } = await connectedPair(manager);
    const result = await client.callTool({
      name: "browser_status",
      arguments: { sessionId: "ses_stub_1234" },
    });
    expect(result.isError).toBe(true);
    const structured = result.structuredContent as {
      ok: false;
      error: { code: string; message: string; details: Record<string, unknown> };
    };
    expect(structured.error.code).toBe("INTERNAL_ERROR");
    expect(structured.error.message).toBe("An internal error occurred.");
    expect(structured.error.details).toEqual({});
    expect(JSON.stringify(result)).not.toContain("C:\\private\\browser-profile");
    await client.close();
    await server.close();
  });

  it("projects screenshots to artifactRef and image without exposing a path", async () => {
    const manager = stubManager();
    manager.screenshot = vi.fn(async () => ({
      ok: true,
      sessionId: "ses_stub_1234",
      state: "READY",
      path: "C:\\private\\artifacts\\screenshot.png",
      artifactRef: "artifact_screenshot_1",
      image: { data: "aGVsbG8=", mimeType: "image/png" },
    }));
    const { client, server } = await connectedPair(manager);
    const result = await client.callTool({
      name: "page_screenshot",
      arguments: { sessionId: "ses_stub_1234" },
    });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as { data: Record<string, unknown> };
    expect(structured.data).toEqual({ artifactRef: "artifact_screenshot_1" });
    expect(JSON.stringify(result)).not.toContain("C:\\private\\artifacts");
    expect(result.content).toContainEqual({ type: "image", data: "aGVsbG8=", mimeType: "image/png" });
    await client.close();
    await server.close();
  });

  it("drops a path-shaped artifactRef and malformed image from a screenshot adapter", async () => {
    const manager = stubManager();
    manager.screenshot = vi.fn(async () => ({
      artifactRef: "C:\\private\\artifact.png",
      image: { data: "not base64", mimeType: "image/svg+xml" },
    }));
    const { client, server } = await connectedPair(manager);
    const result = await client.callTool({
      name: "page_screenshot",
      arguments: { sessionId: "ses_stub_1234" },
    });

    expect((result.structuredContent as { data: Record<string, unknown> }).data).toEqual({});
    expect(result.content).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("C:\\private");
    await client.close();
    await server.close();
  });

  it("adapts the concrete positional SessionManager API", async () => {
    const click = vi.fn(async (sessionId: string, ref: string, options?: Record<string, unknown>) => ({ sessionId, ref, options }));
    const manager = {
      ...stubManager(),
      get: vi.fn(() => ({})),
      click,
    } as unknown as SessionManagerLike;
    const result = await handleToolCall(manager, "page_click", {
      sessionId: "ses_stub_1234",
      target: { ref: "ref_1_opaque" },
    });
    expect(result.isError).not.toBe(true);
    expect(click).toHaveBeenCalledWith("ses_stub_1234", "ref_1_opaque", {});
  });

  it("forwards optional write guards to the concrete SessionManager", async () => {
    const click = vi.fn(async () => ({ state: "READY" }));
    const manager = {
      ...stubManager(),
      get: vi.fn(() => ({})),
      click,
    } as unknown as SessionManagerLike;
    const actionId = "18df71e3-3f07-4ac0-9e20-0ee4f1568ad7";

    const result = await handleToolCall(manager, "page_click", {
      sessionId: "ses_stub_1234",
      target: { ref: "ref_1_opaque" },
      actionId,
      expectedPageRevision: 12,
    });

    expect(result.isError).not.toBe(true);
    expect(click).toHaveBeenCalledWith("ses_stub_1234", "ref_1_opaque", {
      actionId,
      expectedPageRevision: 12,
    });
  });

  it("forwards snapshot v2 format and byte budget", async () => {
    const snapshot = vi.fn(async () => ({ snapshotId: "snp_1", content: "Page" }));
    const manager = {
      ...stubManager(),
      get: vi.fn(() => ({})),
      snapshot,
    } as unknown as SessionManagerLike;

    const result = await handleToolCall(manager, "page_snapshot", {
      sessionId: "ses_stub_1234",
      maxChars: 4_000,
      maxBytes: 8_000,
      format: "compact",
    });

    expect(result.isError).not.toBe(true);
    expect(snapshot).toHaveBeenCalledWith("ses_stub_1234", {
      maxChars: 4_000,
      maxBytes: 8_000,
      format: "compact",
    });
  });

  it("forwards incremental snapshot base ids", async () => {
    const snapshot = vi.fn(async () => ({ snapshotId: "snp_current_1", changes: { changed: true } }));
    const manager = { ...stubManager(), get: vi.fn(() => ({})), snapshot } as unknown as SessionManagerLike;

    const result = await handleToolCall(manager, "page_snapshot", {
      sessionId: "ses_stub_1234",
      sinceSnapshotId: "snp_previous_1",
    });

    expect(result.isError).not.toBe(true);
    expect(snapshot).toHaveBeenCalledWith("ses_stub_1234", {
      maxChars: 12_000,
      maxBytes: 16_000,
      format: "structured",
      sinceSnapshotId: "snp_previous_1",
    });
  });

  it("adapts handoff and takeover to the concrete manager API", async () => {
    const handoff = vi.fn(async () => ({ state: "USER_CONTROLLED", leaseToken: "a".repeat(43) }));
    const takeover = vi.fn(async () => ({ state: "READY" }));
    const manager = {
      ...stubManager(),
      get: vi.fn(() => ({})),
      handoff,
      takeover,
    } as unknown as SessionManagerLike;

    await handleToolCall(manager, "browser_handoff", {
      sessionId: "ses_stub_1234",
      ttlMs: 60_000,
      reason: "operator_review",
    });
    await handleToolCall(manager, "browser_takeover", {
      sessionId: "ses_stub_1234",
      leaseToken: "a".repeat(43),
      humanConfirmed: true,
    });

    expect(handoff).toHaveBeenCalledWith("ses_stub_1234", { ttlMs: 60_000, reason: "operator_review" });
    expect(takeover).toHaveBeenCalledWith("ses_stub_1234", "a".repeat(43), true);
  });

  it("forwards only bounded declarative workflow fields", async () => {
    const workflow = vi.fn(async () => ({ ok: true, status: "completed", steps: [] }));
    const manager = { ...stubManager(), get: vi.fn(() => ({})), workflow } as unknown as SessionManagerLike;
    const actionId = "28df71e3-3f07-4ac0-9e20-0ee4f1568ad7";

    const result = await handleToolCall(manager, "page_workflow", {
      sessionId: "ses_stub_1234",
      steps: [{ op: "snapshot" }],
      timeoutMs: 5_000,
      maxResultBytes: 8_000,
      actionId,
      expectedPageRevision: 3,
    });

    expect(result.isError).not.toBe(true);
    expect(workflow).toHaveBeenCalledWith("ses_stub_1234", {
      steps: [{ op: "snapshot", maxChars: 12_000, maxBytes: 16_000, format: "compact" }],
      maxDurationMs: 5_000,
      maxResultBytes: 8_000,
    }, {
      actionId,
      expectedPageRevision: 3,
      maxDurationMs: 5_000,
      maxResultBytes: 8_000,
    });
  });

  it("rejects executable workflow primitives at the MCP boundary", async () => {
    const manager = stubManager();
    const result = await handleToolCall(manager, "page_workflow", {
      sessionId: "ses_stub_1234",
      steps: [{ op: "evaluate", script: "document.cookie" }],
    });
    expect(result.isError).toBe(true);
    expect(manager.workflow).not.toHaveBeenCalled();
  });

  it("preserves label selection mode for the concrete SessionManager", async () => {
    const select = vi.fn(async () => ({ state: "READY" }));
    const manager = {
      ...stubManager(),
      get: vi.fn(() => ({})),
      snapshot: vi.fn(async () => ({ targets: [{ ref: "ref_choice", role: "combobox", name: "Choice" }] })),
      select,
    } as unknown as SessionManagerLike;
    const result = await handleToolCall(manager, "page_select", {
      sessionId: "ses_stub_1234",
      target: { role: "combobox", name: "Choice" },
      label: "Visible option",
    });

    expect(result.isError).not.toBe(true);
    expect(select).toHaveBeenCalledWith("ses_stub_1234", "ref_choice", { label: "Visible option" }, {});
  });

  it("does not serialize a concrete BrowserSession instance from start", async () => {
    const status = vi.fn(async (sessionId: string) => ({ sessionId, state: "READY", pageGeneration: 0 }));
    const manager = {
      ...stubManager(),
      get: vi.fn(() => ({})),
      start: vi.fn(async () => ({
        sessionId: "ses_started_1234",
        state: "READY",
        profileDirectory: "C:\\private\\profile",
        registry: { records: { password: "must-not-leak" } },
      })),
      status,
    } as unknown as SessionManagerLike;
    const result = await handleToolCall(manager, "browser_start", {});
    expect(result.isError).not.toBe(true);
    expect(status).toHaveBeenCalledWith("ses_started_1234");
    expect(JSON.stringify(result.structuredContent)).not.toContain("private");
    expect(JSON.stringify(result.structuredContent)).not.toContain("must-not-leak");
  });

  it("resolves a semantic target through a bounded snapshot for the concrete manager", async () => {
    const click = vi.fn(async (sessionId: string, ref: string) => ({ sessionId, ref }));
    const manager = {
      ...stubManager(),
      get: vi.fn(() => ({})),
      snapshot: vi.fn(async () => ({ targets: [{ ref: "ref_save", role: "button", name: "Save" }] })),
      click,
    } as unknown as SessionManagerLike;
    const result = await handleToolCall(manager, "page_click", {
      sessionId: "ses_stub_1234",
      target: { role: "button", name: "Save" },
    });
    expect(result.isError).not.toBe(true);
    expect(manager.snapshot).toHaveBeenCalledWith("ses_stub_1234", { maxChars: 0, includeText: false });
    expect(click).toHaveBeenCalledWith("ses_stub_1234", "ref_save", {});
  });

  it("authenticates cluster tenants and strips credentials before dispatch", async () => {
    const token = "tenant-a-secret-token-32-characters";
    const manager = stubManager();
    const authenticator = new TenantAuthenticator({ "tenant-a": token });

    const result = await handleToolCall(manager, "cluster_submit_task", {
      url: "https://example.com/tenant-a",
      tenantId: "tenant-a",
      tenantToken: token,
    }, { tenantAuthenticator: authenticator });

    expect(result.isError).not.toBe(true);
    expect(manager.submitClusterTask).toHaveBeenCalledWith({
      url: "https://example.com/tenant-a",
      mode: "fetch",
      priority: "NORMAL",
      maxRetries: 3,
      timeoutMs: 30_000,
      tenantId: "tenant-a",
    });
    const submitCalls = (manager.submitClusterTask as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(JSON.stringify(submitCalls[0])).not.toContain("tenant-a-secret-token");
  });

  it("lists cluster tasks with project/run filters without forwarding credentials", async () => {
    const token = "tenant-a-secret-token-32-characters";
    const manager = {
      ...stubManager(),
      get: vi.fn(() => ({})),
    } as unknown as SessionManagerLike;
    const authenticator = new TenantAuthenticator({ "tenant-a": token });

    const result = await handleToolCall(manager, "cluster_list_tasks", {
      projectId: "catalog",
      runId: "run-7",
      state: "RUNNING",
      limit: 25,
      tenantId: "tenant-a",
      tenantToken: token,
    }, { tenantAuthenticator: authenticator });

    expect(result.isError).not.toBe(true);
    expect(manager.listClusterTasks).toHaveBeenCalledWith({
      projectId: "catalog",
      runId: "run-7",
      state: "RUNNING",
    }, 25, "tenant-a");
    const calls = (manager.listClusterTasks as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(JSON.stringify(calls[0])).not.toContain(token);
  });

  it("rejects invalid cluster credentials before the manager is called", async () => {
    const manager = stubManager();
    const authenticator = new TenantAuthenticator({ "tenant-a": "tenant-a-secret-token-32-characters" });

    const result = await handleToolCall(manager, "cluster_status", {
      tenantId: "tenant-a",
      tenantToken: "wrong-token-that-is-long-enough-32",
    }, { tenantAuthenticator: authenticator });

    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error: { code: string } }).error.code).toBe("UNAUTHENTICATED");
    expect(manager.getClusterStatus).not.toHaveBeenCalled();
  });

  it("passes the authenticated tenant separately to the concrete manager API", async () => {
    const token = "tenant-a-secret-token-32-characters";
    const submit = vi.fn(async (definition: Record<string, unknown>, tenantId?: string) => ({ definition, tenantId }));
    const manager = {
      ...stubManager(),
      get: vi.fn(() => ({})),
      submitClusterTask: submit,
    } as unknown as SessionManagerLike;
    const authenticator = new TenantAuthenticator({ "tenant-a": token });

    const result = await handleToolCall(manager, "cluster_submit_task", {
      url: "https://example.com/concrete-tenant-a",
      tenantId: "tenant-a",
      tenantToken: token,
    }, { tenantAuthenticator: authenticator });

    expect(result.isError).not.toBe(true);
    expect(submit).toHaveBeenCalledWith({
      url: "https://example.com/concrete-tenant-a",
      mode: "fetch",
      priority: "NORMAL",
      maxRetries: 3,
      timeoutMs: 30_000,
    }, "tenant-a");
  });
  it("authenticates browser tenants and never forwards tenant credentials", async () => {
    const token = "tenant-a-secret-token-32-characters";
    const snapshot = vi.fn(async () => ({ targets: [{ ref: "ref_save", role: "button", name: "Save" }] }));
    const click = vi.fn(async (...args: unknown[]) => ({ ok: true, args }));
    const manager = {
      ...stubManager(),
      get: vi.fn(() => ({})),
      snapshot,
      click,
    } as unknown as SessionManagerLike;
    const authenticator = new TenantAuthenticator({ "tenant-a": token });

    const result = await handleToolCall(manager, "page_click", {
      sessionId: "ses_stub_1234",
      target: { role: "button", name: "Save" },
      tenantId: "tenant-a",
      tenantToken: token,
    }, { tenantAuthenticator: authenticator });

    expect(result.isError).not.toBe(true);
    expect(snapshot).toHaveBeenCalledWith(
      "ses_stub_1234",
      { maxChars: 0, includeText: false },
      "tenant-a",
    );
    expect(click).toHaveBeenCalledWith(
      "ses_stub_1234",
      "ref_save",
      {},
      "tenant-a",
    );
    const calls = (click as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(JSON.stringify(calls)).not.toContain(token);
  });
  it("rejects invalid browser tenant credentials before dispatch", async () => {
    const manager = stubManager();
    const listTabs = manager.listTabs;
    const authenticator = new TenantAuthenticator({ "tenant-a": "tenant-a-secret-token-32-characters" });

    const result = await handleToolCall(manager, "page_list_tabs", {
      sessionId: "ses_stub_1234",
      tenantId: "tenant-a",
      tenantToken: "wrong-tenant-token-that-is-long-enough-32",
    }, { tenantAuthenticator: authenticator });

    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error: { code: string } }).error.code).toBe("UNAUTHENTICATED");
    expect(listTabs).not.toHaveBeenCalled();
  });


  it("dispatches workspace and tab controls through the concrete manager API", async () => {
    const manager = { ...stubManager(), get: vi.fn(() => ({})) } as unknown as SessionManagerLike;

    await handleToolCall(manager, "workspace_list", {});
    await handleToolCall(manager, "workspace_get", { workspaceId: "wsp_test_1234" });
    await handleToolCall(manager, "workspace_handoff", { workspaceId: "wsp_test_1234", reason: "operator review" });
    await handleToolCall(manager, "workspace_resume", {
      workspaceId: "wsp_test_1234",
      leaseId: "l".repeat(32),
      humanConfirmed: true,
    });
    await handleToolCall(manager, "page_list_tabs", { sessionId: "ses_stub_1234" });
    await handleToolCall(manager, "page_switch_tab", { sessionId: "ses_stub_1234", tabId: "tab_2" });
    await handleToolCall(manager, "page_close_tab", { sessionId: "ses_stub_1234", tabId: "tab_2" });

    expect(manager.listWorkspaces).toHaveBeenCalledWith();
    expect(manager.getWorkspace).toHaveBeenCalledWith("wsp_test_1234");
    expect(manager.workspaceHandoff).toHaveBeenCalledWith("wsp_test_1234", "operator review");
    expect(manager.workspaceResume).toHaveBeenCalledWith("wsp_test_1234", "l".repeat(32), true);
    expect(manager.listTabs).toHaveBeenCalledWith("ses_stub_1234");
    expect(manager.switchTab).toHaveBeenCalledWith("ses_stub_1234", "tab_2");
    expect(manager.closeTab).toHaveBeenCalledWith("ses_stub_1234", "tab_2");
  });

  it("forwards the bounded execute workflow contract and advertises capabilities", async () => {
    const workflow = vi.fn(async () => ({ ok: true, status: "completed", steps: [] }));
    const capabilities = vi.fn(async (tools: readonly string[]) => ({ supportedTools: tools, maxTabsPerSession: 5 }));
    const manager = { ...stubManager(), get: vi.fn(() => ({})), workflow, capabilities } as unknown as SessionManagerLike;

    const workflowResult = await handleToolCall(manager, "page_workflow_execute", {
      sessionId: "ses_stub_1234",
      steps: [{ op: "snapshot", maxBytes: 1_000, compact: true }],
      stopOn: ["challenge"],
    });
    const capabilitiesResult = await handleToolCall(manager, "browser_capabilities", {});

    expect(workflowResult.isError).not.toBe(true);
    expect(workflow).toHaveBeenCalledWith("ses_stub_1234", {
      steps: [{ op: "snapshot", maxBytes: 1_000, compact: true }],
      stopOn: ["challenge"],
    }, {});
    expect(capabilitiesResult.isError).not.toBe(true);
    expect(capabilities).toHaveBeenCalledWith(TOOL_NAMES);
  });

  it("rejects execute workflows over the hard step ceiling before manager dispatch", async () => {
    const manager = stubManager();
    const result = await handleToolCall(manager, "page_workflow_execute", {
      sessionId: "ses_stub_1234",
      steps: Array.from({ length: 101 }, () => ({ op: "snapshot" })),
    });

    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error: { code: string } }).error.code).toBe("WORKFLOW_STEP_LIMIT_EXCEEDED");
    expect(manager.workflow).not.toHaveBeenCalled();
  });
});
