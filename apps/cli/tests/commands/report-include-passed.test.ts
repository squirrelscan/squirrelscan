// #1037 at the COMMAND boundary: `squirrel report --include-passed` refuses the
// modes that never render a report, and a report read with `--input` lists no
// passed rules, even when the file holds passing checks.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { report } from "@/cli/commands/report";

import { isolateSquirrelHome } from "../helpers/scratch-squirrel-home";

isolateSquirrelHome("squirrel-report-include-passed");

/** Thrown in place of process.exit, so a command exit cannot kill the runner. */
class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

const originalFetch = globalThis.fetch;
const originalExit = process.exit;
const originalLog = console.log;
const originalError = console.error;

let requested: string[] = [];
let stderr: string[] = [];
let dir: string;

beforeEach(() => {
  requested = [];
  stderr = [];
  console.log = () => {};
  console.error = (...args: unknown[]) => stderr.push(args.join(" "));
  globalThis.fetch = (async (input: string | URL | Request) => {
    requested.push(input.toString());
    return new Response("{}", { status: 500 });
  }) as unknown as typeof fetch;
  dir = mkdtempSync(join(tmpdir(), "squirrel-include-passed-test-"));
  process.exit = ((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as typeof process.exit;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.exit = originalExit;
  console.log = originalLog;
  console.error = originalError;
  rmSync(dir, { recursive: true, force: true });
});

/** A full report (not the slim JSON) whose one rule passed on two pages. */
function writeReport(): string {
  const path = join(dir, "report.json");
  writeFileSync(
    path,
    JSON.stringify({
      crawlId: "crawl-1",
      baseUrl: "https://example.com/",
      timestamp: "2026-10-01T00:00:00.000Z",
      totalPages: 2,
      failed: 0,
      warnings: 0,
      passed: 2,
      pages: [],
      siteChecks: [],
      ruleResults: {
        "core/canonical": {
          meta: {
            id: "core/canonical",
            name: "Canonical",
            description: "",
            category: "core",
            scope: "page",
            severity: "error",
            weight: 5,
          },
          checks: [
            {
              name: "c",
              status: "pass",
              message: "ok",
              pageUrl: "https://example.com/",
            },
            {
              name: "c",
              status: "pass",
              message: "ok",
              pageUrl: "https://example.com/a",
            },
          ],
        },
      },
    })
  );
  return path;
}

/** Runs the command; returns its exit code (0 when it returns normally). */
async function run(args: Record<string, unknown>): Promise<number> {
  try {
    // citty passes more than the command reads; only `args` is consulted.
    await report.run!({ args: { includePassed: true, ...args } } as never);
    return 0;
  } catch (err) {
    if (err instanceof ExitSignal) return err.code;
    throw err;
  }
}

describe("squirrel report --include-passed (#1037)", () => {
  test.each([
    [
      { publish: true },
      "--include-passed has no effect when combined with --publish",
    ],
    [{ diff: "abc" }, "--include-passed is not supported with --diff"],
    [
      { regressionSince: "abc" },
      "--include-passed is not supported with --diff",
    ],
    [{ list: true }, "--include-passed is not supported with --diff"],
  ])(
    "%o exits 1 before loading or sending anything",
    async (extra, message) => {
      expect(await run({ input: writeReport(), ...extra })).toBe(1);
      expect(stderr.join("\n")).toContain(message);
      expect(requested).toEqual([]);
    }
  );

  test("a report read with --input lists no passed rules, and says so", async () => {
    const out = join(dir, "out.json");
    expect(
      await run({ input: writeReport(), format: "json", output: out })
    ).toBe(0);
    const json = JSON.parse(readFileSync(out, "utf8")) as Record<
      string,
      unknown
    >;
    expect(json.passedRules).toBeUndefined();
    expect(stderr.join("\n")).toContain(
      "--include-passed lists no rules for a report read with --input"
    );
  });

  test("without the flag --input prints no note", async () => {
    const out = join(dir, "out.json");
    expect(
      await run({
        input: writeReport(),
        format: "json",
        output: out,
        includePassed: false,
      })
    ).toBe(0);
    expect(stderr.join("\n")).not.toContain("--include-passed");
  });
});
