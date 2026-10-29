// #3649 at the `squirrel audit` command boundary: what an ephemeral run sends,
// publishes and prints. Drives the real command against a stubbed API, modelled
// on audit-schedule-notice-wiring.test.ts (no `mock.module`; the squirrel home
// is a scratch dir).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { audit } from "@/cli/commands/audit";
import { getGlobalConfigPath, setGlobalConfigPath } from "@/config";

import { isolateSquirrelHome } from "../helpers/scratch-squirrel-home";

const scratch = isolateSquirrelHome("squirrel-ephemeral").root;
const configPath = join(scratch, "squirrel.toml");

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

const originalFetch = globalThis.fetch;
const originalExit = process.exit;
const originalLog = console.log;
const originalError = console.error;
const originalEnv = { ...process.env };
const originalConfigPath = getGlobalConfigPath();
let printed: string[] = [];
let calls: { key: string; body: Record<string, unknown> }[] = [];
/** What the register route answers with. Reassigned per test. */
let registerAnswer: Record<string, unknown>;
let registerStatus = 201;

const HONOURED = {
  runId: "run_e",
  auditId: "aud_e",
  websiteId: null,
  baseCharged: 50,
  ephemeral: true,
  websiteRegistration: { skipped: true, reason: "ephemeral" },
};
const IGNORED = {
  runId: "run_e",
  auditId: "aud_e",
  websiteId: "web_1",
  baseCharged: 50,
};

beforeEach(() => {
  printed = [];
  calls = [];
  registerAnswer = HONOURED;
  registerStatus = 201;
  writeFileSync(configPath, "");
  setGlobalConfigPath(configPath);
  process.env.SQUIRREL_API_TOKEN = "sqcli_test_token";
  process.env.SQUIRREL_DISABLE_TELEMETRY = "1";
  process.env.SQUIRREL_NO_HOST_PINNING = "1";
  process.exit = ((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as typeof process.exit;
  console.log = (...a: unknown[]) => printed.push(a.join(" "));
  console.error = (...a: unknown[]) => printed.push(a.join(" "));
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const url = input.toString();
    const method = init?.method ?? "GET";
    if (url.includes("/v1/")) {
      calls.push({
        key: `${method} ${new URL(url).pathname}`,
        body:
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : {},
      });
    }
    if (url.includes("/v1/credits")) {
      return Response.json({
        balance: { total: 5000, monthly: 5000, pack: 0, periodEnd: null },
        plan: { id: "starter", monthlyCredits: 3000 },
        branding: null,
      });
    }
    if (url.endsWith("/v1/agent-runs/register")) {
      return Response.json(registerAnswer, { status: registerStatus });
    }
    if (url.includes("/v1/reports")) {
      return Response.json(
        {
          id: "rep_1",
          url: "https://reports.squirrelscan.com/rep_1",
          visibility: "unlisted",
          createdAt: new Date().toISOString(),
          healthScore: 80,
          issuesFound: 1,
          totalPages: 1,
        },
        { status: 201 }
      );
    }
    if (!url.includes("/v1/")) {
      return new Response(
        "<html><head><title>t</title></head><body><h1>h</h1></body></html>",
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }
    return Response.json({});
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.exit = originalExit;
  console.log = originalLog;
  console.error = originalError;
  process.env = { ...originalEnv };
  setGlobalConfigPath(originalConfigPath);
});

async function runAudit(
  rawArgs: string[],
  extra: Record<string, unknown> = {}
) {
  const args: Record<string, unknown> = {
    url: "https://example.com/",
    "max-pages": "1",
    coverage: "quick",
    yes: true,
    format: "console",
    ...extra,
  };
  for (const token of rawArgs) {
    if (token === "--ephemeral") args.ephemeral = true;
    if (token === "--no-ephemeral") args.ephemeral = false;
    if (token === "--publish") args.publish = true;
  }
  try {
    await audit.run!({ args, rawArgs } as never);
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  }
}

const output = () => printed.join("\n");
const registerBody = () =>
  calls.find((c) => c.key === "POST /v1/agent-runs/register")?.body;
const published = () => calls.filter((c) => c.key === "POST /v1/reports");

describe("squirrel audit --ephemeral (#3649)", () => {
  test("registers ephemeral, publishes and syncs nothing, says so", async () => {
    await runAudit(["--ephemeral"]);

    expect(registerBody()?.ephemeral).toBe(true);
    expect(published()).toEqual([]);
    expect(calls.some((c) => c.key.includes("/technologies"))).toBe(false);
    expect(output()).toContain("Ephemeral run:");
    expect(output()).toContain("not published");
    expect(output()).not.toContain("did not honour");
  });

  test("a normal run sends no ephemeral field and still publishes", async () => {
    registerAnswer = IGNORED;
    await runAudit([]);

    expect(registerBody()).toBeDefined();
    expect("ephemeral" in (registerBody() ?? {})).toBe(false);
    expect(published()).toHaveLength(1);
    expect(output()).not.toContain("Ephemeral run:");
  });

  test("[cloud] ephemeral = true is the same as the flag", async () => {
    writeFileSync(configPath, "[cloud]\nephemeral = true\n");
    await runAudit([]);

    expect(registerBody()?.ephemeral).toBe(true);
    expect(published()).toEqual([]);
  });

  test("--no-ephemeral overrides the config", async () => {
    writeFileSync(configPath, "[cloud]\nephemeral = true\n");
    registerAnswer = IGNORED;
    await runAudit(["--no-ephemeral"]);

    expect("ephemeral" in (registerBody() ?? {})).toBe(false);
    expect(published()).toHaveLength(1);
  });

  test("an explicit --publish publishes unlisted, with no website id", async () => {
    await runAudit(["--ephemeral", "--publish"]);

    const [report] = published();
    expect(report).toBeDefined();
    expect(report?.body.websiteId).toBeUndefined();
    expect(report?.body.visibility).toBe("unlisted");
    expect(output()).toContain("https://reports.squirrelscan.com/rep_1");
    expect(output()).toContain("not attached to a dashboard site");
    expect(output()).not.toContain("Scheduled audits:");
    expect(output()).not.toContain("not published");
  });

  test("config ephemeral plus an explicit --publish publishes", async () => {
    writeFileSync(configPath, "[cloud]\nephemeral = true\n");
    await runAudit(["--publish"]);

    expect(published()).toHaveLength(1);
    expect(published()[0]?.body.websiteId).toBeUndefined();
  });

  test("a server that ignores it is warned about and nothing is published", async () => {
    registerAnswer = IGNORED;
    await runAudit(["--ephemeral", "--publish"]);

    expect(output()).toContain("did not honour --ephemeral");
    expect(published()).toEqual([]);
  });

  test("no warning when the server skipped the website itself", async () => {
    registerAnswer = {
      ...IGNORED,
      websiteId: null,
      websiteRegistration: { skipped: true, reason: "non_public_host" },
    };
    await runAudit(["--ephemeral"]);

    expect(output()).not.toContain("did not honour");
  });

  test("a refused register prints no ephemeral banner", async () => {
    registerStatus = 402;
    registerAnswer = {
      error: { code: "INSUFFICIENT_CREDITS", message: "no", required: 52 },
    };
    await runAudit(["--ephemeral"]);

    expect(output()).not.toContain("Ephemeral run:");
  });

  test("signed out prints no ephemeral banner", async () => {
    delete process.env.SQUIRREL_API_TOKEN;
    await runAudit(["--ephemeral"]);

    expect(output()).not.toContain("Ephemeral run:");
    expect(output()).not.toContain("Mode");
  });

  test("--offline is accepted with a one-line note", async () => {
    await runAudit(["--ephemeral"], { offline: true });

    expect(output()).toContain("--ephemeral has no effect offline");
    expect(calls).toEqual([]);
  });
});
