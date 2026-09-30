// #404: `squirrel audit --no-publish` on a signed-in run, driven through
// citty's real parser (`runCommand` with raw argv) rather than a hand-built
// args object. A hand-built `{ "no-publish": true }` is exactly what hid the
// bug: citty delivers the flag as `publish: false` and never sets that key.
//
// Same shape as audit-non-public-host-wiring.test.ts: fetch is stubbed
// file-locally, the run is signed in with a fake token, and the assertion is
// on what leaves the process. No `mock.module` (process-wide in Bun).
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

// homedir() is fixed at process start in Bun, so $HOME set here cannot keep a
// full audit out of the real ~/.squirrel. Point every store it writes at a
// scratch dir through the paths module instead.
const scratch = mkdtempSync(join(tmpdir(), "squirrel-no-publish-"));
const restores: (() => void)[] = [];

beforeAll(() => {
  // A known config, so a squirrel.toml found above the cwd (or [cloud]
  // publish = false in it) cannot decide the control.
  const previousConfig = getGlobalConfigPath();
  const configPath = join(scratch, "squirrel.toml");
  writeFileSync(configPath, "[cloud]\npublish = true\n");
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
  // The content store and link cache are process-wide singletons opened under
  // this scratch dir; left open they break every later file's audits.
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
  // Bun ignores `process.exitCode = undefined`, so a refused case's 1 would
  // otherwise carry into the next test (and the runner's own exit).
  process.exitCode = 0;
  // A dead local port: anything the stub below misses fails instead of
  // reaching the real API with the fake token.
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
    // Signed in: the balance probe answers.
    if (url.includes("/v1/credits")) {
      return Response.json({
        balance: { total: 5000, monthly: 5000, pack: 0, periodEnd: null },
        plan: { id: "pro", monthlyCredits: 5000 },
        branding: null,
      });
    }
    // The publish fails, like the timeout in the issue, so an attempt also
    // shows up as the "Could not auto-publish" warning.
    if (url.includes("/v1/reports")) {
      return Response.json({ error: "stub" }, { status: 500 });
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
});

/** `squirrel audit https://example.com/ <flags>`, one page, no prompts. */
async function runAudit(flags: string[]): Promise<void> {
  const rawArgs = [
    "https://example.com/",
    "-m",
    "1",
    "-C",
    "quick",
    "-y",
    ...flags,
  ];
  try {
    await runCommand(audit, { rawArgs });
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  }
}

const publishAttempts = () =>
  requested.filter((r) => r.startsWith("POST ") && r.includes("/v1/reports"));
const warned = () =>
  output.some((line) => line.includes("Could not auto-publish"));

describe("squirrel audit --no-publish (#404)", () => {
  // THE CONTROL: the same signed-in run without the flag does publish, so the
  // test below cannot pass because nothing publishes at all.
  test("a signed-in run auto-publishes", async () => {
    await runAudit([]);
    expect(requested.some((r) => r.includes("/v1/credits"))).toBe(true);
    expect(publishAttempts()).toHaveLength(1);
    expect(warned()).toBe(true);
  });

  test("--no-publish makes no publish attempt", async () => {
    await runAudit(["--no-publish"]);
    expect(requested.some((r) => r.includes("/v1/credits"))).toBe(true);
    expect(publishAttempts()).toEqual([]);
    expect(warned()).toBe(false);
  });

  test.each([
    [["--publish", "--no-publish"]],
    [["--no-publish", "--publish"]],
    [["-p", "--no-publish"]],
    [["--no-publish", "-p"]],
  ])("%j is refused before any work", async (flags) => {
    await runAudit(flags);
    expect(process.exitCode).toBe(1);
    expect(output).toContain("--no-publish cannot be combined with --publish");
    expect(requested).toEqual([]);
  });

  // Only a --no-publish in argv widens the --publish check: an explicit
  // --publish=false next to --offline stays valid.
  test("--offline --publish=false still runs", async () => {
    await runAudit(["--offline", "--publish=false"]);
    expect(process.exitCode).not.toBe(1);
    expect(output.some((l) => l.includes("cannot be combined"))).toBe(false);
    expect(publishAttempts()).toEqual([]);
  });
});
