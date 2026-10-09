// The quick level spends no credits, signed in or not. A quick audit has no
// cloud checks, so it does not register with the cloud (registering is what
// debits the audit base and settles the pages) and it does not send pages to
// the paid cloud browser unless the user asks for rendering. Driven through
// citty's real parser, signed in with a fake token, like
// audit-local-store-wiring.test.ts. No `mock.module` (process-wide in Bun).

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { runCommand } from "citty";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { audit, renderOnlyPageBudget } from "@/cli/commands/audit";
import { getGlobalConfigPath, setGlobalConfigPath } from "@/config";
import { closeGlobalContentStore } from "@/crawler/storage/content-store";
import { closeGlobalLinkCache } from "@/crawler/storage/link-cache";
import * as pathsModule from "@/self/paths";

const scratch = mkdtempSync(join(tmpdir(), "squirrel-quick-free-"));
const configPath = join(scratch, "squirrel.toml");
const restores: (() => void)[] = [];

beforeAll(() => {
  const previousConfig = getGlobalConfigPath();
  setGlobalConfigPath(configPath);
  restores.push(() => setGlobalConfigPath(previousConfig));
  const redirect = {
    getSettingsPath: join(scratch, "settings.json"),
    getProjectsPath: join(scratch, "projects"),
    getLinkCachePath: join(scratch, "link-cache.db"),
    getContentStorePath: join(scratch, "content-store.db"),
    getCachePath: join(scratch, "cache"),
    getLogsPath: join(scratch, "logs"),
  } as const;
  for (const [name, path] of Object.entries(redirect)) {
    const spy = spyOn(
      pathsModule,
      name as keyof typeof redirect
    ).mockImplementation(() => path);
    restores.push(() => spy.mockRestore());
  }
});

afterAll(() => {
  closeGlobalContentStore();
  closeGlobalLinkCache();
  for (const restore of restores) restore();
  rmSync(scratch, { recursive: true, force: true });
});

/** Thrown in place of process.exit, so a command exit cannot kill the runner. */
class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

const originalFetch = globalThis.fetch;
const originalExit = process.exit;
const originalExitCode = process.exitCode;
const originalEnv = { ...process.env };
let requested: string[] = [];
let output: string[] = [];
let restoreConsole: () => void = () => {};

beforeEach(() => {
  requested = [];
  output = [];
  process.exitCode = 0;
  process.env.SQUIRREL_API_SERVER = "http://127.0.0.1:9";
  process.env.SQUIRREL_API_TOKEN = "sqcli_test_token";
  process.env.SQUIRREL_DISABLE_TELEMETRY = "1";
  process.env.SQUIRREL_NO_UPDATE = "1";
  process.exit = ((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as typeof process.exit;
  const capture = (...parts: unknown[]) => {
    output.push(Bun.stripANSI(parts.map(String).join(" ")));
  };
  const log = spyOn(console, "log").mockImplementation(capture);
  const error = spyOn(console, "error").mockImplementation(capture);
  restoreConsole = () => {
    log.mockRestore();
    error.mockRestore();
  };
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const url = input.toString();
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    requested.push(`${method} ${url}`);
    if (url.includes("/v1/credits")) {
      return Response.json({
        balance: { total: 5000, monthly: 5000, pack: 0, periodEnd: null },
        plan: { id: "pro", monthlyCredits: 5000 },
        branding: null,
      });
    }
    if (url.includes("/v1/agent-runs")) {
      return Response.json({ runId: "RUN1" }, { status: 201 });
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
  restoreConsole();
  globalThis.fetch = originalFetch;
  process.exit = originalExit;
  process.exitCode = originalExitCode ?? 0;
  process.env = { ...originalEnv };
  closeGlobalContentStore();
  closeGlobalLinkCache();
});

async function runAudit(
  flags: string[],
  config = "[cloud]\npublish = false\n"
): Promise<void> {
  writeFileSync(configPath, config);
  const rawArgs = ["https://example.com/", "-m", "1", "-y", ...flags];
  try {
    await runCommand(audit, { rawArgs });
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  }
}

/**
 * Every request this run sent to the cloud API, other than the balance read
 * and the CLI's own trace upload (diagnostics, never billed).
 */
const cloudCalls = () =>
  requested.filter(
    (r) =>
      r.includes("/v1/") &&
      !r.includes("/v1/credits") &&
      !r.includes("/v1/traces")
  );

describe("a signed-in quick audit spends nothing", () => {
  test("it reads the balance, then makes no cloud call at all", async () => {
    await runAudit(["--level", "quick"]);
    expect(process.exitCode).not.toBe(1);
    // Signed in for real: the balance was read and the account line shows it.
    expect(requested.some((r) => r.includes("/v1/credits"))).toBe(true);
    // No register (no audit base, no page settlement), no render, no cloud checks.
    expect(cloudCalls()).toEqual([]);
    expect(output.some((l) => l.startsWith("Credits used: 0"))).toBe(true);
  });

  // THE CONTROL: a level with cloud checks still registers, so the test above
  // cannot pass because nothing registers at all.
  test("a surface audit still registers", async () => {
    // [cloud] enabled = false keeps the cloud checks' own calls out of the
    // run, so only the register is left to look for.
    await runAudit(
      ["--level", "surface", "--http"],
      '[cloud]\npublish = false\nenabled = false\n\n[external_links]\nenabled = false\n\n[security]\nprobe = "passive"\n'
    );
    expect(
      requested.some(
        (r) => r.startsWith("POST ") && r.includes("/v1/agent-runs")
      )
    ).toBe(true);
  });
});

// A quick audit does not register, so the affordability preflight does not
// run for it. A render the user asks for is a paid standalone render, held to
// the same balance and per-audit cap on the worst case of every page.
describe("renderOnlyPageBudget", () => {
  const budget = (over: Partial<Parameters<typeof renderOnlyPageBudget>[0]>) =>
    renderOnlyPageBudget({
      maxPages: 25,
      balance: 5000,
      maxCreditsPerAudit: 1000,
      ...over,
    });

  test("a budget that covers every page clamps nothing", () => {
    expect(budget({})).toEqual({ maxPages: 25, clamped: false });
  });

  test("the per-audit cap lowers the pages, at 2 credits a render", () => {
    expect(budget({ maxCreditsPerAudit: 10 })).toEqual({
      maxPages: 5,
      clamped: true,
      limitedBy: "cap",
    });
    // 0 = no cap.
    expect(budget({ maxCreditsPerAudit: 0, maxPages: 5000 }).maxPages).toBe(
      2500
    );
  });

  test("so does the balance, unless the plan is unmetered", () => {
    expect(budget({ balance: 9 })).toEqual({
      maxPages: 4,
      clamped: true,
      limitedBy: "balance",
    });
    expect(budget({ balance: 0, unlimited: true }).clamped).toBe(false);
  });

  test("not even one render fits: 0 pages", () => {
    expect(budget({ maxCreditsPerAudit: 1 }).maxPages).toBe(0);
  });
});

describe("a signed-in quick audit that asks to render", () => {
  test("a cap below one render fetches over HTTP and says so, sending no render", async () => {
    await runAudit(
      ["--level", "quick", "--render-mode", "all"],
      "[cloud]\npublish = false\nmax_credits_per_audit = 1\n"
    );
    expect(
      output.some((l) =>
        l.includes(
          "does not cover one rendered page (2 credits), so this quick audit fetches over HTTP"
        )
      )
    ).toBe(true);
    expect(cloudCalls()).toEqual([]);
  });
});
