// The local MCP `audit_website` tool bills a signed-in audit like `squirrel
// audit` (#628): it registers the run before the crawl, renders the pages that
// need JavaScript in the cloud browser, and closes the run out with its audited
// pages. Signed out, offline and `quick_check` stay local with no cloud call.
// Driven through a real MCP client over an in-memory transport, against a
// stubbed API. No `mock.module` (process-wide in Bun).

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { getGlobalConfigPath, setGlobalConfigPath } from "@/config";
import { loadConfig } from "@/config";
import { closeGlobalContentStore } from "@/crawler/storage/content-store";
import { closeGlobalLinkCache } from "@/crawler/storage/link-cache";
import {
  cancelActiveMcpRuns,
  planMcpAudit,
  resetBilledRunsForTests,
} from "@/mcp/billed-audit";
import { createMcpServer } from "@/mcp/server";
import { levelRunOptions } from "@/mcp/tools/audit-tools";

import { isolateSquirrelHome } from "../helpers/scratch-squirrel-home";

// #626: every squirrel path under one scratch dir, removed afterwards.
const scratch = isolateSquirrelHome("squirrel-mcp-billing").root;
const configPath = join(scratch, "squirrel.toml");
const restores: (() => void)[] = [];

beforeAll(() => {
  const previousConfig = getGlobalConfigPath();
  setGlobalConfigPath(configPath);
  restores.push(() => setGlobalConfigPath(previousConfig));
});

afterAll(() => {
  closeGlobalContentStore();
  closeGlobalLinkCache();
  for (const restore of restores) restore();
});

/** A client-rendered shell: the hybrid fetcher sends it to the cloud browser. */
const CSR_SHELL =
  '<html><head><title>t</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
let requested: string[] = [];
/** Request bodies by "METHOD path", for the run lifecycle and render calls. */
let bodies: { key: string; body: Record<string, unknown> }[] = [];
let balanceTotal = 5000;
let registerStatus = 201;
/** When set, the balance read waits for it. */
let balanceGate: Promise<void> | null = null;
/**
 * The id the stub hands the next registered run. Unique across the file, as
 * real run ids are: the tool tracks runs by id for the life of the server.
 */
let runCount = 0;
let runId = "";
/** What the audited site's home page answers with. */
let siteStatus = 200;
/** When set, the register answer and the home page wait for it. */
let registerGate: Promise<void> | null = null;
let siteGate: Promise<void> | null = null;
/** Home page requests so far: the first is the start URL's redirect resolution (#1281), the audit's follow. */
let homeRequests = 0;

beforeEach(() => {
  requested = [];
  bodies = [];
  balanceTotal = 5000;
  registerStatus = 201;
  siteStatus = 200;
  registerGate = null;
  siteGate = null;
  homeRequests = 0;
  balanceGate = null;
  resetBilledRunsForTests();
  process.env.SQUIRREL_API_SERVER = "http://127.0.0.1:9";
  process.env.SQUIRREL_API_TOKEN = "sqcli_test_token";
  delete process.env.SQUIRRELSCAN_API_KEY;
  process.env.SQUIRREL_DISABLE_TELEMETRY = "1";
  // The site is a stubbed fetch keyed by name: send its hosts by name
  // rather than resolving and pinning them (repo#3430).
  process.env.SQUIRREL_NO_HOST_PINNING = "1";
  process.env.SQUIRREL_NO_UPDATE = "1";
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const url = input.toString();
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    requested.push(`${method} ${url}`);
    if (url.includes("/v1/") && typeof init?.body === "string") {
      bodies.push({
        key: `${method} ${new URL(url).pathname}`,
        body: JSON.parse(init.body),
      });
    }
    if (url.includes("/v1/credits")) {
      if (balanceGate) await balanceGate;
      return Response.json({
        balance: {
          total: balanceTotal,
          monthly: balanceTotal,
          pack: 0,
          periodEnd: null,
        },
        plan: { id: "pro", monthlyCredits: 5000 },
        branding: null,
      });
    }
    if (url.endsWith("/v1/agent-runs/register")) {
      if (registerGate) await registerGate;
      if (registerStatus === 402) {
        return Response.json(
          {
            error: {
              code: "INSUFFICIENT_CREDITS",
              message: "Not enough credits",
              required: 52,
              balance: { total: 0 },
            },
          },
          { status: 402 }
        );
      }
      runCount += 1;
      runId = `RUN${runCount}`;
      return Response.json(
        {
          runId,
          auditId: "AUD1",
          websiteId: "WEB1",
          baseCharged: 50,
        },
        { status: 201 }
      );
    }
    if (url.includes("/v1/agent-runs/")) return Response.json({});
    // The render is recorded above; refusing it sends the page back to plain
    // HTTP at once instead of polling a job that never finishes.
    if (url.includes("/v1/services/")) {
      return Response.json({ error: "unavailable" }, { status: 503 });
    }
    if (url.includes("/v1/")) return Response.json({});
    if (new URL(url).pathname === "/") {
      // The gate holds the audit's own request, not the redirect resolution before it.
      if (siteGate && ++homeRequests > 1) await siteGate;
      return new Response(siteStatus === 200 ? CSR_SHELL : "forbidden", {
        status: siteStatus,
        headers: { "Content-Type": "text/html" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
  closeGlobalContentStore();
  closeGlobalLinkCache();
});

async function connect(): Promise<Client> {
  const server = createMcpServer();
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

async function call(
  name: string,
  args: Record<string, unknown>,
  config = "[cloud]\npublish = false\n"
): Promise<{ text: string; isError: boolean }> {
  writeFileSync(configPath, config);
  const client = await connect();
  const result = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text?: string }[];
    isError?: boolean;
  };
  return {
    text: result.content.map((c) => c.text ?? "").join("\n"),
    isError: result.isError === true,
  };
}

const SECRET = "x".repeat(3) + "pw";
const registered = () =>
  requested.some(
    (r) => r.startsWith("POST ") && r.endsWith("/v1/agent-runs/register")
  );
const cloudRequests = () => requested.filter((r) => r.includes("/v1/"));

// A URL the audit cannot start on is refused at the entry: no balance read, no
// register call (so no base debit), and the URL is not echoed back.
const REFUSED = [
  "ftp://example.com/",
  "file:///etc/passwd",
  "javascript:alert(1)",
  "data:text/html,hi",
  "ht!tp://example.com/",
  "https://",
  "://example.com",
  "x://",
  "gopher://secret-internal.local/x",
  "",
  "   ",
];

describe("an unauditable start URL never reaches the cloud", () => {
  for (const url of REFUSED) {
    test(JSON.stringify(url), async () => {
      const out = await call("audit_website", {
        url,
        maxPages: 1,
        confirm: true,
      });
      expect(out.isError).toBe(true);
      expect(out.text).toContain("invalid_url");
      expect(out.text).not.toContain("secret-internal");
      expect(out.text).not.toContain("passwd");
      expect(registered()).toBe(false);
      expect(cloudRequests()).toEqual([]);
    });
  }
});

describe("an auditable but odd start URL is registered normalised", () => {
  test("upper-case scheme and padding", async () => {
    await call("audit_website", {
      url: "  HTTP://example.com/  ",
      maxPages: 1,
      confirm: true,
    });
    const reg = bodies.find((b) => b.key === "POST /v1/agent-runs/register");
    expect(reg?.body.url).toBe("http://example.com/");
  });

  test("credentials in the URL are not sent to register", async () => {
    await call("audit_website", {
      url: `https://${["user", SECRET].join(":")}@example.com/`,
      maxPages: 1,
      confirm: true,
    });
    const reg = bodies.find((b) => b.key === "POST /v1/agent-runs/register");
    expect(reg?.body.url).toBe("https://example.com/");
    expect(JSON.stringify(reg)).not.toContain(SECRET);
  });
});
