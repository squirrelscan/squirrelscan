// #3649: the local MCP `audit_website` path registers an ephemeral run and
// says so when the server did not honour it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { getGlobalConfigPath, loadConfig, setGlobalConfigPath } from "@/config";
import { planMcpAudit, resetBilledRunsForTests } from "@/mcp/billed-audit";
import { levelRunOptions } from "@/mcp/tools/audit-tools";

import { isolateSquirrelHome } from "../helpers/scratch-squirrel-home";

const scratch = isolateSquirrelHome("squirrel-mcp-ephemeral").root;
const configPath = join(scratch, "squirrel.toml");
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const originalConfigPath = getGlobalConfigPath();
let registerBodies: Record<string, unknown>[] = [];
let registerAnswer: Record<string, unknown> = {};
let runCount = 0;

beforeEach(() => {
  registerBodies = [];
  resetBilledRunsForTests();
  setGlobalConfigPath(configPath);
  process.env.SQUIRREL_API_SERVER = "http://127.0.0.1:9";
  process.env.SQUIRREL_API_TOKEN = "sqcli_test_token";
  process.env.SQUIRREL_DISABLE_TELEMETRY = "1";
  process.env.SQUIRREL_NO_HOST_PINNING = "1";
  process.env.SQUIRREL_NO_UPDATE = "1";
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const url = input.toString();
    if (url.includes("/v1/credits")) {
      return Response.json({
        balance: { total: 5000, monthly: 5000, pack: 0, periodEnd: null },
        plan: { id: "pro", monthlyCredits: 5000 },
        branding: null,
      });
    }
    if (url.endsWith("/v1/agent-runs/register")) {
      registerBodies.push(JSON.parse(String(init?.body)));
      runCount += 1;
      return Response.json(
        { runId: `ERUN${runCount}`, auditId: "AUD1", ...registerAnswer },
        { status: 201 }
      );
    }
    return Response.json({});
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
  setGlobalConfigPath(originalConfigPath);
});

async function plan(ephemeral: boolean | undefined, toml = "") {
  writeFileSync(configPath, toml);
  const config = await loadConfig(configPath, { silent: true });
  const level = await levelRunOptions("quick", 1, config);
  return planMcpAudit({
    url: "https://example.com/",
    confirm: true,
    ephemeral,
    config,
    level: {
      coverageMode: level.coverageMode,
      maxPages: level.maxPages,
      auditLevel: level.auditLevel,
    },
  });
}

describe("planMcpAudit: ephemeral (#3649)", () => {
  test("sends ephemeral: true and no notice when the server honours it", async () => {
    registerAnswer = { websiteId: null, ephemeral: true };
    const result = await plan(true);

    expect(registerBodies[0]?.ephemeral).toBe(true);
    expect(result.kind).toBe("billed");
    if (result.kind === "billed") expect(result.billed.notices).toEqual([]);
  });

  test("a server that ignores it adds a notice", async () => {
    registerAnswer = { websiteId: "WEB1" };
    const result = await plan(true);

    expect(result.kind).toBe("billed");
    if (result.kind === "billed") {
      expect(result.billed.notices.join(" ")).toContain("did not confirm");
    }
  });

  test("the argument is absent by default, and [cloud] ephemeral is the default", async () => {
    registerAnswer = { websiteId: "WEB1" };
    await plan(undefined);
    expect("ephemeral" in registerBodies[0]!).toBe(false);

    registerAnswer = { websiteId: null, ephemeral: true };
    await plan(undefined, "[cloud]\nephemeral = true\n");
    expect(registerBodies[1]?.ephemeral).toBe(true);
  });
});
