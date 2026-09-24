// #370: send_feedback on the local stdio server, over an in-memory transport.
// Settings are spied (never the real ~/.squirrel) and fetch is swapped, so the
// real submit path runs without reaching the API.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";

import { ok } from "@/controllers/types";
import { createMcpServer } from "@/mcp/server";
import * as settingsModule from "@/self/settings";
import { DEFAULT_SETTINGS } from "@/self/settings";

let cachedEmail: string | null = null;
let accountEmail: string | null = null;
let lastBody: Record<string, unknown> | null = null;
let status = 200;

const loadUserSettingsSpy = spyOn(
  settingsModule,
  "loadUserSettings"
).mockImplementation(() =>
  ok({
    ...DEFAULT_SETTINGS,
    user_feedback_email: cachedEmail,
    ...(accountEmail
      ? {
          auth: {
            token: "session-token",
            userId: "user_1",
            email: accountEmail,
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
        }
      : {}),
  })
);
afterAll(() => loadUserSettingsSpy.mockRestore());

const originalFetch = globalThis.fetch;
beforeEach(() => {
  cachedEmail = null;
  accountEmail = null;
  lastBody = null;
  status = 200;
  globalThis.fetch = (async (
    _input: string | URL | Request,
    init?: RequestInit
  ) => {
    lastBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response("{}", { status });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function callSendFeedback(args: Record<string, unknown>) {
  const server = createMcpServer();
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  const result = (await client.callTool({
    name: "send_feedback",
    arguments: args,
  })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
  return {
    isError: Boolean(result.isError),
    text: result.content.map((c) => c.text ?? "").join("\n"),
  };
}

describe("send_feedback (local MCP)", () => {
  test("sends through the CLI's feedback path, marked as from MCP", async () => {
    cachedEmail = "agent@example.com";

    const r = await callSendFeedback({
      category: "missing_data",
      message: "The report had no crawl depth",
      run_id: "run_abc",
      website_id: "web_xyz",
    });

    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toMatchObject({
      received: true,
      category: "missing_data",
      truncated: false,
    });
    expect(lastBody).toMatchObject({
      email: "agent@example.com",
      feedback: "The report had no crawl depth",
      category: "missing_data",
      source: "cli",
      metadata: { run_id: "run_abc", website_id: "web_xyz", via: "mcp" },
    });
  });

  test("an explicit email wins; otherwise the account email is the fallback", async () => {
    accountEmail = "account@example.com";

    await callSendFeedback({
      category: "other",
      message: "Using the account email",
    });
    expect(lastBody!.email).toBe("account@example.com");

    await callSendFeedback({
      category: "other",
      message: "Using an explicit email",
      email: "explicit@example.com",
    });
    expect(lastBody!.email).toBe("explicit@example.com");
  });

  test("no email anywhere is a tool error, and nothing is sent", async () => {
    const r = await callSendFeedback({
      category: "bug_report",
      message: "Nobody to reply to",
    });

    expect(r.isError).toBe(true);
    expect(r.text).toContain("Pass `email`");
    expect(lastBody).toBeNull();
  });

  test("too-short text is a tool error", async () => {
    cachedEmail = "agent@example.com";

    const r = await callSendFeedback({ category: "other", message: " ok " });

    expect(r.isError).toBe(true);
    expect(r.text).toContain("at least 5 characters");
    expect(lastBody).toBeNull();
  });

  test("an API failure is a tool error with the fallback URL", async () => {
    cachedEmail = "agent@example.com";
    status = 500;

    const r = await callSendFeedback({
      category: "other",
      message: "This one fails",
    });

    expect(r.isError).toBe(true);
    expect(r.text).toContain("HTTP 500");
    expect(r.text).toContain("https://squirrelscan.com/feedback");
  });
});
