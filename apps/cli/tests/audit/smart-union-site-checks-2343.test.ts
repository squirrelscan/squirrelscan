// repo#2343: the smart-audit union's fresh half is read back from
// `rule_results` instead of held in memory, and `rule_results` files every SITE
// check under `page_url = ''`. A site check that names a page of its own
// (integrity/known-malicious-url emits one per URL) therefore reads back with no
// `pageUrl`: it escapes the 404/410 filter and its scoring bucket merges with
// its siblings'. The report joins the in-memory site checks instead, so the
// union matches the one the rules phase used to hold.

import type { CheckResult } from "@squirrelscan/core-contracts";
import type { RuleRunResult } from "@squirrelscan/rules";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { SQLiteStorage } from "@/crawler/storage/sqlite";
import { joinSmartUnion, type SmartMergeOverride } from "@/reports/reconstruct";

const SITE = "https://example.com";
const CRAWL = "crawl-1";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(Effect.orDie(eff));
}

const fail = (name: string, pageUrl?: string): CheckResult => ({
  name,
  status: "fail",
  message: `${name} failed`,
  ...(pageUrl ? { pageUrl } : {}),
});

// A page rule and a site rule whose checks each name a page.
const PAGE_RULE = "core/meta-title";
const SITE_RULE = "integrity/known-malicious-url";
const pageChecks = new Map<string, CheckResult[]>([
  [`${SITE}/a`, [fail("title", `${SITE}/a`)]],
  [`${SITE}/gone`, [fail("title", `${SITE}/gone`)]],
]);
const siteChecks = new Map<string, CheckResult[]>([
  [
    SITE_RULE,
    [fail("malicious", `${SITE}/a`), fail("malicious", `${SITE}/gone`)],
  ],
]);
const removedUrls = new Set([`${SITE}/gone`]);

/** The union the rules phase held before #2343, built from the same checks. */
function inMemoryUnion(): Array<[string, CheckResult[]]> {
  const keep = (c: CheckResult) => !(c.pageUrl && removedUrls.has(c.pageUrl));
  return [
    [SITE_RULE, siteChecks.get(SITE_RULE)!.filter(keep)],
    [PAGE_RULE, [...pageChecks.values()].flat().filter(keep)],
  ];
}

async function storedFresh(): Promise<Map<string, CheckResult[]>> {
  const store = new SQLiteStorage(":memory:");
  await run(store.init());
  // Written the way the audit writes them: page rows batch by batch, then the
  // site pass under page_url ''.
  await run(
    store.saveRuleResultsBatch(
      CRAWL,
      new Map(
        [...pageChecks].map(([url, checks]) => [
          url,
          [{ ruleId: PAGE_RULE, checks }],
        ])
      )
    )
  );
  await run(
    store.saveRuleResultsBatch(
      CRAWL,
      new Map([
        ["", [{ ruleId: SITE_RULE, checks: siteChecks.get(SITE_RULE)! }]],
      ])
    )
  );
  const { byRuleId } = await run(store.getRuleResultsGrouped(CRAWL));
  await run(store.close());
  return byRuleId;
}

function override(withSite: boolean): SmartMergeOverride {
  return {
    carriedRuleResults: new Map<string, RuleRunResult>(),
    removedUrls,
    ...(withSite ? { freshSiteChecks: siteChecks } : {}),
    coverage: { auditedPages: 2, knownPages: 1, carriedFindings: 0 },
    carriedLastSeen: new Map(),
  };
}

const project = (union: Array<[string, CheckResult[]]>) =>
  new Map(
    union.map(([ruleId, checks]) => [
      ruleId,
      checks.map((c) => ({ name: c.name, pageUrl: c.pageUrl })),
    ])
  );

describe("smart union site checks (#2343)", () => {
  test("joins the in-memory site checks, so each keeps its own page", async () => {
    const joined = joinSmartUnion(await storedFresh(), override(true));
    expect(project(joined)).toEqual(project(inMemoryUnion()));
    // The site check on the removed page is gone; the other names its page.
    expect(project(joined).get(SITE_RULE)).toEqual([
      { name: "malicious", pageUrl: `${SITE}/a` },
    ]);
  });

  test("site checks with no stored rows still join, ahead of carried ones", async () => {
    // Unreachable on the CLI path (site rows are written before the merge),
    // pinned so the join does not silently drop the fresh half if it ever is.
    const carried: RuleRunResult = {
      meta: { id: SITE_RULE } as RuleRunResult["meta"],
      checks: [fail("malicious", `${SITE}/carried`)],
    };
    const joined = joinSmartUnion(new Map(), {
      ...override(true),
      carriedRuleResults: new Map([[SITE_RULE, carried]]),
    });
    expect(project(joined).get(SITE_RULE)).toEqual([
      { name: "malicious", pageUrl: `${SITE}/a` },
      { name: "malicious", pageUrl: `${SITE}/carried` },
    ]);
  });

  test("the stored site rows alone lose the page and survive the filter", async () => {
    // The control: what the join reads without the in-memory copy. Both site
    // checks come back page-less, so the removed page's check is still scored.
    const joined = joinSmartUnion(await storedFresh(), override(false));
    expect(project(joined).get(SITE_RULE)).toEqual([
      { name: "malicious", pageUrl: undefined },
      { name: "malicious", pageUrl: undefined },
    ]);
  });
});
