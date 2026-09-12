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
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { report } from "@/cli/commands/report";

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
});
