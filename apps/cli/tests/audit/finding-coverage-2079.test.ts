// #2079: a partial re-audit states, per rule check, the pages held with an open finding vs the pages
// it re-checked and left carried, and the requested page set. Driven through runSmartAudits.

import type { RuleMeta } from "@squirrelscan/rules";

import { flattenChecks, type RuleTally } from "@squirrelscan/audit-engine";
import { SQLiteStorage } from "@squirrelscan/crawler";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { runSmartAudits } from "@/audit/smart-audits";

const META: RuleMeta = {
  id: "core/meta-title",
  name: "Meta Title",
  description: "Page has a meta title",
  category: "core",
  scope: "page",
  severity: "error",
  weight: 5,
};
const SITE = "https://nutshop.test";
const url = (name: string) => `${SITE}/${name}`;
const RULE_META = new Map<string, RuleTally>([
  [META.id, { meta: META } as RuleTally],
]);
const run = <A>(eff: Effect.Effect<A, unknown, never>) =>
  Effect.runPromise(eff as Effect.Effect<A, never, never>);

function failing(pages: string[]) {
  return pages.flatMap((name) =>
    flattenChecks(url(name), META.id, [
      {
        name: META.name,
        status: "fail",
        message: "Missing meta title",
        pageUrl: url(name),
      },
    ])
  );
}

const ALL = ["a", "b", "c", "d"];

describe("report coverage for per-item resolution (#2079)", () => {
  test("first run has no findings coverage; a partial re-audit counts held, re-checked and carried", async () => {
    const store = new SQLiteStorage(":memory:");
    await run(store.init());
    const first = await run(
      runSmartAudits({
        storage: store,
        crawlId: "crawl-1",
        siteKey: SITE,
        freshFindings: failing(ALL),
        scoredPageUrls: ALL.map(url),
        ruleMeta: RULE_META,
        pages: ALL.map((n) => ({ normalizedUrl: url(n), status: 200 })),
      })
    );
    expect(first.coverage.findings).toBeUndefined();
    expect(first.coverage.requested).toBeUndefined();

    // Second run asked for a, b and c. a is fixed (clean), b still fails, c was not reached, d was
    // never requested.
    const second = await run(
      runSmartAudits({
        storage: store,
        crawlId: "crawl-2",
        siteKey: SITE,
        freshFindings: failing(["b"]),
        scoredPageUrls: [url("a"), url("b")],
        ruleMeta: RULE_META,
        pages: [url("a"), url("b")].map((u) => ({
          normalizedUrl: u,
          status: 200,
        })),
        requestedUrls: ["a", "b", "c"].map(url),
      })
    );
    expect(second.coverage.findings?.rows).toEqual([
      {
        ruleId: META.id,
        checkName: META.name,
        pagesHeld: 4,
        pagesRechecked: 2,
        pagesCarried: 2,
      },
    ]);
    expect(second.coverage.requested).toEqual({
      pages: 3,
      rechecked: 2,
      urls: ["a", "b", "c"].map(url),
    });
  });
});
