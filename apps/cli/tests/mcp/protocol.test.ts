// `squirrel mcp` serves both MCP protocol eras from one binary: 2026-07-28 (no `initialize`, `server/discover`) and the 2025-era handshake.

import {
  Client,
  StreamableHTTPClientTransport,
  type ClientOptions,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { createMcpServer } from "@/mcp/server";

const cliRoot = join(import.meta.dir, "../..");
const MODERN = "2026-07-28";

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
});

function negotiation(mode: "legacy" | "auto" | "modern"): ClientOptions {
  return {
    versionNegotiation:
      mode === "modern" ? { mode: { pin: MODERN } } : { mode },
  };
}

async function connectStdio(
  script: string[],
  mode: "legacy" | "auto" | "modern"
): Promise<Client> {
  const client = new Client(
    { name: "test", version: "0.0.0" },
    negotiation(mode)
  );
  clients.push(client);
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: script,
      cwd: cliRoot,
      stderr: "ignore",
    })
  );
  return client;
}

describe("squirrel mcp over stdio", () => {
  const entry = ["src/cli.ts", "mcp"];

  test("serves a 2025-era client through `initialize`", async () => {
    const client = await connectStdio(entry, "legacy");
    expect(client.getProtocolEra()).toBe("legacy");
    expect(client.getServerVersion()?.name).toBe("squirrelscan");
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(10);
  }, 30_000);

  test("serves a 2026-07-28 client with no `initialize`", async () => {
    const client = await connectStdio(entry, "modern");
    expect(client.getProtocolEra()).toBe("modern");
    expect(client.getServerVersion()?.name).toBe("squirrelscan");
    expect(client.getServerCapabilities()?.tools).toBeDefined();
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(10);
  }, 30_000);

  test("an auto-negotiating client lands on 2026-07-28", async () => {
    const client = await connectStdio(entry, "auto");
    expect(client.getProtocolEra()).toBe("modern");
  }, 30_000);

  test("both eras list identical tools", async () => {
    const legacy = await connectStdio(entry, "legacy");
    const modern = await connectStdio(entry, "modern");
    const names = async (c: Client) =>
      (await c.listTools()).tools.map((t) => t.name).sort();
    expect(await names(modern)).toEqual(await names(legacy));
  }, 30_000);
});

describe("squirrel mcp over the 2026-07-28 request path (in process)", () => {
  test("a local tool runs without a handshake", async () => {
    const handler = createMcpHandler(() => createMcpServer());
    const client = new Client(
      { name: "test", version: "0.0.0" },
      negotiation("modern")
    );
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
        fetch: (url, init) => handler.fetch(new Request(url, init)),
      })
    );
    expect(client.getProtocolEra()).toBe("modern");
    const result = await client.callTool({
      name: "list_rules",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
  }, 30_000);
});

// The channel (#569) must keep the legacy handshake. A hand-wired v2 `Server` on `StdioServerTransport` is how it can, so pin that behavior here: if an SDK upgrade changes it, this fails before the channel stops registering.
describe("a hand-wired v2 stdio server stays on the legacy handshake", () => {
  const entry = ["tests/mcp/fixtures/legacy-only-server.ts"];

  test("an auto-negotiating client is served the 2025-era handshake", async () => {
    const client = await connectStdio(entry, "auto");
    expect(client.getProtocolEra()).toBe("legacy");
    expect(client.getServerCapabilities()?.experimental).toHaveProperty(
      "claude/channel"
    );
  }, 30_000);

  test("a client that insists on 2026-07-28 is refused", async () => {
    await expect(connectStdio(entry, "modern")).rejects.toThrow(
      /negotiation failed/i
    );
  }, 30_000);
});
