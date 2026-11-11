// A site with one image missing width/height costs one warning, not two (#1768).

import { describe, expect, test } from "bun:test";

import { images, perf } from "@squirrelscan/rules";
import type { RuleMeta, RuleRunResult } from "@squirrelscan/rules";
import { parsePage } from "@squirrelscan/parser";

import { calculateHealthScore } from "../src/scoring";

const URL_ = "https://example.com/";

function score(html: string, rules: Array<{ meta: RuleMeta; run: typeof images.dimensionsRule.run }>) {
  const parsed = parsePage(html, URL_);
  const map = new Map<string, RuleRunResult>();
  for (const r of rules) {
    const page = { url: URL_, html, statusCode: 200, loadTime: 0, headers: {} };
    const { checks } = r.run({ page, parsed, options: {} } as never) as { checks: never[] };
    map.set(r.meta.id, {
      meta: r.meta,
      checks: (checks as Array<Record<string, unknown>>).map((c) => ({ ...c, pageUrl: URL_ })),
    } as RuleRunResult);
  }
  return calculateHealthScore({ results: map }).overall;
}

describe("one unsized image, one warning's weight", () => {
  const bad = `<html><body><img src="/a.png" alt="a"></body></html>`;
  const good = `<html><body><img src="/a.png" alt="a" width="1" height="1"></body></html>`;
  const dimensionsRule = images.dimensionsRule;
  const both = [dimensionsRule, perf.clsHintsRule];

  test("adding perf/cls-hints does not lower the score further", () => {
    expect(score(bad, both)).toBe(score(bad, [dimensionsRule]));
  });

  test("the unsized image does lower the score by the images/dimensions warning", () => {
    expect(score(bad, both)).toBeLessThan(score(good, both));
  });
});
