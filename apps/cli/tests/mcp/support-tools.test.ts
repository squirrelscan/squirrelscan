// #1090: the support tools on the local MCP server, over an in-memory
// transport. fetch is swapped for a fake API, restored after each test.
// SQUIRREL_API_TOKEN keeps cliApi's own credential lookup deterministic (see
// report-tools.test.ts); resolveLogin only drives the tool's pre-check.

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createMcpServer } from "@/mcp/server";
import { API_TOKEN_ENV_VAR, type ResolvedCredential } from "@/self/credentials";

const cred: ResolvedCredential = { token: "sqcli_test", source: "login" };
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const TID = "00000000-0000-0000-0000-000000000001";

interface Seen {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}
let seen: Seen[] = [];
type Responder = (s: Seen) => { status: number; body: unknown };
let respond: Responder;

beforeEach(() => {
  seen = [];
  respond = () => ({ status: 404, body: {} });
  process.env = { ...originalEnv, [API_TOKEN_ENV_VAR]: "sqcli_test" };
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const url = new URL(input.toString());
    const entry: Seen = {
      method: init?.method ?? "GET",
      path: url.pathname + url.search,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    seen.push(entry);
    const r = respond(entry);
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

async function call(
  name: string,
  args: Record<string, unknown>,
  login: ResolvedCredential | null = cred
) {
  const server = createMcpServer({ resolveLogin: () => login });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text?: string }>;
  };
  return {
    isError: Boolean(result.isError),
    text: result.content.map((c) => c.text ?? "").join("\n"),
  };
}

const ticketRow = {
  id: TID,
  ref: "ABCDE",
  type: "bug",
  subject: "Crash",
  status: "in_progress",
  isUserRead: false,
  lastMessageAt: "2026-01-02T00:00:00Z",
  createdAt: "2026-01-01T00:00:00Z",
};

describe("support tools", () => {
  test.each([
    [
      "create_support_ticket",
      { type: "bug", subject: "abc", body: "ten chars!!" },
    ],
    ["list_support_tickets", {}],
    ["get_support_ticket", { ref: "ABCDE" }],
    ["reply_to_support_ticket", { ref: "ABCDE", body: "hi" }],
  ])("%s refuses when logged out, and sends nothing", async (name, args) => {
    const r = await call(name, args, null);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Not authenticated");
    expect(seen).toHaveLength(0);
  });

  test("create sends source mcp and structured metadata", async () => {
    respond = () => ({ status: 201, body: { id: TID, ref: "ABCDE" } });
    const r = await call("create_support_ticket", {
      type: "bug",
      subject: "Audit crashed",
      body: "It exited with code 2 on /pricing.",
      run_id: "run_1",
      rule_id: "core/title",
    });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toMatchObject({ ref: "ABCDE", id: TID });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: "POST",
      path: "/v1/support/tickets",
    });
    expect(seen[0]!.body).toMatchObject({
      type: "bug",
      subject: "Audit crashed",
      message: "It exited with code 2 on /pricing.",
      source: "mcp",
      metadata: {
        source: "mcp",
        runId: "run_1",
        ruleId: "core/title",
        platform: `${process.platform}-${process.arch}`,
      },
    });
    expect(
      typeof (seen[0]!.body!.metadata as Record<string, unknown>).cliVersion
    ).toBe("string");
  });

  test("create clamps a long body and reports it; a short one never leaves the machine", async () => {
    respond = () => ({ status: 201, body: { id: TID, ref: "ABCDE" } });
    const long = await call("create_support_ticket", {
      type: "other",
      subject: "Long one",
      body: "x".repeat(10050),
    });
    expect(JSON.parse(long.text).truncated).toEqual({
      subject: false,
      body: true,
    });
    expect(String(seen[0]!.body!.message)).toHaveLength(10000);

    seen = [];
    const short = await call("create_support_ticket", {
      type: "other",
      subject: "Short",
      body: "tiny",
    });
    expect(short.isError).toBe(true);
    expect(short.text).toContain("at least 10");
    expect(seen).toHaveLength(0);
  });

  test("a rate limit is a clean tool error", async () => {
    respond = () => ({ status: 429, body: { error: "Too many tickets" } });
    const r = await call("create_support_ticket", {
      type: "bug",
      subject: "Again",
      body: "another failure here",
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Too many tickets");
  });

  test("an org API key is a clear 403", async () => {
    respond = () => ({
      status: 403,
      body: { error: "This operation requires a user session, not an API key" },
    });
    const r = await call("list_support_tickets", {});
    expect(r.isError).toBe(true);
    expect(r.text).toContain("requires a user session");
  });

  test("list adds waiting_on and passes the status filter", async () => {
    respond = () => ({
      status: 200,
      body: {
        data: [
          ticketRow,
          { ...ticketRow, ref: "FGHIJ", isUserRead: true, status: "new" },
        ],
        total: 2,
      },
    });
    const r = await call("list_support_tickets", { status: "in_progress" });
    expect(seen[0]!.path).toBe(
      "/v1/support/tickets?status=in_progress&limit=20"
    );
    const out = JSON.parse(r.text);
    expect(out.total).toBe(2);
    expect(
      out.tickets.map((t: { waiting_on: string }) => t.waiting_on)
    ).toEqual(["you", "support"]);
  });

  test("get resolves a ref, returns markdown with waiting_on, and marks read", async () => {
    respond = (s) => {
      if (s.path.startsWith("/v1/support/tickets?")) {
        return { status: 200, body: { data: [ticketRow], total: 1 } };
      }
      if (s.method === "POST") return { status: 200, body: {} };
      return {
        status: 200,
        body: {
          ticket: ticketRow,
          messages: [
            {
              id: "m1",
              role: "user",
              authorName: "Me",
              body: "It broke.",
              createdAt: "2026-01-01T00:00:00Z",
            },
            {
              id: "m2",
              role: "admin",
              authorName: "Nik",
              body: "Fixed in the next release.",
              createdAt: "2026-01-02T00:00:00Z",
            },
          ],
        },
      };
    };
    const r = await call("get_support_ticket", { ref: "abcde" });
    expect(r.isError).toBe(false);
    const out = JSON.parse(r.text);
    expect(out).toMatchObject({
      ref: "ABCDE",
      status: "in_progress",
      waiting_on: "you",
    });
    expect(out.thread).toContain("Fixed in the next release.");
    expect(seen.at(-1)).toMatchObject({
      method: "POST",
      path: `/v1/support/tickets/${TID}/read`,
    });
  });

  test("get on an unknown ref is a not-found error", async () => {
    respond = () => ({ status: 200, body: { data: [], total: 0 } });
    const r = await call("get_support_ticket", { ref: "ZZZZZ" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("No support ticket");
  });

  test("reply posts to the ticket's messages route", async () => {
    respond = () => ({ status: 201, body: { id: "m9" } });
    const r = await call("reply_to_support_ticket", {
      ref: TID,
      body: "More detail.",
    });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toMatchObject({
      id: "m9",
      message: "Reply sent.",
    });
    expect(seen[0]).toMatchObject({
      method: "POST",
      path: `/v1/support/tickets/${TID}/messages`,
      body: { message: "More detail." },
    });
  });
});
