// perf/source-maps (#2341): the rule now records WHICH maps it saw, so the
// report stage can say "one build ships these, on N pages" instead of repeating
// the same warn per page.
//
// The evidence is additive and nothing else may move. Detection, status, message
// and the bounded 10-item sample feed the scorer, and the issue makes parity a
// hard requirement — so the first block here compares the whole check object
// against its own pre-change shape rather than spot-checking a field.

import { describe, expect, test } from "bun:test";
import { parseHTML } from "@squirrelscan/parser/dom";

import { sourceMapsRule } from "../src/performance/source-maps";
import { unfoldAggregateCheck, foldOverflowChecks, DEFAULT_FOLD_LIMITS } from "../src/fold";
import type { CheckResult, ParsedPage, RuleContext, SiteData } from "../src/types";

function run(
  body: string,
  opts: { url?: string; headers?: Record<string, string>; site?: SiteData } = {},
): CheckResult[] {
  const url = opts.url ?? "https://example.com/about";
  const html = `<html><head><title>t</title></head><body>${body}</body></html>`;
  const { document } = parseHTML(html);
  const ctx: RuleContext = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: opts.headers ?? {} },
    parsed: { document } as unknown as ParsedPage,
    ...(opts.site ? { site: opts.site } : {}),
    options: {},
  };
  return sourceMapsRule.run(ctx).checks;
}

/** An inline script carrying N distinct `sourceMappingURL` comments. */
function bundleScript(count: number): string {
  const lines = Array.from({ length: count }, (_, i) => `//# sourceMappingURL=/a/m${i}.js.map`);
  return `<script>${lines.join("\n")}</script>`;
}

describe("parity: the check itself does not move", () => {
  test("a page with maps emits the same name, status, message, items and details", () => {
    const [check] = run(bundleScript(2));
    // Byte-for-byte what this rule emitted before the evidence field existed.
    const { siteResourceOccurrences: _evidence, ...legacy } = check as CheckResult;
    expect(legacy).toEqual({
      name: "source-maps-exposed",
      status: "warn",
      message: "2 potential source map(s) detected",
      items: [
        { id: "https://example.com/a/m0.js.map", label: "from inline script" },
        { id: "https://example.com/a/m1.js.map", label: "from inline script" },
      ],
      details: {
        note: "Source maps may expose original source code. Verify these URLs are not publicly accessible.",
      },
    });
  });

  test("the 10-item cap and its `additional` count are untouched", () => {
    const [check] = run(bundleScript(14));
    expect(check!.items).toHaveLength(10);
    expect(check!.details!.additional).toBe(4);
    expect(check!.message).toBe("14 potential source map(s) detected");
  });

  test("a clean page still passes, and carries no evidence", () => {
    const [check] = run("<script>console.log(1)</script>");
    expect(check!.name).toBe("source-maps");
    expect(check!.status).toBe("pass");
    expect((check as CheckResult).siteResourceOccurrences).toBeUndefined();
  });

  test("the inline-map check is unchanged and ungrouped", () => {
    const checks = run('<script>//# sourceMappingURL=data:application/json;base64,e30=</script>');
    const inline = checks.find((c) => c.name === "source-maps-inline")!;
    expect(inline.status).toBe("warn");
    expect((inline as CheckResult).siteResourceOccurrences).toBeUndefined();
  });
});

describe("the evidence itself", () => {
  test("carries every map, past the item cap", () => {
    const [check] = run(bundleScript(14));
    const evidence = (check as CheckResult).siteResourceOccurrences!;
    // 14, not the 10 `items` shows: a sampled set would make page membership a
    // guess, which is the truncation this feature exists to remove.
    expect(evidence).toHaveLength(14);
    expect(evidence.map((o) => o.key)).toContain("https://example.com/a/m13.js.map");
  });

  test("records the page, the reference and the origin", () => {
    const [check] = run(bundleScript(1), { url: "https://example.com/pricing" });
    const [first] = (check as CheckResult).siteResourceOccurrences!;
    expect(first).toEqual({
      kind: "source-map",
      key: "https://example.com/a/m0.js.map",
      pageUrl: "https://example.com/pricing",
      source: "inline script",
      siteOrigin: "https://example.com",
    });
  });

  test("a map reached twice on one page is one resource", () => {
    // The same URL from a `SourceMap` header and an inline comment. The rule
    // already dedupes its items on URL; the evidence must agree, or the unit
    // would count one artifact twice.
    const [check] = run("<script>//# sourceMappingURL=/a/m0.js.map</script>", {
      headers: { sourcemap: "/a/m0.js.map" },
    });
    expect((check as CheckResult).siteResourceOccurrences).toHaveLength(1);
    expect(check!.items).toHaveLength(1);
  });
});

describe("fold round-trip", () => {
  const pages = ["https://example.com/", "https://example.com/a", "https://example.com/b"];
  const perPage: CheckResult[] = pages.map(
    (page) =>
      ({
        name: "source-maps-exposed",
        status: "warn",
        message: "2 potential source map(s) detected",
        pageUrl: page,
        items: [{ id: "https://example.com/a/m0.js.map" }],
        siteResourceOccurrences: [
          {
            kind: "source-map" as const,
            key: "https://example.com/a/m0.js.map",
            pageUrl: page,
            source: "inline script",
            siteOrigin: "https://example.com",
          },
        ],
      }) as unknown as CheckResult,
  );

  test("the fold keeps every occurrence, uncapped", () => {
    const folded = foldOverflowChecks(perPage, { ...DEFAULT_FOLD_LIMITS, maxChecks: 1 });
    const aggregate = folded.find((c) => c.details?.aggregated)!;
    expect(aggregate.siteResourceOccurrences).toHaveLength(3);
  });

  test("unfolding puts each occurrence back on its own page and no other", () => {
    const folded = foldOverflowChecks(perPage, { ...DEFAULT_FOLD_LIMITS, maxChecks: 1 });
    const aggregate = folded.find((c) => c.details?.aggregated)!;
    const rows = unfoldAggregateCheck(aggregate);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const evidence = row.siteResourceOccurrences ?? [];
      expect(evidence).toHaveLength(1);
      expect(evidence[0]!.pageUrl).toBe(row.pageUrl!);
    }
  });

  test("re-folding the unfolded rows reproduces the same evidence", () => {
    const folded = foldOverflowChecks(perPage, { ...DEFAULT_FOLD_LIMITS, maxChecks: 1 });
    const aggregate = folded.find((c) => c.details?.aggregated)!;
    const again = foldOverflowChecks(unfoldAggregateCheck(aggregate), {
      ...DEFAULT_FOLD_LIMITS,
      maxChecks: 1,
    }).find((c) => c.details?.aggregated)!;
    expect(again.siteResourceOccurrences).toEqual(aggregate.siteResourceOccurrences);
  });
});
