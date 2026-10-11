// #403: `squirrel audit` with a local store it cannot write stops before the
// run is registered (so it charges nothing) and before any request reaches the
// site, with one line naming the file, the cause and the fix. Driven through
// citty's real parser, signed in with a fake token, like
// audit-no-publish-wiring.test.ts. No `mock.module` (process-wide in Bun).

import { Database } from "bun:sqlite";
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
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { audit } from "@/cli/commands/audit";
import { getGlobalConfigPath, setGlobalConfigPath } from "@/config";
import { closeGlobalContentStore } from "@/crawler/storage/content-store";
import { closeGlobalLinkCache } from "@/crawler/storage/link-cache";

import { isolateSquirrelHome } from "../helpers/scratch-squirrel-home";

// homedir() is fixed at process start in Bun, so every store an audit writes is
// pointed at a scratch dir through the paths module instead (#626). The
// content store moves per test and lives OUTSIDE the scratch squirrel home, the
// way a SQUIRREL_CONTENT_STORE_PATH store does, so its fix line names the file.
const scratch = isolateSquirrelHome("squirrel-local-store", {
  getContentStorePath: () => contentStorePath,
}).dir;
const restores: (() => void)[] = [];
let contentStorePath = join(scratch, "content-store.db");

beforeAll(() => {
  const previousConfig = getGlobalConfigPath();
  const configPath = join(scratch, "squirrel.toml");
  writeFileSync(configPath, "[cloud]\npublish = false\n");
  setGlobalConfigPath(configPath);
  restores.push(() => setGlobalConfigPath(previousConfig));
});

afterAll(() => {
  closeGlobalContentStore();
  closeGlobalLinkCache();
  for (const restore of restores) restore();
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
    output.push(parts.map(String).join(" "));
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
        {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }
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

async function runAudit(): Promise<void> {
  const rawArgs = [
    "https://example.com/",
    "-m",
    "1",
    "-C",
    "quick",
    "-y",
    "--no-publish",
  ];
  try {
    await runCommand(audit, { rawArgs });
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  }
}

const registered = () =>
  requested.some((r) => r.startsWith("POST ") && r.includes("/v1/agent-runs"));
const siteRequests = () => requested.filter((r) => !r.includes("/v1/"));

describe("squirrel audit with a local store it cannot write (#403)", () => {
  // THE CONTROL: a writable store registers the run and crawls the site, so
  // the refusals below cannot pass because nothing ever happens.
  test("a writable store registers the run and crawls", async () => {
    contentStorePath = join(scratch, "content-store.db");
    await runAudit();
    expect(process.exitCode).not.toBe(1);
    expect(registered()).toBe(true);
    expect(siteRequests().length).toBeGreaterThan(0);
  });

  test("a content store path that is a directory stops before the run is registered", async () => {
    contentStorePath = join(scratch, "store-dir");
    mkdirSync(contentStorePath, { recursive: true });
    await runAudit();
    expect(process.exitCode).toBe(1);
    expect(output.join("\n")).toContain(
      "store-dir: it is a directory, not a database file"
    );
    expect(registered()).toBe(false);
    expect(siteRequests()).toEqual([]);
  });

  // Permission bits do not bind root, so the refusal cannot be observed there.
  test.skipIf(process.getuid?.() === 0)(
    "a read-only content store stops before the run is registered",
    async () => {
      contentStorePath = join(scratch, "read-only.db");
      new Database(contentStorePath).close();
      chmodSync(contentStorePath, 0o444);
      try {
        await runAudit();
      } finally {
        chmodSync(contentStorePath, 0o644);
      }
      expect(process.exitCode).toBe(1);
      expect(output.join("\n")).toContain(
        "read-only.db: it is read-only. Fix: chmod u+w"
      );
      expect(registered()).toBe(false);
      expect(siteRequests()).toEqual([]);
    }
  );
});
