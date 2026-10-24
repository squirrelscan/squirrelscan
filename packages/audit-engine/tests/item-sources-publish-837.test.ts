// pub#837: a link item's per-source detail (`sources`) is clipped with its `sourcePages` on every
// publish path, so a target linked from every page of a big site does not carry one entry per page
// past the cap that keeps its source list short.

import { describe, expect, test } from "bun:test";

import type { CheckItem, CheckResult } from "@squirrelscan/core-contracts";
import { alignItemSources } from "@squirrelscan/core-contracts/item-sources";
import { PUBLISH_LIMITS } from "@squirrelscan/core-contracts/limits";
import { sampleChecksForPublish } from "@squirrelscan/rules/fold";

import { capReportForPublish, type CappableReport } from "../src/publish-cap";

const SITE = "https://example.com";
const page = (k: number) => `${SITE}/p${String(k).padStart(3, "0")}`;

function brokenLink(pages: number): CheckResult {
  const sourcePages = Array.from({ length: pages }, (_, k) => page(k));
  return {
    name: "broken-links",
    status: "fail",
    message: "1 broken internal link(s) (4xx/5xx)",
    items: [
      {
        id: `${SITE}/gone`,
        label: `${SITE}/gone (404), linked in the footer`,
        sourcePages,
        sources: sourcePages.map((p, k) => ({
          page: p,
          links: k % 2 === 0 ? 2 : 1,
          sections: { footer: 1 },
        })),
        meta: { statusCode: 404, linkedFrom: pages },
      },
    ],
  };
}

/** Every source entry names a page the item still lists. */
const expectAligned = (item: CheckItem) => {
  for (const source of item.sources ?? []) expect(item.sourcePages).toContain(source.page);
};

describe("per-source detail follows the publish caps (pub#837)", () => {
  test("alignItemSources keeps entries for listed pages only, and is a no-op when aligned", () => {
    const item = brokenLink(3).items![0]!;
    expect(alignItemSources(item)).toBe(item);
    const clipped = alignItemSources({ ...item, sourcePages: [page(2), page(0)] });
    expect(clipped.sources!.map((s) => s.page)).toEqual([page(0), page(2)]);
    expect(alignItemSources({ ...item, sourcePages: [] })).not.toHaveProperty("sources");
  });

  test("the publish sample clips sources with sourcePages", () => {
    const [check] = sampleChecksForPublish([brokenLink(40)]);
    const item = check!.items![0]!;
    expect(item.sourcePages).toHaveLength(PUBLISH_LIMITS.maxSourcePagesPerItemPublish);
    expect(item.sources).toHaveLength(PUBLISH_LIMITS.maxSourcePagesPerItemPublish);
    expectAligned(item);
  });

  test("the publish cap clips sources with sourcePages", () => {
    const report: CappableReport & Record<string, unknown> = {
      ruleResults: {
        "links/broken-links": {
          meta: {
            id: "links/broken-links",
            name: "Broken Links",
            description: "d",
            category: "links",
            scope: "site",
            severity: "error",
            weight: 7,
          },
          checks: [brokenLink(40)],
        },
      },
    };
    const item = capReportForPublish(report).ruleResults["links/broken-links"]!.checks[0]!.items![0]!;
    expect(item.sourcePages!.length).toBeLessThan(40);
    expect(item.sources).toHaveLength(item.sourcePages!.length);
    expectAligned(item);
  });
});
