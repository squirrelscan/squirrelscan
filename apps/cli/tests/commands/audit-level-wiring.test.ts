// Audit levels on `squirrel audit`, driven through citty's real parser
// (`runCommand` with raw argv) so a flag that parses in a unit test but never
// reaches the command fails here. The assertions are on the run banner and on
// the options the controller actually receives: the level's settings are the
// defaults, and the existing flags and config values override them.
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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RunAuditOptions } from "@/controllers/audit";

import { audit } from "@/cli/commands/audit";
import { getGlobalConfigPath, setGlobalConfigPath } from "@/config";
import * as controller from "@/controllers/audit";
import { closeGlobalContentStore } from "@/crawler/storage/content-store";
import { closeGlobalLinkCache } from "@/crawler/storage/link-cache";
import * as pathsModule from "@/self/paths";

// Same isolation as audit-probe-wiring.test.ts: every store the audit writes
// goes to a scratch dir, and the process-wide stores are closed on the way in
// and out.
function closeGlobalStores(): void {
  closeGlobalContentStore();
  closeGlobalLinkCache();
}
const scratch = mkdtempSync(join(tmpdir(), "squirrel-level-wiring-"));
const configPath = join(scratch, "squirrel.toml");
const restores: (() => void)[] = [];

// The options each run handed to the controller.
let runs: RunAuditOptions[] = [];

beforeAll(() => {
  closeGlobalStores();
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
  const realRunAudit = controller.runAudit;
  const spy = spyOn(controller, "runAudit").mockImplementation(
    (options: RunAuditOptions) => {
      runs.push(options);
      return realRunAudit(options);
    }
  );
  restores.push(() => spy.mockRestore());
});

afterAll(() => {
  closeGlobalStores();
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
let output: string[] = [];
let requested: string[] = [];
let restoreConsole: () => void = () => {};

beforeEach(() => {
  runs = [];
  output = [];
  requested = [];
  process.exitCode = 0;
  // Anonymous and offline: nothing here may reach a real API.
  delete process.env.SQUIRREL_API_TOKEN;
  process.env.SQUIRREL_API_SERVER = "http://127.0.0.1:9";
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
  // A one-page site: everything but the home page is a 404.
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(input.toString());
    if (url.hostname === "example.com") requested.push(url.pathname);
    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        "<html><head><title>t</title></head><body><h1>h</h1></body></html>",
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  restoreConsole();
  globalThis.fetch = originalFetch;
  process.exit = originalExit;
  process.exitCode = originalExitCode ?? 0;
  process.env = { ...originalEnv };
});

/**
 * `squirrel audit https://example.com/ <flags> --offline -y`, or online (still
 * signed out) with `online: true`.
 */
async function runAudit(
  flags: string[],
  config = "",
  { online = false } = {}
): Promise<void> {
  writeFileSync(configPath, config);
  const rawArgs = [
    "https://example.com/",
    ...flags,
    ...(online ? [] : ["--offline"]),
    "-y",
  ];
  try {
    await runCommand(audit, { rawArgs });
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  }
}

const line = (label: string) =>
  output.find((l) => l.startsWith(label.padEnd(10)))?.slice(10);

// Probing follows the level, not sign-in: a signed-out audit at surface or
// full probes actively, like a signed-in one, and quick stays passive. The
// maintainer signed this change off for anonymous users (pub#598).
describe("signed out and online, probing follows the level", () => {
  test.each([
    ["quick", "passive"],
    ["surface", "active"],
    ["full", "active"],
  ] as const)("--level %s probes %s", async (level, probe) => {
    await runAudit(["--level", level, "-m", "1"], "", { online: true });
    expect(process.exitCode).toBe(0);
    expect(line("Account")).toContain("not signed in");
    expect(runs[0]?.probe?.level).toBe(probe);
    expect(line("Probing")?.startsWith(probe)).toBe(true);
  });
});

describe("squirrel audit --level", () => {
  test.each([
    [["--level", "quick"], "quick · max 25 pages"],
    [["--level", "surface"], "surface · max 100 pages"],
    [["--level", "full"], "full · max 500 pages"],
    // The old flag and the old name for quick still work.
    [["-C", "fast"], "quick · max 25 pages"],
    [["--coverage", "surface"], "surface · max 100 pages"],
  ])("%p prints `Level %s`", async (flags, banner) => {
    await runAudit(flags);
    expect(process.exitCode).toBe(0);
    expect(line("Level")).toBe(banner);
    expect(line("Coverage")).toBeUndefined();
  });

  test("signed out, no flag: the quick level", async () => {
    await runAudit([]);
    expect(line("Level")).toBe("quick · max 25 pages");
    expect(runs[0]?.auditLevel?.level).toBe("quick");
  });

  test("quick's settings reach the controller as defaults", async () => {
    await runAudit(["--level", "quick"]);
    const options = runs[0]!;
    expect(options.coverageMode).toBe("quick");
    expect(options.maxPages).toBe(25);
    expect(options.externalLinksEnabled).toBe(false);
    expect(options.renderStrategy).toBe("auto");
    expect(options.probe?.level).toBe("passive");
    expect(options.auditLevel?.settings.cloudChecks).toBe(false);
  });

  test("surface's settings reach the controller as defaults", async () => {
    await runAudit(["--level", "surface"]);
    const options = runs[0]!;
    expect(options.coverageMode).toBe("surface");
    expect(options.maxPages).toBe(100);
    expect(options.externalLinksEnabled).toBe(true);
    expect(options.renderStrategy).toBe("all");
    expect(options.probe?.level).toBe("active");
    expect(line("Probing")).toBe("active · budget 30s");
    expect(options.auditLevel?.settings.cloudChecks).toBe(true);
  });

  test("--max-pages makes it custom and the banner names the change", async () => {
    await runAudit(["--level", "surface", "--max-pages", "200"]);
    expect(line("Level")).toBe("custom (surface + max_pages 200)");
    expect(runs[0]?.maxPages).toBe(200);
    expect(runs[0]?.auditLevel).toMatchObject({
      level: "custom",
      basedOn: "surface",
      changes: ["pages"],
    });
  });

  test("an override equal to the level's own value is not a change", async () => {
    await runAudit(["--level", "surface", "-m", "100", "--probe", "active"]);
    expect(line("Level")).toBe("surface · max 100 pages");
  });

  test("--http on surface: custom, render off, page count kept", async () => {
    await runAudit(["--level", "surface", "--http"]);
    expect(line("Level")).toBe("custom (surface + render off) · max 100 pages");
  });

  test("--probe passive on surface is custom", async () => {
    await runAudit(["--level", "surface", "--probe", "passive"]);
    expect(line("Level")).toBe(
      "custom (surface + probe passive) · max 100 pages"
    );
    expect(runs[0]?.probe?.level).toBe("passive");
  });

  test("config values are overrides too", async () => {
    await runAudit(
      ["--level", "surface"],
      '[external_links]\nenabled = false\n\n[security]\nprobe = "passive"\n'
    );
    expect(line("Level")).toBe(
      "custom (surface + external_links off, probe passive) · max 100 pages"
    );
    expect(runs[0]?.externalLinksEnabled).toBe(false);
  });

  test("the defaults `squirrel init` writes do not make a level custom", async () => {
    // init stamps every schema default into squirrel.toml, including
    // max_pages = 100 and external links on: those read as unset.
    await runAudit(
      ["--level", "quick"],
      "[crawler]\nmax_pages = 100\n\n[external_links]\nenabled = true\n"
    );
    expect(line("Level")).toBe("quick · max 25 pages");
    expect(runs[0]?.externalLinksEnabled).toBe(false);
  });

  test("[crawler] coverage picks the level, and fast is quick there too", async () => {
    await runAudit([], '[crawler]\ncoverage = "fast"\n');
    expect(line("Level")).toBe("quick · max 25 pages");
    runs = [];
    output = [];
    await runAudit([], '[crawler]\ncoverage = "full"\n');
    expect(line("Level")).toBe("full · max 500 pages");
  });

  test("an unknown level is refused before any request, naming the levels", async () => {
    await runAudit(["--level", "turbo"]);
    expect(process.exitCode).toBe(1);
    expect(
      output.some((l) =>
        l.includes(
          "unknown audit level 'turbo'. Valid: quick, surface, full (fast is accepted as quick)."
        )
      )
    ).toBe(true);
    expect(requested).toEqual([]);
    expect(runs).toEqual([]);
  });

  test("--level and -C naming different levels is refused", async () => {
    await runAudit(["--level", "full", "-C", "quick"]);
    expect(process.exitCode).toBe(1);
    expect(
      output.some((l) =>
        l.includes("--level full and --coverage quick name different levels")
      )
    ).toBe(true);
    expect(runs).toEqual([]);
  });

  test("an unknown [crawler] coverage fails config loading with the levels", async () => {
    await runAudit([], '[crawler]\ncoverage = "deep"\n');
    const text = output.join("\n");
    expect(text).toContain("Failed to load config file");
    expect(text).toContain("'quick' | 'surface' | 'full', received 'deep'");
    expect(runs).toEqual([]);
  });

  test("the JSON report carries the level, what it was based on and what changed", async () => {
    const out = join(scratch, "report.json");
    await runAudit(["--level", "surface", "-m", "7", "-f", "json", "-o", out]);
    expect(process.exitCode).toBe(0);
    const json = JSON.parse(readFileSync(out, "utf8")) as {
      meta: {
        maxPages?: number;
        auditLevel?: { level: string; basedOn: string; changes: string[] };
      };
    };
    // Existing fields keep their names.
    expect(json.meta.maxPages).toBe(7);
    expect(json.meta.auditLevel).toMatchObject({
      level: "custom",
      basedOn: "surface",
      changes: ["pages"],
    });
  });
});
