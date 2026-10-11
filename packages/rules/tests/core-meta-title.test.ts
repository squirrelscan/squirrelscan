// core/meta-title — measure the title as displayed, pub#658.
//
// Themes that indent `<title>` across lines (Shopware, Shopify) were reported
// `Title too long` on the raw source: motorroller.de measured 83 characters for
// a title a browser shows as 50. The rule now collapses runs of ASCII
// whitespace to one space and trims, as `document.title` does, before it
// measures, and reports that text.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { metaTitleRule } from "../src/core/meta-title";
import type { ParsedPage, RuleContext } from "../src/types";

const URL = "https://example.com/tret-und-kinderroller/";

function run(titleSource: string, options: Record<string, unknown> = {}): CheckResult[] {
  const html =
    `<!doctype html><html lang="de"><head>\n<meta charset="utf-8">\n` +
    `<title>${titleSource}</title>\n</head><body><h1>Roller</h1></body></html>`;
  const ctx: RuleContext = {
    page: { url: URL, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, URL) as ParsedPage,
    options,
  };
  return metaTitleRule.run(ctx).checks as CheckResult[];
}

function titleCheck(checks: CheckResult[]): CheckResult {
  const check = checks.find((c) => c.name === "meta-title");
  expect(check).toBeDefined();
  return check!;
}

// The issue's fixture: indented across lines, 83 raw characters, 50 displayed.
const PADDED =
  "\n                                        Tret- &amp; Kinderroller kaufen - Preiswert\n                                        ";
const CONTROL = "Tret- &amp; Kinderroller kaufen - Preiswert";

describe("core/meta-title measures the displayed title (pub#658)", () => {
  test("the padded fixture and the control give the same result", () => {
    const padded = run(PADDED);
    const control = run(CONTROL);
    expect(padded).toEqual(control);
    const check = titleCheck(padded);
    expect(check.status).toBe("pass");
    expect(check.value).toBe("Tret- & Kinderroller kaufen - Preiswert");
  });

  test("tabs, newlines and repeated spaces inside the title collapse to one space", () => {
    const check = titleCheck(run("\t Tret-\t\t&amp;\r\n\n  Kinderroller   kaufen -\fPreiswert \n"));
    expect(check.status).toBe("pass");
    expect(check.value).toBe("Tret- & Kinderroller kaufen - Preiswert");
  });

  test("a title over max_length once collapsed still warns, with the collapsed text in value and label", () => {
    const words = "Kinderroller kaufen Tretroller Scooter Zubehör Ersatzteile Versand Preiswert Angebot";
    const check = titleCheck(run(`\n        ${words.split(" ").join("\n        ")}\n    `));
    expect(words.length).toBeGreaterThan(75);
    expect(check.status).toBe("warn");
    expect(check.message).toBe("Title too long");
    expect(check.value).toBe(words);
    const label = String(check.items?.[0]?.label);
    expect(label).toBe(`${words.slice(0, 50)} (${words.length} chars)`);
    expect(label).not.toContain("\n");
  });

  test("a short title padded past min_length still warns as too short", () => {
    const check = titleCheck(run(`\n${" ".repeat(40)}Roller\n${" ".repeat(40)}`));
    expect(check.status).toBe("warn");
    expect(check.message).toBe("Title too short");
    expect(check.value).toBe("Roller");
    expect(check.items?.[0]?.label).toBe("Roller (6 chars)");
  });

  test("the limits apply to the collapsed length", () => {
    // 20 displayed characters, 60 raw: inside 10-30 only once collapsed.
    const check = titleCheck(run(`${" ".repeat(20)}Kinderroller kaufen!${" ".repeat(20)}`, {
      min_length: 10,
      max_length: 30,
    }));
    expect(check.status).toBe("pass");
    expect(check.value).toBe("Kinderroller kaufen!");
  });

  test("a whitespace-only title is missing, like an empty one", () => {
    const blank = run("\n      \t  \n");
    expect(blank.map((c) => [c.name, c.status])).toEqual([
      ["meta-title", "fail"],
      ["document-title", "fail"],
    ]);
    expect(blank).toEqual(run(""));
  });

  test("a no-break space is part of the displayed title, not collapsed", () => {
    const check = titleCheck(run("Tret-&nbsp;&nbsp;&amp; Kinderroller kaufen - Preiswert"));
    expect(check.value).toBe("Tret-  & Kinderroller kaufen - Preiswert");
  });
});
