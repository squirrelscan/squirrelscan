// `squirrel mcp` as a stdio front end for the hosted MCP (#737): the front end is tested against a fake hosted server.

import {
  Client,
  InMemoryTransport,
  type ClientOptions,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import type { ResolvedCredential } from "@/self/credentials";

import { SIGNED_OUT_MESSAGE } from "@/mcp/forward";
import { createFrontEnd } from "@/mcp/server";
import { UpstreamHandle, connectUpstream } from "@/mcp/upstream";

const cliRoot = join(import.meta.dir, "../..");
const MODERN = "2026-07-28";

// A stand-in for mcp.squirrelscan.com: tools list without credentials, calls report the Authorization header they arrived with.
function fakeHosted() {
  const extraTools: string[] = [];
  const seenAuth: (string | null)[] = [];
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "hosted", version: "1.0.0" });
    server.registerTool(
      "list_websites",
      { description: "List websites", inputSchema: z.object({}) },
      async () => ({
        content: [{ type: "text", text: JSON.stringify(["example.com"]) }],
      })
    );
    server.registerTool(
      "run_audit",
      {
        description: "Run an audit",
        inputSchema: z.object({
          url: z.string().optional(),
          level: z.string().optional(),
        }),
      },
      async (args) => ({
        content: [{ type: "text", text: `run_audit ${JSON.stringify(args)}` }],
      })
    );
    for (const name of extraTools) {
      server.registerTool(
        name,
        { description: name, inputSchema: z.object({}) },
        async () => ({ content: [{ type: "text", text: name }] })
      );
    }
    return server;
  });
  const fetchImpl = (input: string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    seenAuth.push(request.headers.get("authorization"));
    return handler.fetch(request);
  };
  return { fetch: fetchImpl, extraTools, seenAuth };
}

const login: () => ResolvedCredential = () => ({
  token: "sq_test_token",
  source: "env",
});
const signedOut = () => null;

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
});

// Connect an agent-side client to a front end over an in-memory pipe (the legacy handshake).
async function connectFront(
  hosted: ReturnType<typeof fakeHosted>,
  resolve: () => ResolvedCredential | null
): Promise<Client> {
  const upstream = new UpstreamHandle(() =>
    connectUpstream({
      url: "http://hosted.test/mcp",
      resolveCredential: resolve,
      fetch: hosted.fetch as never,
    })
  );
  const server = await createFrontEnd({ upstream, resolveCredential: resolve });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "agent", version: "0.0.0" });
  clients.push(client);
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

describe("the forwarded tool set", () => {
  test("tools/list is exactly the hosted list", async () => {
    const hosted = fakeHosted();
    const direct = new Client({ name: "direct", version: "0.0.0" });
    clients.push(direct);
    await direct.connect(
      new (
        await import("@modelcontextprotocol/client")
      ).StreamableHTTPClientTransport(new URL("http://hosted.test/mcp"), {
        fetch: hosted.fetch as never,
      })
    );
    const front = await connectFront(hosted, login);
    expect((await front.listTools()).tools).toEqual(
      (await direct.listTools()).tools
    );
  }, 30_000);

  test("a tool added to the hosted server appears with no CLI change", async () => {
    const hosted = fakeHosted();
    const front = await connectFront(hosted, login);
    expect((await front.listTools()).tools.map((t) => t.name)).not.toContain(
      "brand_new_tool"
    );
    hosted.extraTools.push("brand_new_tool");
    expect((await front.listTools()).tools.map((t) => t.name)).toContain(
      "brand_new_tool"
    );
    const result = await front.callTool({
      name: "brand_new_tool",
      arguments: {},
    });
    expect(result.content[0]).toMatchObject({ text: "brand_new_tool" });
  }, 30_000);

  test("a cloud call returns the hosted result and sends the credential", async () => {
    const hosted = fakeHosted();
    const front = await connectFront(hosted, login);
    const result = await front.callTool({
      name: "list_websites",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toMatchObject({
      text: JSON.stringify(["example.com"]),
    });
    expect(hosted.seenAuth).toContain("Bearer sq_test_token");
  }, 30_000);

  test("the old audit_website name is forwarded to run_audit", async () => {
    const front = await connectFront(fakeHosted(), login);
    const result = await front.callTool({
      name: "quick_check",
      arguments: { url: "https://example.com" },
    });
    expect(result.content[0]).toMatchObject({
      text: 'run_audit {"url":"https://example.com","level":"quick"}',
    });
    const offline = await front.callTool({
      name: "audit_website",
      arguments: { url: "https://example.com", offline: true },
    });
    expect(offline.isError).toBe(true);
    expect(JSON.stringify(offline.content)).toContain("squirrel audit");
  }, 30_000);
});

describe("signed out", () => {
  test("the catalog lists and a tool call returns one error naming the fixes", async () => {
    const hosted = fakeHosted();
    const front = await connectFront(hosted, signedOut);
    expect((await front.listTools()).tools.length).toBeGreaterThan(0);
    const result = await front.callTool({
      name: "list_websites",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: SIGNED_OUT_MESSAGE },
    ]);
    expect(SIGNED_OUT_MESSAGE).toContain("squirrel auth login");
    expect(SIGNED_OUT_MESSAGE).toContain("squirrel audit");
    // The call never reached the hosted server, and the listing carried no credential.
    expect(hosted.seenAuth.every((h) => h === null)).toBe(true);
  }, 30_000);
});

describe("an unreachable hosted server", () => {
  test("the front end still starts and reports the failure on the call", async () => {
    const upstream = new UpstreamHandle(async () => {
      throw new Error("offline");
    });
    const server = await createFrontEnd({
      upstream,
      resolveCredential: login,
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "agent", version: "0.0.0" });
    clients.push(client);
    await Promise.all([server.connect(b), client.connect(a)]);
    const result = await client.callTool({ name: "x", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Could not reach");
  }, 30_000);
});

describe("channel mode", () => {
  test("declares claude/channel and keeps the forwarded tools, on the legacy handshake", async () => {
    const hosted = fakeHosted();
    const upstream = new UpstreamHandle(() =>
      connectUpstream({
        url: "http://hosted.test/mcp",
        resolveCredential: login,
        fetch: hosted.fetch as never,
      })
    );
    const server = await createFrontEnd({
      upstream,
      resolveCredential: login,
      channel: {},
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "agent", version: "0.0.0" });
    clients.push(client);
    await Promise.all([server.connect(b), client.connect(a)]);
    expect(client.getServerCapabilities()?.experimental).toHaveProperty(
      "claude/channel"
    );
    expect(client.getServerCapabilities()?.tools).toBeDefined();
    expect(client.getServerCapabilities()?.experimental).not.toHaveProperty(
      "claude/channel/permission"
    );
    expect((await client.listTools()).tools.map((t) => t.name)).toContain(
      "list_websites"
    );
  }, 30_000);
});

describe("squirrel mcp as a process", () => {
  function negotiation(mode: "legacy" | "modern"): ClientOptions {
    return {
      versionNegotiation:
        mode === "modern" ? { mode: { pin: MODERN } } : { mode },
    };
  }

  // Serve the fake hosted MCP on a loopback port and spawn the real CLI at it.
  async function withProcess(
    env: Record<string, string>,
    args: string[],
    mode: "legacy" | "modern",
    body: (client: Client) => Promise<void>
  ) {
    const hosted = fakeHosted();
    const httpServer = Bun.serve({
      port: 0,
      fetch: (request) => hosted.fetch(request as never),
    });
    const home = mkdtempSync(join(tmpdir(), "squirrel-mcp-home-"));
    const client = new Client(
      { name: "agent", version: "0.0.0" },
      negotiation(mode)
    );
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: ["src/cli.ts", ...args],
          cwd: cliRoot,
          stderr: "ignore",
          env: {
            PATH: process.env.PATH ?? "",
            HOME: home,
            SQUIRREL_MCP_SERVER: `http://localhost:${httpServer.port}/mcp`,
            ...env,
          },
        })
      );
      await body(client);
    } finally {
      await client.close().catch(() => {});
      await httpServer.stop(true);
      rmSync(home, { recursive: true, force: true });
    }
  }

  test("serves a 2025-era client the hosted tools", async () => {
    await withProcess(
      { SQUIRRELSCAN_API_KEY: "sq_proc" },
      ["mcp"],
      "legacy",
      async (client) => {
        expect(client.getProtocolEra()).toBe("legacy");
        const names = (await client.listTools()).tools.map((t) => t.name);
        expect(names).toEqual(["list_websites", "run_audit"]);
        const result = await client.callTool({
          name: "list_websites",
          arguments: {},
        });
        expect(result.isError).toBeFalsy();
      }
    );
  }, 60_000);

  test("serves a 2026-07-28 client the hosted tools", async () => {
    await withProcess(
      { SQUIRRELSCAN_API_KEY: "sq_proc" },
      ["mcp"],
      "modern",
      async (client) => {
        expect(client.getProtocolEra()).toBe("modern");
        const names = (await client.listTools()).tools.map((t) => t.name);
        expect(names).toEqual(["list_websites", "run_audit"]);
        const result = await client.callTool({
          name: "list_websites",
          arguments: {},
        });
        expect(result.isError).toBeFalsy();
      }
    );
  }, 60_000);

  test("signed out, the process lists tools and refuses calls", async () => {
    await withProcess({}, ["mcp"], "modern", async (client) => {
      expect((await client.listTools()).tools.length).toBe(2);
      const result = await client.callTool({
        name: "list_websites",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("squirrel auth login");
    });
  }, 60_000);

  test("`squirrel channel` is the channel alias: legacy handshake, channel declared", async () => {
    await withProcess(
      { SQUIRRELSCAN_API_KEY: "sq_proc" },
      ["channel"],
      "legacy",
      async (client) => {
        expect(client.getServerCapabilities()?.experimental).toHaveProperty(
          "claude/channel"
        );
        expect((await client.listTools()).tools.length).toBe(2);
      }
    );
  }, 60_000);
});

describe("docs", () => {
  test("docs/cli/mcp.mdx says the MCP needs a login and free audits use squirrel audit", () => {
    const doc = readFileSync(join(cliRoot, "../../docs/cli/mcp.mdx"), "utf8");
    expect(doc).toContain("Needs a login");
    expect(doc).toContain("squirrel auth login");
    expect(doc).toContain("squirrel audit");
    expect(doc).toContain("--channel");
  });
});
