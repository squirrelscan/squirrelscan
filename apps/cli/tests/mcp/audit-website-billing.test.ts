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
    // A link shortener on another registrable domain (#1281).
    if (new URL(url).hostname === "shortlink.com") {
      return new Response(null, {
        status: 301,
        headers: { location: "https://destsite.com/" },
      });
    }
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

const AUDIT = { url: "https://example.com/", maxPages: 1 };

const registered = () =>
  requested.some(
    (r) => r.startsWith("POST ") && r.endsWith("/v1/agent-runs/register")
  );
/** The submits of pages the crawl sent to the cloud browser (they carry timeoutMs). */
const pageRenders = () =>
  bodies.filter(
    (b) => b.key === "POST /v1/services/render" && "timeoutMs" in b.body
  );
const pageRendered = () => pageRenders().length > 0;
/** Every request to the cloud API, other than the CLI's own trace upload. */
const cloudCalls = () =>
  requested.filter((r) => r.includes("/v1/") && !r.includes("/v1/traces"));
/** Resolves once `ready` holds, polling; fails the test after 5s. */
async function waitFor(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A gate and the function that opens it. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

/** Every terminal PATCH the current run received. */
const terminalPatches = () =>
  bodies
    .filter((b) => b.key === `PATCH /v1/agent-runs/${runId}`)
    .map((b) => b.body)
    .filter((b) => b.status !== "running");

const finalized = () =>
  bodies.find(
    (b) =>
      b.key === `PATCH /v1/agent-runs/${runId}` &&
      (b.body.status === "completed" || b.body.status === "failed")
  )?.body;

describe("a start URL that redirects to another site is estimated, registered and billed as the destination (#1281)", () => {
  const SHORT = { url: "https://shortlink.com/x", maxPages: 1, level: "quick" };
  const registerBody = () =>
    bodies.find((b) => b.key === "POST /v1/agent-runs/register")?.body;

  test("a cross-domain redirect asks for consent before any estimate, registration or charge", async () => {
    const out = await call("audit_website", { ...SHORT, confirm: true });
    const body = JSON.parse(out.text);
    expect(body).toMatchObject({
      status: "confirmation_required",
      reason: "redirect",
      finalUrl: "https://destsite.com/",
    });
    expect(body.estimate).toBeUndefined();
    expect(registered()).toBe(false);
    expect(cloudCalls()).toEqual([]);
  });

  test("with consent the estimate is made for the destination and nothing names the shortener", async () => {
    const out = await call("audit_website", { ...SHORT, followRedirect: true });
    const body = JSON.parse(out.text);
    expect(body.status).toBe("confirmation_required");
    expect(body.estimate).toMatchObject({ credits: 52, pages: 1 });
    expect(registered()).toBe(false);
    expect(JSON.stringify(body)).not.toContain("shortlink.com");
  });

  test("the registered run, and the pages rendered for it, are the destination's", async () => {
    const out = await call("audit_website", {
      ...SHORT,
      followRedirect: true,
      confirm: true,
    });
    expect(out.isError).toBe(false);
    expect(registered()).toBe(true);
    const register = JSON.stringify(registerBody());
    expect(register).toContain("destsite.com");
    expect(register).not.toContain("shortlink.com");
    expect(finalized()).toMatchObject({ status: "completed", pagesAudited: 1 });
    // The shortener's own page is never fetched as a page of the audit.
    expect(requested.filter((r) => r.includes("shortlink.com"))).toHaveLength(
      1
    );
  });
});

describe("signed in, audit_website is a billed cloud audit", () => {
  test("without confirm it returns the estimate and registers nothing", async () => {
    const out = await call("audit_website", { ...AUDIT, level: "quick" });
    expect(out.isError).toBe(false);
    const body = JSON.parse(out.text);
    expect(body.status).toBe("confirmation_required");
    expect(body.estimate).toEqual({
      credits: 52,
      pages: 1,
      baseCredits: 50,
      creditsPerPage: 2,
    });
    expect(body.balance).toBe(5000);
    expect(registered()).toBe(false);
    expect(pageRendered()).toBe(false);
  });

  test("quick with confirm registers, renders in the cloud and settles its pages", async () => {
    const out = await call("audit_website", {
      ...AUDIT,
      level: "quick",
      confirm: true,
    });
    expect(out.isError).toBe(false);
    expect(registered()).toBe(true);
    expect(pageRendered()).toBe(true);
    // Tagged with the run, so the server bills the page once as part of the
    // audit, never as a standalone render on top of the page charge.
    for (const render of pageRenders()) expect(render.body.runId).toBe(runId);
    expect(finalized()).toMatchObject({ status: "completed", pagesAudited: 1 });
    expect(out.text).toContain(
      `Billed cloud audit, run ${runId}: 1 audited page, about 52 credits`
    );
  });

  test("#801: a surface estimate reserves one external link per page and names its price", async () => {
    const out = await call("audit_website", { ...AUDIT, level: "surface" });
    const body = JSON.parse(out.text);
    expect(body.status).toBe("confirmation_required");
    // 50 base + 3 per page (2 for the page, up to 1 for its external link).
    expect(body.estimate.credits).toBe(50 + body.estimate.pages * 3);
    expect(body.estimate.creditsPerExternalLink).toBe(1);
    expect(body.next).toContain(
      "1 per external link the cloud verifies, at most 1 per page"
    );
    expect(registered()).toBe(false);
  });

  test("#801: quick with externalLinks checks its links on this machine, so it quotes none", async () => {
    const out = await call("audit_website", {
      ...AUDIT,
      level: "quick",
      externalLinks: true,
    });
    const body = JSON.parse(out.text);
    expect(body.status).toBe("confirmation_required");
    expect(body.estimate.creditsPerExternalLink).toBeUndefined();
    expect(body.estimate.credits).toBe(50 + body.estimate.pages * 2);
  });

  test("surface with confirm registers too", async () => {
    const out = await call("audit_website", {
      ...AUDIT,
      level: "surface",
      confirm: true,
    });
    expect(out.isError).toBe(false);
    expect(registered()).toBe(true);
    expect(finalized()).toMatchObject({ status: "completed" });
  });

  test("a confirm_threshold above the estimate starts without confirm", async () => {
    const out = await call(
      "audit_website",
      { ...AUDIT, level: "quick" },
      "[cloud]\npublish = false\nconfirm_threshold = 100\n"
    );
    expect(out.isError).toBe(false);
    expect(registered()).toBe(true);
  });

  test("a balance below one page is refused with the cost and the balance", async () => {
    balanceTotal = 10;
    const out = await call("audit_website", {
      ...AUDIT,
      level: "quick",
      confirm: true,
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("needs at least 52 credits");
    expect(out.text).toContain("the balance is 10 credits");
    expect(registered()).toBe(false);
    expect(pageRendered()).toBe(false);
  });

  // squirrelscan/repo#3492: the balance read is the wall's, so it says so, and
  // the server counts the view of the upgrade offer the refusal links.
  test("the billed audit's balance read names itself as the MCP wall's", async () => {
    balanceTotal = 10;
    await call("audit_website", { ...AUDIT, level: "quick", confirm: true });
    expect(requested.some((r) => r.endsWith("/v1/credits?cta=mcp"))).toBe(true);
  });

  test("a per-audit cap below one page is refused", async () => {
    const out = await call(
      "audit_website",
      { ...AUDIT, level: "quick", confirm: true },
      "[cloud]\npublish = false\nmax_credits_per_audit = 10\n"
    );
    expect(out.isError).toBe(true);
    expect(out.text).toContain("max_credits_per_audit = 10");
    expect(out.text).toContain("the balance is 5,000 credits");
    expect(registered()).toBe(false);
  });

  test("a register the server refuses stops the audit: nothing runs with the cloud", async () => {
    registerStatus = 402;
    const out = await call("audit_website", {
      ...AUDIT,
      level: "quick",
      confirm: true,
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("Could not start the billed cloud audit");
    expect(out.text).toContain("it needs 52");
    expect(pageRendered()).toBe(false);
  });
});

describe("a billed run is always closed out", () => {
  test("an audit that did not happen closes as failed and says nothing was charged for pages", async () => {
    siteStatus = 403;
    const out = await call("audit_website", {
      ...AUDIT,
      level: "quick",
      confirm: true,
    });
    expect(registered()).toBe(true);
    expect(finalized()).toMatchObject({ status: "failed" });
    expect(out.text).toContain("was closed as failed");
    expect(out.text).not.toContain("about 52 credits");
  });

  test("a call still reading the balance when a shutdown begins never registers", async () => {
    const balance = gate();
    balanceGate = balance.wait;
    const pending = call("audit_website", {
      ...AUDIT,
      level: "quick",
      confirm: true,
    });
    await waitFor(() => requested.some((r) => r.includes("/v1/credits")));
    await cancelActiveMcpRuns();
    balance.open();
    const out = await pending;
    expect(out.isError).toBe(true);
    expect(out.text).toContain("shutting down");
    expect(registered()).toBe(false);
  });

  test("a shutdown during the register closes the new run, and the audit never starts", async () => {
    const register = gate();
    registerGate = register.wait;
    const pending = call("audit_website", {
      ...AUDIT,
      level: "quick",
      confirm: true,
    });
    await waitFor(registered);
    const cancelling = cancelActiveMcpRuns();
    register.open();
    const [out] = await Promise.all([pending, cancelling]);
    expect(out.isError).toBe(true);
    expect(out.text).toContain("shutting down");
    expect(terminalPatches()).toEqual([
      expect.objectContaining({ status: "cancelled" }),
    ]);
    expect(pageRendered()).toBe(false);
  });

  test("a shutdown mid-audit closes the run once, and the finished audit does not reopen it", async () => {
    const site = gate();
    siteGate = site.wait;
    const pending = call("audit_website", {
      ...AUDIT,
      level: "quick",
      confirm: true,
    });
    await waitFor(
      () =>
        requested.filter((r) => r.endsWith(" https://example.com/")).length >= 2
    );
    await cancelActiveMcpRuns();
    site.open();
    await pending;
    expect(terminalPatches()).toEqual([
      expect.objectContaining({ status: "cancelled" }),
    ]);
  });

  test("a shutdown closes the runs still in flight as cancelled", async () => {
    writeFileSync(configPath, "[cloud]\npublish = false\n");
    const config = await loadConfig(configPath, { silent: true });
    const level = await levelRunOptions("quick", 1, config);
    const plan = await planMcpAudit({
      url: AUDIT.url,
      confirm: true,
      config,
      level: {
        coverageMode: level.coverageMode,
        maxPages: level.maxPages,
        auditLevel: level.auditLevel,
      },
    });
    expect(plan.kind).toBe("billed");
    await cancelActiveMcpRuns();
    const patches = bodies.filter(
      (b) => b.key === `PATCH /v1/agent-runs/${runId}`
    );
    expect(patches.at(-1)?.body).toMatchObject({
      status: "cancelled",
      completionReason: "user_cancel",
    });
    // Nothing left to cancel a second time.
    bodies = [];
    await cancelActiveMcpRuns();
    expect(bodies).toEqual([]);
  });
});

describe("local runs make no cloud call", () => {
  test("signed out, audit_website runs locally", async () => {
    delete process.env.SQUIRREL_API_TOKEN;
    const out = await call("audit_website", { ...AUDIT, level: "surface" });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("<audit");
    expect(cloudCalls()).toEqual([]);
  });

  test("offline: true, signed in, runs locally", async () => {
    const out = await call("audit_website", {
      ...AUDIT,
      level: "quick",
      offline: true,
    });
    expect(out.isError).toBe(false);
    expect(cloudCalls()).toEqual([]);
  });

  test("offline: true with externalLinks: true is refused, like --offline --external-links (repo#2729)", async () => {
    const out = await call("audit_website", {
      ...AUDIT,
      level: "quick",
      offline: true,
      externalLinks: true,
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain(
      "offline: true cannot be combined with externalLinks: true"
    );
    expect(cloudCalls()).toEqual([]);
  });

  test("quick_check, signed in, runs locally", async () => {
    const out = await call("quick_check", { url: AUDIT.url });
    expect(out.isError).toBe(false);
    expect(cloudCalls()).toEqual([]);
  });

  test("a local host is never billed, signed in", async () => {
    const out = await call("audit_website", {
      url: "http://localhost:9/",
      maxPages: 1,
      level: "quick",
      confirm: true,
    });
    expect(out.text).toContain("not reachable by squirrelscan's cloud");
    expect(registered()).toBe(false);
  });
});
