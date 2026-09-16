// #1841 at the COMMAND boundary. `squirrel report <id> --publish` is the other
// route a report reaches the cloud by, and it bypassed the audit command's
// gate entirely: it calls `publishReport` directly, and that controller has no
// host check of its own.
//
// The assertion here is deliberately about the WIRE, not about a helper: zero
// requests leave the process for a local or private-network target. A test that
// only checked a predicate would still pass if someone deleted the call site's
// gate, which is exactly the gap this closes.
//
// `--input` is a real, supported entry point (load a report from JSON), so this
// drives the actual command with no storage or network mocking beyond fetch.
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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { report } from "@/cli/commands/report";
import * as pathsModule from "@/self/paths";

// #2182: a SUCCESSFUL publish now stamps `first_publish_at` in the user
// settings (controllers/report/publish.ts), and this file mocks fetch into a
// 201 — so without isolation the "a public host still publishes" case below
// writes to the developer's REAL ~/.squirrel/settings.json. homedir() is fixed
// at process start in Bun, so $HOME cannot redirect it; spy on the paths
// module's getSettingsPath export instead, exactly as tests/self/settings.test.ts
// does and for the same reason.
const settingsHome = mkdtempSync(join(tmpdir(), "squirrel-publish-settings-"));
let restoreSettingsPath: () => void = () => {};

beforeAll(() => {
  const spy = spyOn(pathsModule, "getSettingsPath").mockImplementation(() =>
    join(settingsHome, "settings.json")
  );
  restoreSettingsPath = () => spy.mockRestore();
});

afterAll(() => {
  restoreSettingsPath();
  rmSync(settingsHome, { recursive: true, force: true });
});

/** Thrown in place of process.exit, so a command exit cannot kill the runner. */
class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

const originalFetch = globalThis.fetch;
const originalExit = process.exit;
const originalToken = process.env.SQUIRREL_API_TOKEN;

let requested: string[] = [];
let dir: string;

beforeEach(() => {
  requested = [];
  // Signed in, so a publish is genuinely possible and the host is the only
  // thing that can stop it.
  process.env.SQUIRREL_API_TOKEN = "sqcli_test_token";
  globalThis.fetch = (async (input: string | URL | Request) => {
    requested.push(input.toString());
    return new Response(
      JSON.stringify({
        id: "rep_1",
        url: "https://reports.test/rep_1",
        visibility: "public",
      }),
      { status: 201, headers: { "Content-Type": "application/json" } }
    );
  }) as unknown as typeof fetch;
  dir = mkdtempSync(join(tmpdir(), "squirrel-report-test-"));
  // File-local, restored below. The command ends a failed publish in
  // `safeExit(1)`, and an exit mid-test would take the whole runner with it —
  // so a regression here has to surface as a failing test, not a dead run.
  process.exit = ((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as typeof process.exit;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.exit = originalExit;
  if (originalToken === undefined) delete process.env.SQUIRREL_API_TOKEN;
  else process.env.SQUIRREL_API_TOKEN = originalToken;
  rmSync(dir, { recursive: true, force: true });
});

/** A report shaped like a real one: both the console renderer and the publish
 * transform read more than the fields this test cares about. */
function writeReport(baseUrl: string): string {
  const path = join(dir, "report.json");
  writeFileSync(
    path,
    JSON.stringify({
      crawlId: "crawl-1",
      baseUrl,
      timestamp: "2026-09-12T00:00:00.000Z",
      totalPages: 1,
      failed: 0,
      warnings: 0,
      passed: 1,
      pages: [],
      siteChecks: [],
      ruleResults: {},
      summary: {
        missingTitles: [],
        missingDescriptions: [],
        missingOgTags: [],
        missingTwitterCards: [],
        missingSchemas: [],
        missingAltText: [],
        multipleH1s: [],
        thinContentPages: [],
        urlIssues: [],
        redirectChains: [],
        securityIssues: [],
      },
      healthScore: {
        overall: 90,
        grade: "A",
        groups: [],
        categories: [],
        passed: 1,
        warnings: 0,
        failed: 0,
        total: 1,
      },
    })
  );
  return path;
}

async function runReport(baseUrl: string, extra: Record<string, unknown> = {}) {
  try {
    await report.run!({
      args: { input: writeReport(baseUrl), publish: true, ...extra },
      // citty passes more than the command reads; only `args` is consulted.
    } as never);
  } catch (err) {
    // A nonzero exit is a real failure of the thing under test, so surface it
    // as one rather than letting the sentinel read as an unrelated crash.
    if (err instanceof ExitSignal && err.code !== 0) {
      throw new Error(`the command exited ${err.code}; see the output above`, {
        cause: err,
      });
    }
    if (!(err instanceof ExitSignal)) throw err;
  }
}

describe("squirrel report --publish — a host no hosted runner can reach (#1841)", () => {
  test.each([
    ["http://localhost:3000/"],
    ["http://127.0.0.1:4321/"],
    ["http://192.168.1.10:8000/"],
    ["http://169.254.169.254/"],
    ["http://box.local/"],
    ["http://metadata.google.internal/"],
  ])("%s sends nothing to the API", async (baseUrl) => {
    await runReport(baseUrl);
    expect(requested).toEqual([]);
  });

  // Narrowness, on the same wire assertion: a real site must still publish, or
  // this gate would be a silent outage rather than a fix.
  test("a public host still publishes", async () => {
    await runReport("https://example.com/");
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.some((u) => u.includes("/v1/reports"))).toBe(true);
  });

  // #2182: the same run is the only place a successful publish can be observed
  // end to end, so it doubles as the wiring test for the first-publish stamp —
  // the flag the one-time "kept local" nudge reads to know it has nothing left
  // to say. Asserted on the SANDBOX file, which also proves the isolation above
  // is doing its job rather than the write landing in the real home.
  test("a successful publish stamps first_publish_at", async () => {
    rmSync(join(settingsHome, "settings.json"), { force: true });
    await runReport("https://example.com/");

    const saved = JSON.parse(
      readFileSync(join(settingsHome, "settings.json"), "utf8")
    ) as { first_publish_at?: string | null };
    expect(saved.first_publish_at).toBeString();
    expect(Number.isNaN(Date.parse(saved.first_publish_at!))).toBe(false);
  });

  // "never again after their first publish" has to survive a SECOND publish
  // without moving: the stamp is the FIRST one, not the latest.
  test("a later publish does not move the stamp", async () => {
    const path = join(settingsHome, "settings.json");
    rmSync(path, { force: true });
    // Publish once so the file on disk is a complete, schema-valid settings
    // object, then back-date the stamp by years. Comparing two same-run
    // timestamps would not do: both publishes can land in the same
    // millisecond, and an overwriting implementation would look correct.
    await runReport("https://example.com/");
    const settings = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    settings.first_publish_at = "2020-01-01T00:00:00.000Z";
    writeFileSync(path, JSON.stringify(settings));

    await runReport("https://example.com/");

    const after = JSON.parse(readFileSync(path, "utf8")) as {
      first_publish_at?: string;
    };
    expect(after.first_publish_at).toBe("2020-01-01T00:00:00.000Z");
  });
});
