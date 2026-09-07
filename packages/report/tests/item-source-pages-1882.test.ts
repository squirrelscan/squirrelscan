// #1882: an item a PER-PAGE check reports lives on that page. The grouper
// stamps the page as the item's source so `affectedPages` attributes the item
// to the page (case 2) instead of counting a bare-URL item id as a page of its
// own (case 3). Before this, one CDN script flagged on 3 pages rendered as
// "(7 pages)" — 3 pages + 4 scripts — while the API's per-locator grouping
// counted 3, so the two surfaces disagreed on the same finding.
import { describe, expect, test } from "bun:test";
import { PUBLISH_LIMITS } from "@squirrelscan/core-contracts/limits";

import { affectedPages } from "../src/affected-pages";
import { groupIssuesByCategory } from "../src/grouping";
import type { ReportRuleResult } from "../src/types";

const meta = {
  id: "security/sri",
  name: "SRI",
  description: "d",
  category: "security",
  scope: "page",
  severity: "error",
  weight: 10,
} as const;

const pages = ["https://s.test/", "https://s.test/a", "https://s.test/b"];
const GLOBAL = "https://cdn.test/global.js";

function grouped(results: Record<string, ReportRuleResult>) {
  return groupIssuesByCategory(results)
    .flatMap((c) => c.rules)
    .flatMap((r) => r.checks);
}

describe("per-page check items are attributed to their page (#1882)", () => {
  const results = {
    "security/sri": {
      meta,
      checks: pages.map((pageUrl, i) => ({
        name: "cross-origin",
        status: "fail",
        message: `${i + 2} cross-origin resources without SRI`,
        pageUrl,
        items: [{ id: GLOBAL, label: "script" }, { id: `https://cdn.test/p${i}.js` }],
      })),
    },
  } as unknown as Record<string, ReportRuleResult>;

  test("the report's page count is the page union, not pages + script URLs", () => {
    const [check] = grouped(results);
    expect(check!.pages).toEqual([...pages].sort());
    expect(affectedPages(check!).count).toBe(3);
  });

  test("a shared item keeps ONE row and gains every page it was seen on as a source", () => {
    const [check] = grouped(results);
    const ids = check!.items!.map((i) => i.id);
    expect(ids).toEqual([
      GLOBAL,
      "https://cdn.test/p0.js",
      "https://cdn.test/p1.js",
      "https://cdn.test/p2.js",
    ]);
    expect(check!.items![0]!.sourcePages).toEqual([...pages].sort());
    expect(check!.items![1]!.sourcePages).toEqual([pages[0]]);
    // The label from the first sighting survives the merge.
    expect(check!.items![0]!.label).toBe("script");
  });

  test("a single un-merged check is attributed the same way (no single-vs-merged skew)", () => {
    const [check] = grouped({
      "security/sri": { meta, checks: [results["security/sri"]!.checks[0]!] },
    } as unknown as Record<string, ReportRuleResult>);
    expect(affectedPages(check!).count).toBe(1);
    expect(check!.items![0]!.sourcePages).toEqual([pages[0]]);
  });

  test("an item that already names its sources keeps them and adds the page once", () => {
    const [check] = grouped({
      "security/sri": {
        meta,
        checks: [
          {
            name: "c",
            status: "fail",
            message: "m",
            pageUrl: pages[0],
            items: [{ id: GLOBAL, sourcePages: ["https://s.test/z", pages[0]] }],
          },
          {
            name: "c",
            status: "fail",
            message: "m",
            pageUrl: pages[0],
            items: [{ id: GLOBAL }],
          },
        ],
      },
    } as unknown as Record<string, ReportRuleResult>);
    expect(check!.items![0]!.sourcePages).toEqual(["https://s.test/z", pages[0]]);
    expect(affectedPages(check!).count).toBe(2);
  });

  test("site-scope checks (no pageUrl) keep case 3: a URL item IS a page", () => {
    const [check] = grouped({
      "seo/sitemap": {
        meta: { ...meta, id: "seo/sitemap", scope: "site" },
        checks: [
          {
            name: "4xx",
            status: "fail",
            message: "2 sitemap URLs return 4xx",
            items: [{ id: "https://s.test/gone" }, { id: "https://s.test/gone2" }],
          },
        ],
      },
    } as unknown as Record<string, ReportRuleResult>);
    expect(check!.items!.every((i) => i.sourcePages === undefined)).toBe(true);
    expect(affectedPages(check!).count).toBe(2);
  });

  test("a carried per-page check's resource items are not carried PAGES", () => {
    const [check] = grouped({
      "security/sri": {
        meta,
        checks: [
          {
            name: "c",
            status: "fail",
            message: "m",
            pageUrl: pages[0],
            provenance: "carried",
            lastSeenAt: 5,
            items: [{ id: GLOBAL }],
          },
        ],
      },
    } as unknown as Record<string, ReportRuleResult>);
    // Was "2 of 1 pages carried": the CDN URL counted as a carried page.
    expect(check!.carriedPages).toEqual([pages[0]]);
    expect(affectedPages(check!).count).toBe(1);
  });

  test("source pages per item are capped like the publish fold; the page union is not", () => {
    const n = PUBLISH_LIMITS.maxSourcePagesPerItemPublish + 5;
    const many = Array.from(
      { length: n },
      (_, i) => `https://s.test/p${String(i).padStart(2, "0")}`,
    );
    const [check] = grouped({
      "security/sri": {
        meta,
        checks: many.map((pageUrl) => ({
          name: "c",
          status: "fail",
          message: "m",
          pageUrl,
          items: [{ id: GLOBAL }],
        })),
      },
    } as unknown as Record<string, ReportRuleResult>);
    expect(check!.items![0]!.sourcePages).toHaveLength(PUBLISH_LIMITS.maxSourcePagesPerItemPublish);
    expect(affectedPages(check!).count).toBe(n);
  });
});
