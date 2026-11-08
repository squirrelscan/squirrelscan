// a11y/table-duplicate-name counts only tables in the accessibility tree (#1637).
//
// Two "Size" tables in separate closed native dialogs used to be reported as a
// duplicate of each other, although neither is in a screen reader's table list
// until its dialog opens. Tables out of the tree are now counted as
// `hiddenTables`, and a table a style may hide but squirrel cannot settle is
// reported as unconfirmed rather than as a duplicate.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { tableDuplicateNameRule } from "../src/a11y/table-duplicate-name";
import type { CheckResult, RuleContext } from "../src/types";

function run(body: string, head = ""): CheckResult[] {
  const html = `<!doctype html><html lang="en"><head><title>t</title>${head}</head><body><h1>Repro</h1>${body}</body></html>`;
  const url = "https://example.com/";
  const ctx = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    options: {},
  } as unknown as RuleContext;
  const result = tableDuplicateNameRule.run(ctx);
  if (result instanceof Promise) throw new Error("table-duplicate-name is async");
  return result.checks;
}

const table = (name: string, cell = "x") =>
  `<table aria-label="${name}"><tr><td>${cell}</td></tr></table>`;

function warn(checks: CheckResult[]): CheckResult | undefined {
  return checks.find((c) => c.name === "table-duplicate-name" && c.status === "warn");
}

describe("#1637 tables out of the accessibility tree", () => {
  test("/tables-hidden: two Size tables in separate closed dialogs are not duplicates", () => {
    const checks = run(
      `${table("Content", "Main")}<dialog>${table("Size", "A")}</dialog><dialog>${table("Size", "B")}</dialog>`
    );
    expect(warn(checks)).toBeUndefined();
    expect(checks.some((c) => c.status === "warn")).toBe(false);
    const info = checks.find((c) => c.name === "table-duplicate-name");
    expect(info?.status).toBe("info");
    expect(info?.message).toBe("Only one table found");
    expect(info?.details).toEqual({ hiddenTables: 2 });
  });

  test("/tables-visible: two exposed Size tables still warn", () => {
    const checks = run(`${table("Content")}${table("Size", "A")}${table("Size", "B")}`);
    const row = warn(checks);
    expect(row?.message).toBe("1 duplicate table name(s) found");
    expect(row?.items).toEqual([{ id: '"size" (2 tables)' }]);
  });

  test("an open dialog's table is exposed and still collides", () => {
    const row = warn(run(`${table("Size", "A")}<dialog open>${table("Size", "B")}</dialog>`));
    expect(row?.items).toEqual([{ id: '"size" (2 tables)' }]);
  });

  test.each([
    ["hidden", `<div hidden>`, `</div>`],
    ["inert", `<div inert>`, `</div>`],
    ["inline display:none", `<div style="display:none">`, `</div>`],
    ["aria-hidden", `<div aria-hidden="true">`, `</div>`],
  ])("a table under a %s ancestor is excluded and counted", (_label, open, close) => {
    const checks = run(`${table("Size", "A")}${table("Other")}${open}${table("Size", "B")}${close}`);
    expect(warn(checks)).toBeUndefined();
    const pass = checks.find((c) => c.name === "table-duplicate-name");
    expect(pass?.status).toBe("pass");
    expect(pass?.details).toEqual({ tablesChecked: 2, hiddenTables: 1 });
  });

  test('hidden="until-found" keeps the table exposed', () => {
    const row = warn(run(`${table("Size", "A")}<div hidden="until-found">${table("Size", "B")}</div>`));
    expect(row?.items).toEqual([{ id: '"size" (2 tables)' }]);
  });

  test("a hidden duplicate is counted on the warn row of an exposed one", () => {
    const row = warn(
      run(`${table("Size", "A")}${table("Size", "B")}<dialog>${table("Size", "C")}</dialog>`)
    );
    expect(row?.items).toEqual([{ id: '"size" (2 tables)' }]);
    expect(row?.details).toMatchObject({ hiddenTables: 1 });
  });

  test("a table a style may hide is reported as an unconfirmed duplicate, not a duplicate", () => {
    const checks = run(
      `${table("Size", "A")}<div class="tab">${table("Size", "B")}</div>`,
      `<link rel="stylesheet" href="/site.css"><style>.tab { display: none }</style>`
    );
    expect(warn(checks)).toBeUndefined();
    const row = checks.find((c) => c.name === "table-duplicate-name-unconfirmed");
    expect(row?.status).toBe("warn");
    expect(row?.message).toBe("1 duplicate table name(s) may be hidden by a style (unconfirmed)");
    expect(row?.items?.[0]).toMatchObject({ id: '"size" (2 tables)' });
    expect(checks.some((c) => c.status === "pass")).toBe(false);
  });

  test("tables without names count only exposed tables", () => {
    const checks = run(
      `${table("Content")}<dialog><table><tr><td>A</td></tr></table></dialog>`
    );
    expect(checks.find((c) => c.name === "tables-without-names")).toBeUndefined();
  });
});
