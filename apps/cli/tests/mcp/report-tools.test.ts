// list_audits notice rendering (#1274 follow-up): the CLI's bundled MCP
// server fetches GET /v1/agent-runs/active directly (cliApi, real fetch —
// the repo's established pattern for these calls, see
// tests/controllers/keys-create.test.ts), so coverage here stubs
// globalThis.fetch rather than mocking cliApi itself.
//
// `resolveLogin` only gates the tool's own pre-check (requireLoginError);
// cliApi.request() internally resolves its OWN credential via the real
// resolveCredential(), which reads env/settings.json independent of that
// injected resolver. Without an env token here this call short-circuits to
// { status: 0 } before fetch is ever invoked — passed locally only because
// dev machines often have a real login session, but not in CI (caught by
// PR #1290's Test - CLI run). SQUIRRELSCAN_API_KEY makes it deterministic.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createMcpServer } from "@/mcp/server";
import { API_TOKEN_ENV_VAR, type ResolvedCredential } from "@/self/credentials";

const cred: ResolvedCredential = { token: "sqcli_test", source: "login" };
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv, [API_TOKEN_ENV_VAR]: "sqcli_test" };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

async function connect(): Promise<Client> {
  const server = createMcpServer({ resolveLogin: () => cred });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

function stubActiveRunsFetch(body: unknown): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input.toString();
    if (url.includes("/v1/agent-runs/active")) {
      return new Response(JSON.stringify(body), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

function textOf(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

const notice = {
  type: "page_limit_clamped",
  requested: 3000,
  applied: 500,
  planId: "free",
  planCap: 500,
  upgradeHint:
    "Upgrade to Pro for up to 2,000 pages per cloud audit: https://squirrelscan.com/pricing",
};

describe("list_audits page-limit notice rendering", () => {
  test("no clamped runs: single JSON block, no warn line", async () => {
    stubActiveRunsFetch({
      runs: [
        {
          id: "run_1",
          url: "https://example.com",
          domain: "example.com",
          status: "running",
        },
      ],
    });
    const client = await connect();
    const result = await client.callTool({
      name: "list_audits",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0]!.text).not.toContain("⚠");
    const parsed = JSON.parse(content[0]!.text!) as { runs: unknown[] };
    expect(parsed.runs).toHaveLength(1);
  });

  test("a clamped run: one-line warn precedes the JSON block", async () => {
    stubActiveRunsFetch({
      runs: [
        {
          id: "run_1",
          url: "https://example.com",
          domain: "example.com",
          status: "running",
          pageLimitNotice: notice,
        },
      ],
    });
    const client = await connect();
    const result = await client.callTool({
      name: "list_audits",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(2);
    expect(content[0]!.text).toContain("⚠");
    expect(content[0]!.text).toContain("example.com");
    expect(content[0]!.text).toContain("capped to 500 pages");
    expect(content[0]!.text).toContain("requested 3000");
    expect(content[0]!.text).toContain(notice.upgradeHint);
    // the full structured notice is still present in the JSON block
    const parsed = JSON.parse(content[1]!.text!) as {
      runs: Array<{ pageLimitNotice?: unknown }>;
    };
    expect(parsed.runs[0]?.pageLimitNotice).toEqual(notice);
  });

  test("multiple runs: only clamped ones get a warn line, one per run", async () => {
    stubActiveRunsFetch({
      runs: [
        {
          id: "run_1",
          url: "https://a.example.com",
          domain: "a.example.com",
          status: "running",
        },
        {
          id: "run_2",
          url: "https://b.example.com",
          domain: "b.example.com",
          status: "running",
          pageLimitNotice: notice,
        },
      ],
    });
    const client = await connect();
    const result = await client.callTool({
      name: "list_audits",
      arguments: {},
    });
    const content = result.content as Array<{ type: string; text?: string }>;
    const warnText = content[0]!.text!;
    expect(warnText.split("\n")).toHaveLength(1);
    expect(warnText).toContain("b.example.com");
    expect(warnText).not.toContain("a.example.com");
  });

  test("still returns a clean error via apiResultToTool when the API call fails", async () => {
    globalThis.fetch = (async () =>
      new Response(null, { status: 500 })) as unknown as typeof fetch;
    const client = await connect();
    const result = await client.callTool({
      name: "list_audits",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(textOf(result as never)).toContain("Request failed");
  });

  test("falls back to url when domain is missing", async () => {
    stubActiveRunsFetch({
      runs: [
        {
          id: "run_1",
          url: "https://no-domain.example.com/path",
          status: "running",
          pageLimitNotice: notice,
        },
      ],
    });
    const client = await connect();
    const result = await client.callTool({
      name: "list_audits",
      arguments: {},
    });
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]!.text).toContain("https://no-domain.example.com/path");
  });

  test("a malformed pageLimitNotice (unexpected API shape) is treated as no notice", async () => {
    stubActiveRunsFetch({
      runs: [
        {
          id: "run_1",
          url: "https://example.com",
          domain: "example.com",
          status: "running",
          // missing applied/requested/upgradeHint — must not render "undefined"
          pageLimitNotice: { type: "page_limit_clamped" },
        },
      ],
    });
    const client = await connect();
    const result = await client.callTool({
      name: "list_audits",
      arguments: {},
    });
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0]!.text).not.toContain("⚠");
    expect(content[0]!.text).not.toContain("undefined");
  });

  test("a null entry in runs (unexpected API shape) does not throw", async () => {
    stubActiveRunsFetch({
      runs: [
        null,
        {
          id: "run_2",
          url: "https://example.com",
          domain: "example.com",
          status: "running",
          pageLimitNotice: notice,
        },
      ],
    });
    const client = await connect();
    const result = await client.callTool({
      name: "list_audits",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]!.text).toContain("⚠");
    expect(content[0]!.text).toContain("example.com");
  });
});
