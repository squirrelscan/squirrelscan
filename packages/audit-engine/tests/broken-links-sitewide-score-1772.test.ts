// #1772: splitting a site-wide broken link into its own check does not change what it costs. One footer link
// was one failing `broken-links` check; it is now one failing `broken-links-sitewide` check and no pass row beside
// it. The rule's score is the same before and after, and a link is in exactly one of the two checks, so it is not
// charged twice.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { loadAllRules, type Rule, type RuleMeta, type RuleRunResult } from "@squirrelscan/rules";

import { calculateHealthScore } from "../src/scoring";

const brokenLinksRule = loadAllRules().get("links/broken-links") as Rule;
const BASE = "https://example.com";
const gone = `${BASE}/gone`;

function checksFor(sections: Array<string | undefined>): CheckResult[] {
  const pages = [
    ...sections.map((section, i) => ({
      url: i === 0 ? `${BASE}/` : `${BASE}/p/${i}`,
      statusCode: 200,
      parsed: { links: [{ url: gone, text: "", isInternal: true, section }] },
    })),
    { url: gone, statusCode: 404, parsed: { links: [] } },
  ];
  const ctx = {
    page: { url: `${BASE}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {},
    site: { baseUrl: BASE, robotsTxt: null, sitemaps: null, pages },
    options: {},
  };
  return (brokenLinksRule.run(ctx as never) as { checks: CheckResult[] }).checks;
}

function score(checks: CheckResult[], meta: RuleMeta = brokenLinksRule.meta) {
  const results = new Map<string, RuleRunResult>([[meta.id, { meta, checks }]]);
  return calculateHealthScore({ results });
}

describe("the score for one footer link before and after the split (#1772)", () => {
  // Before: a single failing check under the old name, one item.
  const before = score([
    {
      name: "broken-links",
      status: "fail",
      message: "1 broken internal link(s) (4xx/5xx)",
      items: [{ id: gone, label: `${gone} (404)` }],
    },
  ]);
  // After: the real rule on 50 pages with the link in every footer.
  const after = checksFor(Array.from({ length: 50 }, () => "footer"));

  test("the rule now emits one failing site-wide check and no pass row beside it", () => {
    expect(after.map((c) => `${c.name}:${c.status}`)).toEqual(["broken-links-sitewide:fail"]);
  });

  test("the score is the same as the single failing check it replaces", () => {
    expect(score(after).overall).toBe(before.overall);
  });
});
