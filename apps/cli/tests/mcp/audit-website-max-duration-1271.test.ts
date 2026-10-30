// MCP `audit_website` with maxDuration (#1271): the budget is accepted, bounded, and
// returns a partial report that names the limit.

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { getGlobalConfigPath, setGlobalConfigPath } from "@/config";
import { closeGlobalContentStore } from "@/crawler/storage/content-store";
import { closeGlobalLinkCache } from "@/crawler/storage/link-cache";
import { createMcpServer } from "@/mcp/server";

import { isolateSquirrelHome } from "../helpers/scratch-squirrel-home";

const scratch = isolateSquirrelHome("squirrel-mcp-max-duration").root;
const configPath = join(scratch, "squirrel.toml");
let previousConfig: string | undefined;

const hung: Array<() => void> = [];
const site = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/hang") {
      return new Promise<Response>((resolve) =>
        hung.push(() => resolve(new Response("late")))
      );
    }
    if (pathname !== "/" && !pathname.startsWith("/p/")) {
      return new Response("not found", { status: 404 });
    }
    if (pathname !== "/") await Bun.sleep(700);
    const n = pathname.startsWith("/p/") ? Number(pathname.slice(3)) : 0;
    const links = Array.from(
      { length: 6 },
      (_, i) => `<a href="/p/${n * 6 + i + 1}">p</a>`
    ).join(" ");
    return new Response(
      `<!doctype html><html lang="en"><head><title>P ${n}</title></head><body><h1>P ${n}</h1>${links}<a href="/hang">h</a></body></html>`,
      { headers: { "content-type": "text/html" } }
    );
  },
});

beforeAll(() => {
  previousConfig = getGlobalConfigPath();
  setGlobalConfigPath(configPath);
});
beforeEach(() => writeFileSync(configPath, ""));
afterAll(() => {
  for (const release of hung) release();
  closeGlobalContentStore();
  closeGlobalLinkCache();
  setGlobalConfigPath(previousConfig);
  void site.stop(true);
});

async function client() {
  const server = createMcpServer({});
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    c.connect(clientTransport),
  ]);
  return c;
}

describe("audit_website maxDuration", () => {
  test("is in the tool's input schema", async () => {
    const tools = (await (await client()).listTools()).tools;
    const tool = tools.find((t) => t.name === "audit_website");
    const schema = tool?.inputSchema as
      | { properties?: Record<string, { type?: string }> }
      | undefined;
    const properties = schema?.properties;
    expect(properties?.maxDuration?.type).toBe("number");
  });

  test("a value past 7 days is rejected", async () => {
    const result = await (
      await client()
    ).callTool({
      name: "audit_website",
      arguments: {
        url: `http://127.0.0.1:${site.port}/`,
        offline: true,
        maxDuration: 99_999_999,
      },
    });
    expect(result.isError).toBe(true);
  });

  test("a budget the crawl runs into returns a partial report that names the limit", async () => {
    const result = await (
      await client()
    ).callTool({
      name: "audit_website",
      arguments: {
        url: `http://127.0.0.1:${site.port}/`,
        offline: true,
        level: "quick",
        maxPages: 40,
        maxDuration: 5,
      },
    });
    const text = (result.content as Array<{ text?: string }>)
      .map((c) => c.text ?? "")
      .join("\n");
    expect(text).toContain("--max-duration");
    expect(text).toContain("partial");
  }, 90_000);
});
