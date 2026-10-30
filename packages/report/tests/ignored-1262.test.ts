// What a report says about `[[ignore]]` waivers (#1262): the summary, the lines
// every renderer prints, and the guard that a hostile stored value cannot inject.

import { describe, expect, test } from "bun:test";
import { XMLValidator } from "fast-xml-parser";

import type { CheckResult } from "@squirrelscan/core-contracts";

import { ignoredEntryLines, ignoredLine, safeIgnored, summarizeIgnored, unusedIgnoreEntries } from "../src/ignored";
import { renderHtml } from "../src/output/html";
import { renderJson } from "../src/output/json";
import { renderLlm } from "../src/output/llm";
import { renderMarkdown } from "../src/output/markdown";
import { renderText } from "../src/output/text";
import { renderXml } from "../src/output/xml";
import type { AuditReport } from "../src/types";

const ESC = String.fromCharCode(27);

const checks = (ignored: unknown): CheckResult[] => [
  { name: "c", status: "warn", message: "m", details: { ignored } },
];

describe("summarizeIgnored", () => {
  test("adds up what the engine recorded per rule and per entry, and keeps entries that matched nothing", () => {
    const summary = summarizeIgnored(
      [
        ["security/cookie-flags", [...checks({ items: 2, entries: [0] }), ...checks({ items: 3, entries: [0] })]],
        ["core/meta-title", checks({ pages: 1, entries: [1] })],
        ["seo/other", [{ name: "x", status: "warn", message: "m" }]],
      ],
      { entries: [{ rule: "security/cookie-flags", reason: "Shopify" }, { rule: "core/*" }, { rule: "never/matches" }] },
    )!;
    expect(summary.items).toBe(5);
    expect(summary.pages).toBe(1);
    expect(summary.byRule).toEqual({ "security/cookie-flags": { items: 5, pages: 0 }, "core/meta-title": { items: 0, pages: 1 } });
    expect(summary.entries).toEqual([
      { index: 0, rule: "security/cookie-flags", reason: "Shopify", items: 5, pages: 0 },
      { index: 1, rule: "core/*", items: 0, pages: 1 },
      { index: 2, rule: "never/matches", items: 0, pages: 0 },
    ]);
  });

  test("is undefined when there are no entries and nothing was waived", () => {
    expect(summarizeIgnored([["r/x", checks(undefined)]], undefined)).toBeUndefined();
  });

  test("a --no-ignore run reports the table as disabled", () => {
    const summary = summarizeIgnored([], { entries: [{ rule: "r/x" }], disabled: true })!;
    expect(summary.disabled).toBe(true);
    expect(ignoredLine({ ignored: summary })).toContain("--no-ignore");
  });
});

const report = (ignored: unknown): AuditReport =>
  ({
    baseUrl: "https://example.com",
    timestamp: "2026-10-30T10:00:00.000Z",
    totalPages: 1,
    passed: 0,
    warnings: 0,
    failed: 0,
    ruleResults: {},
    ignored,
  }) as unknown as AuditReport;

const WAIVED = {
  items: 3,
  pages: 1,
  byRule: { "security/cookie-flags": { items: 3, pages: 0 }, "core/meta-title": { items: 0, pages: 1 } },
  entries: [
    { index: 0, rule: "security/cookie-flags", reason: "Shopify sets these", items: 3, pages: 0 },
    { index: 1, rule: "never/matches", items: 0, pages: 0 },
  ],
};

describe("the lines", () => {
  test("say how much was waived, on how many rules, and that one entry matched nothing", () => {
    const r = report(WAIVED);
    expect(ignoredLine(r)).toBe(
      "Ignored by squirrel.toml: 3 findings and 1 page on 2 rules (1 of 2 entries matched). Run with --no-ignore to see them.",
    );
    expect(unusedIgnoreEntries(r)).toHaveLength(1);
    expect(ignoredEntryLines(r)[0]).toBe("Ignore entry 1 (security/cookie-flags), Shopify sets these: 3 findings");
    expect(ignoredEntryLines(r)[1]).toBe("Ignore entry 2 (never/matches): matched nothing");
  });

  test("warn that carried findings may still include waived items when the list changed", () => {
    expect(ignoredLine(report({ ...WAIVED, carriedStale: true }))).toContain("carried from pages this run did not crawl");
  });

  test("a report with no summary has no line", () => {
    expect(ignoredLine(report(undefined))).toBeNull();
  });
});

describe("every renderer carries it", () => {
  const r = report(WAIVED);
  const renderers: Array<[string, (x: AuditReport) => string]> = [
    ["text", (x) => renderText(x)],
    ["markdown", (x) => renderMarkdown(x)],
    ["html", (x) => renderHtml(x, { reportId: "rep_1" })],
    ["llm", (x) => renderLlm(x)],
    ["xml", (x) => renderXml(x)],
  ];
  for (const [name, render] of renderers) {
    test(name, () => {
      const out = render(r);
      expect(out).toContain("Ignored by squirrel.toml");
    });
    test(`${name} says nothing for a config with no waivers`, () => {
      expect(render(report(undefined))).not.toContain("Ignored by squirrel.toml");
    });
  }

  test("text and markdown list the entry that matched nothing", () => {
    expect(renderText(r)).toContain("Ignore entry 2 (never/matches) matched nothing.");
    expect(renderMarkdown(r)).toContain("Ignore entry 2 \\(never/matches\\) matched nothing.");
  });

  test("json puts it in meta; llm and xml stay well-formed and name the entries", () => {
    const meta = (JSON.parse(renderJson(r)) as { meta: { ignored?: typeof WAIVED } }).meta;
    expect(meta.ignored?.items).toBe(3);
    expect(meta.ignored?.entries[0]?.reason).toBe("Shopify sets these");
    const llm = renderLlm(r);
    expect(llm).toContain('<entry index="1" rule="security/cookie-flags" items="3" pages="0" reason="Shopify sets these"/>');
    expect(XMLValidator.validate(llm)).toBe(true);
    expect(XMLValidator.validate(renderXml(r))).toBe(true);
  });
});

describe("a stored report is untrusted", () => {
  const hostile = {
    items: "9e99",
    pages: -4,
    disabled: "yes",
    byRule: { [`bad${ESC}[2J<rule>`]: { items: Number.NaN, pages: 2 } },
    entries: [{ index: "x", rule: `r/x${ESC}[2J"><script>`, reason: `why${ESC}[31m<b>`, items: 1e400, pages: 1 }],
  };

  test("fields are validated, strings stripped of control characters, counts made safe", () => {
    const s = safeIgnored(report(hostile))!;
    expect(s.items).toBe(0);
    expect(s.pages).toBe(0);
    expect(s.disabled).toBeUndefined();
    expect(JSON.stringify(s)).not.toContain(ESC);
  });

  test("no renderer emits an escape character or unescaped markup from it", () => {
    const r = report(hostile);
    for (const out of [renderText(r), renderLlm(r), renderXml(r), renderMarkdown(r)]) {
      expect(out).not.toContain(ESC);
    }
    expect(renderLlm(r)).not.toContain("<script>");
    expect(XMLValidator.validate(renderLlm(r))).toBe(true);
  });
});

describe("entries that ran over their work budget (review of #1333)", () => {
  test("the summary carries them, validated, and the line says findings were shown", () => {
    const summary = summarizeIgnored([], { entries: [{ rule: "a/b" }, { rule: "c/d" }], timedOut: [1, 7, -1, 1.5] });
    expect(summary?.timedOutEntries).toEqual([1]);
    const line = ignoredLine({ ignored: summary });
    expect(line).toContain("1 entry (2) timed out");
    expect(line).toContain("stopped matching");
    // a stored report is untrusted: junk is dropped
    expect(safeIgnored({ ignored: { ...summary!, timedOutEntries: ["x", 1, 99999] } as never })?.timedOutEntries).toEqual([1]);
  });
});

describe("the stored summary of an ignore list (review of #1333)", () => {
  test("carriedStale from the stored scope reaches a rebuilt report's summary", () => {
    expect(summarizeIgnored([], { entries: [{ rule: "a/b" }], carriedStale: true })?.carriedStale).toBe(true);
    expect(summarizeIgnored([], { entries: [{ rule: "a/b" }] })?.carriedStale).toBeUndefined();
  });

  test("timedOutEntries are deduplicated and bounded by the entry count", () => {
    const base = summarizeIgnored([], { entries: [{ rule: "a/b" }, { rule: "c/d" }] })!;
    const out = safeIgnored({ ignored: { ...base, timedOutEntries: [1, 1, 0, 5, 1] } as never });
    expect(out?.timedOutEntries).toEqual([1, 0]);
  });
});
