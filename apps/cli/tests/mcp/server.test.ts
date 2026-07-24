// Integration tests for the local stdio MCP server (#112) over an in-memory transport.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, test } from "bun:test";

import { TOOL_AUTH } from "@/mcp/scopes";
import { createMcpServer, type McpServerOptions } from "@/mcp/server";

// Wire a Client to a freshly-built server over a linked in-memory pair.
async function connect(options: McpServerOptions = {}): Promise<Client> {
  const server = createMcpServer(options);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

const EXPECTED_TOOLS = [
  "audit_website",
  "quick_check",
  "get_report",
  "list_audits",
  "list_issues",
  "get_issue",
  "comment_on_issue",
  "list_rules",
  "get_rule",
] as const;

function textOf(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

describe("createMcpServer tool registration", () => {
  let client: Client;

  beforeEach(async () => {
    client = await connect();
  });

  test("exposes exactly the v1 tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOLS].sort());
  });

  test("every tool has a description", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.description && tool.description.length > 0).toBe(true);
    }
  });

  test("cloud tool descriptions advertise their scope/credential requirement", async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.description ?? ""]));
    for (const [name, auth] of Object.entries(TOOL_AUTH)) {
      const description = byName.get(name) ?? "";
      if (auth.apiKey) {
        expect(description).toContain(auth.scope);
      } else {
        expect(description).toContain("user session");
      }
    }
  });

  // Catches a new cloud tool registered without a TOOL_AUTH entry (its description would lack an auth note).
  test("every non-local tool advertises an auth requirement", async () => {
    const local = new Set([
      "audit_website",
      "quick_check",
      "list_rules",
      "get_rule",
    ]);
    const { tools } = await client.listTools();
    for (const tool of tools) {
      if (local.has(tool.name)) continue;
      expect(tool.description ?? "").toMatch(/scope|session/i);
    }
  });
});

describe("local rule tools (deterministic, no auth)", () => {
  let client: Client;

  beforeEach(async () => {
    client = await connect();
  });

  test("list_rules returns a non-empty registry", async () => {
    const result = await client.callTool({ name: "list_rules", arguments: {} });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(textOf(result as never)) as {
      count: number;
      rules: Array<{ id: string }>;
    };
    expect(parsed.count).toBeGreaterThan(0);
    expect(parsed.rules.length).toBe(parsed.count);
    expect(parsed.rules[0]?.id).toBeTruthy();
  });

  test("get_rule returns a known rule and errors on an unknown id", async () => {
    const { rules } = JSON.parse(
      textOf(
        (await client.callTool({ name: "list_rules", arguments: {} })) as never
      )
    ) as { rules: Array<{ id: string }> };
    const knownId = rules[0]!.id;

    const ok = await client.callTool({
      name: "get_rule",
      arguments: { id: knownId },
    });
    expect(ok.isError).toBeFalsy();
    expect(textOf(ok as never)).toContain(knownId);

    const bad = await client.callTool({
      name: "get_rule",
      arguments: { id: "core/does-not-exist" },
    });
    expect(bad.isError).toBe(true);
    expect(textOf(bad as never)).toContain("Unknown rule id");
  });
});

describe("cloud tools auth-gating (logged out)", () => {
  let client: Client;

  beforeEach(async () => {
    // Inject a logged-out resolver so the gate is deterministic regardless of dev state.
    client = await connect({ resolveLogin: () => null });
  });

  // Every cloud tool requires login today (incl. get_report); #113 will let an org API key reach get_report — revisit then.
  test.each(Object.keys(TOOL_AUTH))(
    "%s errors cleanly when not logged in",
    async (name) => {
      const argsByTool: Record<string, Record<string, unknown>> = {
        list_audits: {},
        get_report: { auditId: "abc" },
        list_issues: { websiteId: "w1" },
        get_issue: { websiteId: "w1", number: 1 },
        comment_on_issue: { websiteId: "w1", number: 1, body: "hi" },
      };
      const args = argsByTool[name] ?? {};

      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(textOf(result as never)).toContain("Not authenticated");
    }
  );
});
