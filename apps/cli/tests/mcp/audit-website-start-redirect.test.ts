// MCP `audit_website` with a start URL that redirects to another site (#1281):
// a cross-domain redirect comes back as confirmation_required naming the
// destination (nothing audited or charged) and is audited only with
// followRedirect: true; a same-site redirect is followed without asking.

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

const scratch = isolateSquirrelHome("squirrel-mcp-start-redirect").root;
const configPath = join(scratch, "squirrel.toml");
let previousConfig: string | undefined;

const hits: string[] = [];
const destination = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const { pathname } = new URL(req.url);
    hits.push(pathname);
    if (pathname === "/") {
      return new Response(
        `<!doctype html><html lang="en"><head><title>Dest</title></head><body><h1>Hi</h1></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } }
      );
    }
    return new Response("not found", { status: 404 });
  },
});
const shortener = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const { pathname } = new URL(req.url);
    // A Location that carries a token in its query.
    const query = pathname === "/t" ? "?token=SECRET#frag" : "";
    return new Response(null, {
      status: 301,
      headers: { location: `${destination.url.origin}/${query}` },
    });
  },
});

beforeAll(() => {
  previousConfig = getGlobalConfigPath();
  setGlobalConfigPath(configPath);
});
beforeEach(() => {
  hits.length = 0;
  writeFileSync(configPath, "");
});
afterAll(() => {
  closeGlobalContentStore();
  closeGlobalLinkCache();
  setGlobalConfigPath(previousConfig);
  void destination.stop(true);
  void shortener.stop(true);
});

async function call(args: Record<string, unknown>): Promise<string> {
  const server = createMcpServer({});
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  const result = await client.callTool({
    name: "audit_website",
    arguments: args,
  });
  return (result.content as Array<{ type: string; text?: string }>)
    .map((c) => c.text ?? "")
    .join("\n");
}

const shortUrl = () => `http://localhost:${shortener.port}/x`;

describe("audit_website start URL redirects", () => {
  test("a cross-domain redirect is confirmation_required with the destination, and nothing is crawled", async () => {
    const text = await call({
      url: shortUrl(),
      offline: true,
      level: "quick",
      maxPages: 2,
    });
    const body = JSON.parse(text) as {
      status: string;
      reason: string;
      originalUrl: string;
      finalUrl: string;
      next: string;
    };
    expect(body.status).toBe("confirmation_required");
    expect(body.reason).toBe("redirect");
    expect(body.originalUrl).toBe(shortUrl());
    expect(body.finalUrl).toBe(`${destination.url.origin}/`);
    expect(body.next).toContain("followRedirect: true");
    // Asked once to resolve the chain; no robots.txt, sitemap or page crawl.
    expect(hits).toEqual(["/"]);
  }, 60_000);

  test("confirm: true alone does not follow it (it approves credit spend)", async () => {
    const text = await call({
      url: shortUrl(),
      offline: true,
      level: "quick",
      maxPages: 2,
      confirm: true,
    });
    expect(JSON.parse(text)).toMatchObject({
      status: "confirmation_required",
      reason: "redirect",
    });
  }, 60_000);

  test("followRedirect: true audits the destination and the report records the chain", async () => {
    const text = await call({
      url: shortUrl(),
      offline: true,
      level: "quick",
      maxPages: 2,
      followRedirect: true,
    });
    expect(text).toContain("<start-redirect");
    expect(text).toContain(`original-url="${shortUrl()}"`);
    expect(text).toContain(`<site url="${destination.url.origin}"`);
  }, 90_000);

  test("[crawler] follow_redirect = true in the config is the same consent", async () => {
    writeFileSync(configPath, "[crawler]\nfollow_redirect = true\n");
    const text = await call({
      url: shortUrl(),
      offline: true,
      level: "quick",
      maxPages: 2,
    });
    expect(text).toContain("<start-redirect");
  }, 90_000);

  test("a token in the redirect's query reaches neither the confirmation nor the report", async () => {
    const url = `http://localhost:${shortener.port}/t`;
    const text = await call({
      url,
      offline: true,
      level: "quick",
      maxPages: 2,
    });
    expect(text).not.toContain("SECRET");
    expect(JSON.parse(text).finalUrl).toBe(`${destination.url.origin}/`);
    const report = await call({
      url,
      offline: true,
      level: "quick",
      maxPages: 2,
      followRedirect: true,
    });
    expect(report).toContain("<start-redirect");
    expect(report).not.toContain("SECRET");
  }, 90_000);
});
