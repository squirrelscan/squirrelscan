// No audit is free in credits: a signed-in quick audit is a billed cloud audit
// like any other level. It registers the run (registering is what debits the
// audit base and settles the pages) and fetches through the cloud browser by
// default. The quick level only skips the cloud checks. Signed out there is no
// account to bill, so quick stays on the machine. Driven through citty's real
// parser, signed in with a fake token (or none), like
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

import { audit } from "@/cli/commands/audit";
import { getGlobalConfigPath, setGlobalConfigPath } from "@/config";
import { closeGlobalContentStore } from "@/crawler/storage/content-store";
import { closeGlobalLinkCache } from "@/crawler/storage/link-cache";
import * as pathsModule from "@/self/paths";

const scratch = mkdtempSync(join(tmpdir(), "squirrel-quick-billing-"));
const configPath = join(scratch, "squirrel.toml");
const settingsPath = join(scratch, "settings.json");
const restores: (() => void)[] = [];

beforeAll(() => {
  const previousConfig = getGlobalConfigPath();
  setGlobalConfigPath(configPath);
  restores.push(() => setGlobalConfigPath(previousConfig));
  const redirect = {
    getSettingsPath: settingsPath,
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

/** A server-rendered page: the hybrid fetcher keeps it on plain HTTP. */
const STATIC_PAGE =
  "<html><head><title>t</title></head><body><h1>h</h1></body></html>";
/** A client-rendered shell: the hybrid fetcher sends it to the cloud browser. */
const CSR_SHELL =
  '<html><head><title>t</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>';
/** What the audited site answers with. Reassigned per test. */
let pageBody = STATIC_PAGE;
let restoreConsole: () => void = () => {};

beforeEach(() => {
  requested = [];
  output = [];
  pageBody = STATIC_PAGE;
  process.exitCode = 0;
  // A fresh settings file each run, so the once-only cost notice can show.
  rmSync(settingsPath, { force: true });
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
    // The render is recorded above; refusing it sends the page back to plain
    // HTTP at once instead of polling a job that will never finish.
    if (url.includes("/v1/services/render")) {
      return Response.json({ error: "unavailable" }, { status: 503 });
    }
    if (!url.includes("/v1/")) {
      return new Response(pageBody, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
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

async function runAudit(flags: string[]): Promise<void> {
  writeFileSync(configPath, "[cloud]\npublish = false\n");
  const rawArgs = ["https://example.com/", "-y", ...flags];
  try {
    await runCommand(audit, { rawArgs });
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  }
}

const registered = () =>
  requested.some((r) => r.startsWith("POST ") && r.includes("/v1/agent-runs"));

/** A page sent to the paid cloud browser. */
const renderSubmitted = () =>
  requested.some(
    (r) => r.startsWith("POST ") && r.includes("/v1/services/render")
  );

const costNotice = () =>
  output.find((l) => l.includes("Cloud audits are on for your account"));

describe("a signed-in quick audit is a billed cloud audit", () => {
  test("it registers the run, which charges the audit base and settles the pages", async () => {
    await runAudit(["--level", "quick", "-m", "1"]);
    expect(process.exitCode).not.toBe(1);
    expect(registered()).toBe(true);
  });

  test("it uses the cloud browser by default and quotes 50 + 2 per page", async () => {
    await runAudit(["--level", "quick"]);
    // The notice prints only when the run resolved to the cloud browser.
    expect(costNotice()).toContain(
      "About 100 credits: 50 audit base + 50 for up to 25 audited pages"
    );
  });

  test("it renders a client-rendered page in the cloud browser", async () => {
    pageBody = CSR_SHELL;
    await runAudit(["--level", "quick", "-m", "1"]);
    expect(renderSubmitted()).toBe(true);
  });

  // THE CONTROLS: each assertion above can also come out false, so none of
  // them passes because the stub sees everything or the notice always prints.
  test("hybrid, not render-all: a server-rendered page stays on HTTP", async () => {
    await runAudit(["--level", "quick", "-m", "1"]);
    expect(registered()).toBe(true);
    expect(renderSubmitted()).toBe(false);
  });

  test("--offline neither registers nor renders", async () => {
    pageBody = CSR_SHELL;
    await runAudit(["--level", "quick", "-m", "1", "--offline"]);
    expect(registered()).toBe(false);
    expect(renderSubmitted()).toBe(false);
    expect(costNotice()).toBeUndefined();
  });

  test("--http skips the cloud browser, not the registration", async () => {
    pageBody = CSR_SHELL;
    await runAudit(["--level", "quick", "-m", "1", "--http"]);
    expect(registered()).toBe(true);
    expect(renderSubmitted()).toBe(false);
    expect(costNotice()).toBeUndefined();
  });
});

// Signed out there is no account to bill: quick runs on the machine, with no
// account needed and nothing sent to the cloud API.
describe("a signed-out quick audit", () => {
  test("stays local: no balance read, no registration, no render", async () => {
    delete process.env.SQUIRREL_API_TOKEN;
    delete process.env.SQUIRRELSCAN_API_KEY;
    pageBody = CSR_SHELL;
    await runAudit(["--level", "quick", "-m", "1"]);
    expect(process.exitCode).not.toBe(1);
    expect(
      requested.filter((r) => r.includes("/v1/") && !r.includes("/v1/traces"))
    ).toEqual([]);
    expect(costNotice()).toBeUndefined();
  });
});
