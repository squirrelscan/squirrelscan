// A signed-in audit that fails in milliseconds (here: the site does not
// resolve) must not leave its run to be reaped as "CLI audit stopped reporting
// progress before it finished". The register response releases two PATCHes at
// once, `running` and the terminal `failed`, and the API applies whichever lands
// last; `running` landing second resurrected the run. Driven through citty's
// real parser like audit-no-publish-wiring.test.ts. No `mock.module`.

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

import { audit } from "@/cli/commands/audit";
import { getGlobalConfigPath, setGlobalConfigPath } from "@/config";
import { closeGlobalContentStore } from "@/crawler/storage/content-store";
import { closeGlobalLinkCache } from "@/crawler/storage/link-cache";
import * as pathsModule from "@/self/paths";

// homedir() is fixed at process start in Bun, so every store an audit could
// write is pointed at a scratch dir through the paths module instead.
const scratch = mkdtempSync(join(tmpdir(), "squirrel-run-lifecycle-"));
const restores: (() => void)[] = [];

beforeAll(() => {
  const previousConfig = getGlobalConfigPath();
  const configPath = join(scratch, "squirrel.toml");
  writeFileSync(configPath, "[cloud]\npublish = false\n");
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
let lifecycle: string[] = [];
let restoreConsole: () => void = () => {};

beforeEach(() => {
  lifecycle = [];
  process.exitCode = 0;
  process.env.SQUIRREL_API_SERVER = "http://127.0.0.1:9";
  process.env.SQUIRREL_API_TOKEN = "sqcli_test_token";
  process.env.SQUIRREL_DISABLE_TELEMETRY = "1";
  process.env.SQUIRREL_NO_UPDATE = "1";
  process.exit = ((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as typeof process.exit;
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
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
    if (url.includes("/v1/credits")) {
      return Response.json({
        balance: { total: 5000, monthly: 5000, pack: 0, periodEnd: null },
        plan: { id: "pro", monthlyCredits: 5000 },
        branding: null,
      });
    }
    if (method === "POST" && url.includes("/v1/agent-runs/register")) {
      return Response.json({
        runId: "RUN1",
        auditId: "AUD1",
        websiteId: "WEB1",
      });
    }
    if (method === "PATCH" && url.includes("/v1/agent-runs/RUN1")) {
      const { status } = JSON.parse(String(init?.body ?? "{}")) as {
        status?: string;
      };
      lifecycle.push(`sent ${status}`);
      // A slow `running` is the window the terminal PATCH used to race into.
      if (status === "running") await Bun.sleep(150);
      lifecycle.push(`landed ${status}`);
      return Response.json({ id: "RUN1", status });
    }
    if (!url.includes("/v1/")) {
      // The audited site does not resolve: the audit fails at once.
      throw new TypeError("fetch failed: getaddrinfo ENOTFOUND");
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
});

async function runAudit(): Promise<void> {
  const rawArgs = [
    "https://unreachable.example/",
    "-m",
    "1",
    "-C",
    "quick",
    "-y",
  ];
  try {
    await runCommand(audit, { rawArgs });
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  }
}

/** The terminal PATCH is fire-and-forget on this path: wait for it to land. */
async function settled(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (
    !lifecycle.some((e) => e === "landed failed") &&
    Date.now() < deadline
  ) {
    await Bun.sleep(10);
  }
}

describe("a signed-in audit that fails at once", () => {
  test("sends its terminal status only after `running` has landed", async () => {
    await runAudit();
    await settled();

    expect(process.exitCode).toBe(1);
    expect(lifecycle).toEqual([
      "sent running",
      "landed running",
      "sent failed",
      "landed failed",
    ]);
  });
});
