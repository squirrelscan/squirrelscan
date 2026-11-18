// repo#3094 at the COMMAND boundary: `squirrel report --input x.json -f markdown` renders the accessibility
// checklist from the rules' WCAG declarations (the JSON's rule metas carry none) and warns on stderr that
// passing checks are not read back; a bare `--wcag-checklist` prints the Markdown checklist.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { report, wcagChecklistKind } from "@/cli/commands/report";

import { isolateSquirrelHome } from "../helpers/scratch-squirrel-home";

isolateSquirrelHome("squirrel-report-wcag-checklist");

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

let stderr: string[] = [];
let dir: string;

beforeEach(() => {
  stderr = [];
  console.log = () => {};
  console.error = (...args: unknown[]) => stderr.push(args.join(" "));
  globalThis.fetch = (async () =>
    new Response("{}", { status: 500 })) as unknown as typeof fetch;
  dir = mkdtempSync(join(tmpdir(), "squirrel-wcag-checklist-test-"));
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

/** A report JSON as the engine writes it: rule metas without `wcag`, one contrast warning. */
function writeReport(status?: string): string {
  const path = join(dir, "report.json");
  writeFileSync(
    path,
    JSON.stringify({
      crawlId: "crawl-1",
      baseUrl: "https://example.com/",
      timestamp: "2026-11-17T00:00:00.000Z",
      totalPages: 1,
      failed: 0,
      warnings: 1,
      passed: 0,
      pages: [],
      siteChecks: [],
      ...(status ? { status } : {}),
      ruleResults: {
        "a11y/color-contrast": {
          meta: {
            id: "a11y/color-contrast",
            name: "Color contrast",
            description: "d",
            solution: "s",
            category: "a11y",
            scope: "page",
            severity: "warning",
            weight: 5,
          },
          checks: [
            {
              name: "contrast",
              status: "warn",
              message: "Low contrast",
              pageUrl: "https://example.com/",
            },
          ],
        },
      },
    })
  );
  return path;
}

async function run(args: Record<string, unknown>): Promise<number> {
  try {
    // citty passes more than the command reads; only `args` is consulted.
    await report.run!({ args } as never);
    return 0;
  } catch (err) {
    if (err instanceof ExitSignal) return err.code;
    throw err;
  }
}

const NOTE =
  "Accessibility checklist with --input: passing checks are not read back from a JSON file, so a rule with no finding reads as not run";

describe("squirrel report --input -f markdown (repo#3094)", () => {
  test("renders the checklist from the rules' declarations and warns on stderr", async () => {
    const out = join(dir, "report.md");
    expect(
      await run({ input: writeReport(), format: "markdown", output: out })
    ).toBe(0);
    const md = readFileSync(out, "utf8");
    expect(md).toContain(
      "| 1.4.3 Contrast (Minimum) | AA | Rules found an issue | a11y/color-contrast | none | a11y/color-contrast | [ ] Still needed |"
    );
    expect(md).toContain(
      "| 2.4.7 Focus Visible | AA | Rules did not run | none | a11y/focus-visible | none | [ ] Still needed |"
    );
    expect(stderr).toContain(NOTE);
  });

  test("a blocked audit has no checklist and no note", async () => {
    const out = join(dir, "report.md");
    expect(
      await run({
        input: writeReport("blocked"),
        format: "markdown",
        output: out,
      })
    ).toBe(0);
    expect(readFileSync(out, "utf8")).not.toContain("Accessibility checklist");
    expect(stderr).not.toContain(NOTE);
  });

  test("a non-markdown format prints no note", async () => {
    const out = join(dir, "report.json");
    expect(
      await run({ input: writeReport(), format: "json", output: out })
    ).toBe(0);
    expect(stderr).not.toContain(NOTE);
  });
});

describe("squirrel report --wcag-checklist (repo#3094)", () => {
  test("a bare flag prints the Markdown checklist", async () => {
    const out = join(dir, "checklist.md");
    expect(
      await run({ input: writeReport(), wcagChecklist: true, output: out })
    ).toBe(0);
    const md = readFileSync(out, "utf8");
    expect(md.startsWith("# Accessibility checklist\n")).toBe(true);
    expect(md).toContain(
      "| 1.4.3 Contrast (Minimum) | AA | Rules found an issue |"
    );
    expect(stderr).toContain(NOTE);
  });

  test("csv prints CSV; anything else exits 1 naming the value", async () => {
    const out = join(dir, "checklist.csv");
    expect(
      await run({ input: writeReport(), wcagChecklist: "CSV", output: out })
    ).toBe(0);
    expect(readFileSync(out, "utf8").split("\n")[0]).toBe(
      "criterion,title,level,rules_found,rules_ran,rules_not_run,rules_with_findings,manual_check,manual_result,reviewer_notes"
    );
    expect(await run({ input: writeReport(), wcagChecklist: "pdf" })).toBe(1);
    expect(stderr.join("\n")).toContain(
      '--wcag-checklist takes markdown or csv, got "pdf"'
    );
  });

  test.each(["failed", "blocked"])(
    "a %s audit gets no checklist: one stderr line, exit 1, no file",
    async (status) => {
      const out = join(dir, "checklist.md");
      expect(
        await run({
          input: writeReport(status),
          wcagChecklist: true,
          output: out,
        })
      ).toBe(1);
      expect(stderr).toEqual([
        "No accessibility checklist for a failed or blocked audit: no rules ran",
      ]);
      expect(existsSync(out)).toBe(false);
    }
  );

  test("wcagChecklistKind: bare means markdown", () => {
    expect(wcagChecklistKind(true)).toBe("markdown");
    expect(wcagChecklistKind("")).toBe("markdown");
    expect(wcagChecklistKind("Markdown")).toBe("markdown");
    expect(wcagChecklistKind("csv")).toBe("csv");
    expect(wcagChecklistKind("true")).toBeNull();
    expect(wcagChecklistKind(false)).toBeNull();
  });
});

describe("squirrel report --group with --wcag-checklist (repo#639)", () => {
  test("the group filter applies first: a11y is in seo, not performance", async () => {
    const out = join(dir, "checklist.md");
    expect(
      await run({
        input: writeReport(),
        group: "seo",
        wcagChecklist: true,
        output: out,
      })
    ).toBe(0);
    expect(readFileSync(out, "utf8")).toContain(
      "| 1.4.3 Contrast (Minimum) | AA | Rules found an issue |"
    );

    expect(
      await run({
        input: writeReport(),
        group: "performance",
        wcagChecklist: true,
        output: out,
      })
    ).toBe(0);
    expect(readFileSync(out, "utf8")).toContain(
      "| 1.4.3 Contrast (Minimum) | AA | Rules did not run |"
    );
  });

  test("an unknown group exits 1 before any checklist is written", async () => {
    const out = join(dir, "checklist.md");
    expect(
      await run({
        input: writeReport(),
        group: "bogus",
        wcagChecklist: true,
        output: out,
      })
    ).toBe(1);
    expect(stderr).toEqual([
      "Invalid group: bogus",
      "Valid groups: seo, performance, security, ai",
    ]);
    expect(existsSync(out)).toBe(false);
  });
});
