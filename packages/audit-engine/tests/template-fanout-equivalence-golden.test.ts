// TEMPLATE FAN-OUT EQUIVALENCE GATE (#1951).
//
// #1950 asserts that a rule declaring `verdictScope: "template"` gives one verdict
// per cluster. This file asserts the thing built on top of that: running such a
// rule ONCE per cluster and giving its verdict to the members produces output
// indistinguishable from running it on every page.
//
// The reference arm is a RESIDENT loop that runs every rule on every page — the
// same shape `streaming-page-rules-golden.test.ts` uses against the streamed pass,
// deliberately, because it is the only reference that owes nothing to the code
// under test. The corpus is the authored one from `helpers/template-corpus.ts`,
// shared with #1950's gate: three templates with 4, 4 and 3 members plus two
// singletons, whose members differ the way real template siblings differ.
//
// SIX THINGS BYTE-IDENTITY ON THIS CORPUS ALONE WOULD NOT CATCH, each with its own
// test below:
//
//  1. **Fan-out that never happened.** Equal output is exactly what you get when
//     the feature does nothing, so a value assertion cannot prove a rule was
//     skipped — only a call counter can. Two rules registered here count their own
//     invocations: the template-scoped one must run once per CLUSTER, the
//     page-scoped one once per PAGE.
//  2. **Members collapsing onto the representative.** If a member's checks aliased
//     the sibling's objects instead of copying them, `pageUrl` would end up the
//     same on all of them. That is invisible in a per-page comparison keyed by url
//     and fatal downstream: `affectedPages` would name one page and every member's
//     finding would re-key onto it (#1880 keys findings on (rule, check, locator);
//     #1882 is the neighbouring surface that was already wrong once). Asserted
//     through the REAL writers — `foldOverflowChecks` for the report's page union
//     and `details.occurrences`, `buildStreamFindings` for the stored identity.
//  3. **Fan-out reaching an undeclared rule.** Absence of `verdictScope` must mean
//     page, never "fannable by default".
//  4. **Singletons.** A cluster of one must take the ordinary path; 5 of
//     gymshark's 13 chrome clusters are singletons.
//  5. **A copy that did not copy.** `detachFromPage` returns its argument when
//     `structuredClone` throws, which would put one page's live checks in the cache
//     for the whole cluster to stamp over. A rule emitting an uncloneable check
//     must fall back to running per page.
//  6. **Crossing origins.** The chrome key sees no scheme, and `security/sri`
//     decides "cross-origin" by comparing the page's origin to a resolved script's,
//     so the same markup at `https://` and `http://` gets different verdicts. The
//     fan-out groups by origin as well as by template; a corpus of one origin can
//     never show that.
//
// Named `*golden*` so `bun run test:engine` runs it alongside the other
// byte-identity gates and not only in the whole-package CI step.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { SQLiteStorage } from "@squirrelscan/crawler";
import { RuleRunner, createRunner } from "@squirrelscan/rules";
import type { Rule, RuleRunResult, SiteData } from "@squirrelscan/rules";
import { foldOverflowChecks } from "@squirrelscan/rules/fold";
import type { CheckResult, PageRecord } from "@squirrelscan/core-contracts";
import type { Config } from "@squirrelscan/config";

import { buildHeadersMap, buildSiteContext, isRenderedFetch } from "../src/adapter";
import { isAuditablePage } from "../src/page-features";
import { foldRuleResultIntoTallies, type RuleTally } from "../src/scoring";
import { streamPageRules } from "../src/streaming";
import { buildStreamFindings } from "../src/stream-findings";
import { fanoutClusterKey, templateFanoutEnabled } from "../src/template-fanout";
import { checkAffectedPages } from "@squirrelscan/report";
import { CORPUS, ORIGIN, mkPage } from "./helpers/template-corpus";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

const CRAWL = "crawl-1";
// `enable: ["*"]` turns the whole rule set on; filterRules defaults every rule to
// disabled, so an empty `rules` would make both arms trivially equal on nothing.
const CONFIG = { rule_options: {}, rules: { enable: ["*"] } } as unknown as Config;
const SITE_DATA = {
  baseUrl: ORIGIN,
  pages: [],
  robotsTxt: null,
  sitemaps: null,
} as unknown as SiteData;

/**
 * A representative fannable rule for the per-member assertions. `security/sri`
 * warns on every page of this corpus (so it reaches `buildStreamFindings`, which
 * only streams fail/warn) and its items are RESOURCE urls rather than page urls —
 * the exact shape #1882 miscounted, so the affected-page assertions below are
 * being made on the surface that has actually been wrong.
 */
const FANNED_RULE = "security/sri";

async function corpusStorage(): Promise<SQLiteStorage> {
  const store = new SQLiteStorage(":memory:");
  await run(store.init());
  for (const { url, html } of CORPUS) {
    await run(store.upsertPage(CRAWL, mkPage(url, html) as PageRecord));
  }
  return store;
}

/**
 * The reference: parse every page, run every rule on every page, fold. No cluster
 * key is consulted anywhere in here, which is the point.
 */
async function residentPageRules(storage: SQLiteStorage, runner: RuleRunner) {
  const pages = await run(storage.getPages(CRAWL));
  const ctx = await run(buildSiteContext(pages));
  const pageResults = new Map<string, CheckResult[]>();
  const pageRuleResults = new Map<string, Map<string, CheckResult[]>>();
  const tallies = new Map<string, RuleTally>();
  for (const { page, parsed } of ctx) {
    if (!parsed || !isAuditablePage(page)) continue;
    const result = await runner.runPageRules(
      {
        url: page.url,
        html: page.html!,
        statusCode: page.status,
        loadTime: page.loadTimeMs,
        ttfb: page.ttfb,
        downloadTime: page.downloadTime,
        headers: buildHeadersMap(page),
        parsed,
        finalUrl: page.finalUrl,
        redirectChain: page.redirectChain,
        rendered: isRenderedFetch(page.fetcherId),
      },
      SITE_DATA,
    );
    const pageUrl = page.normalizedUrl;
    const byRule = new Map<string, CheckResult[]>();
    for (const [ruleId, rr] of result.ruleResults) {
      for (const check of rr.checks) if (!check.pageUrl) check.pageUrl = pageUrl;
      foldRuleResultIntoTallies(tallies, ruleId, rr as RuleRunResult);
      byRule.set(ruleId, rr.checks);
    }
    pageResults.set(pageUrl, result.checks);
    pageRuleResults.set(pageUrl, byRule);
    parsed.document = null;
  }
  return { pageResults, pageRuleResults, tallies };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe("fanning a template verdict out is indistinguishable from running the rule", () => {
  test("every page's checks, per-rule results and folded tallies are unchanged", async () => {
    const storage = await corpusStorage();
    const reference = await residentPageRules(storage, createRunner(CONFIG));
    const fanned = await run(
      streamPageRules(storage, CRAWL, createRunner(CONFIG), SITE_DATA, {
        batchSize: 4, // < the corpus, so clusters straddle batch boundaries
        templateFanout: true,
      }),
    );

    expect([...fanned.pageResults.keys()].sort()).toEqual([...reference.pageResults.keys()].sort());
    for (const [url, checks] of reference.pageResults) {
      // The flat per-page list, in enabled-rule order — this is what catches a
      // fanned rule landing in the wrong position as well as a wrong verdict.
      expect(fanned.pageResults.get(url)).toEqual(checks as never);
    }
    for (const [url, byRule] of reference.pageRuleResults) {
      const got = fanned.pageRuleResults.get(url);
      expect(got).toBeDefined();
      expect([...got!.keys()]).toEqual([...byRule.keys()]);
      for (const [ruleId, checks] of byRule) {
        expect(got!.get(ruleId)).toEqual(checks as never);
      }
    }
    expect([...fanned.tallies.keys()].sort()).toEqual([...reference.tallies.keys()].sort());
    for (const [ruleId, rt] of reference.tallies) {
      // Health score is folded from these, so equal tallies is "the score did not
      // move" without re-deriving a score here.
      expect(fanned.tallies.get(ruleId)?.tally).toEqual(rt.tally);
    }

    await run(storage.close());
  });

  test("the fan-out actually ran: clusters found, rule invocations removed", async () => {
    const storage = await corpusStorage();
    const on = await run(
      streamPageRules(storage, CRAWL, createRunner(CONFIG), SITE_DATA, { templateFanout: true }),
    );
    const off = await run(
      streamPageRules(storage, CRAWL, createRunner(CONFIG), SITE_DATA, { templateFanout: false }),
    );

    // 3 templates + 2 singletons = 5 keys; 11 clustered pages - 3 representatives
    // = 8 pages that inherited a verdict.
    expect(on.templateFanout.clusters).toBe(5);
    expect(on.templateFanout.fannedPages).toBe(8);
    expect(on.templateFanout.fannedRuleRuns).toBeGreaterThan(8 * 20);
    expect(on.templateFanout.pagesOverCap).toBe(0);

    // Off is the untouched path, and says so in the stats rather than by absence.
    expect(off.templateFanout).toEqual({
      clusters: 0,
      fannedPages: 0,
      fannedRuleRuns: 0,
      pagesOverCap: 0,
    });

    await run(storage.close());
  });
});

// ---------------------------------------------------------------------------
// Counting the calls — equal output proves nothing on its own
// ---------------------------------------------------------------------------

interface CountingRules {
  readonly rules: Rule[];
  counts(): { template: number; page: number };
  reset(): void;
}

/**
 * Two rules that differ ONLY in `verdictScope`, each counting its own `run()`.
 * They are the falsifier for "the fan-out did something" and for "an undeclared
 * rule is never fanned out", and having them differ in one field is what makes
 * the second claim about the declaration rather than about the rule.
 */
function countingRules(): CountingRules {
  let template = 0;
  let page = 0;
  const base = {
    name: "Counter",
    description: "counts its own invocations",
    category: "core" as const,
    scope: "page" as const,
    severity: "info" as const,
    weight: 1,
  };
  return {
    rules: [
      {
        meta: { ...base, id: "test/counter-template", verdictScope: "template" as const },
        run: () => {
          template++;
          return { checks: [{ name: "counter", status: "pass" as const, message: "seen" }] };
        },
      },
      {
        meta: { ...base, id: "test/counter-page", verdictScope: "page" as const },
        run: () => {
          page++;
          return { checks: [{ name: "counter", status: "pass" as const, message: "seen" }] };
        },
      },
    ],
    counts: () => ({ template, page }),
    reset: () => {
      template = 0;
      page = 0;
    },
  };
}

describe("what actually runs", () => {
  test("a template-scoped rule runs once per cluster; a page-scoped one once per page", async () => {
    const storage = await corpusStorage();
    const counters = countingRules();
    const runner = new RuleRunner({
      config: CONFIG,
      additionalNamespaces: [{ name: "test", rules: counters.rules }],
    });

    const result = await run(
      streamPageRules(storage, CRAWL, runner, SITE_DATA, { templateFanout: true }),
    );

    // 13 pages, 5 clusters (3 templates + 2 singletons).
    expect(result.pageUrls.length).toBe(CORPUS.length);
    expect(counters.counts()).toEqual({ template: 5, page: CORPUS.length });

    // …and both rules still reported on every page.
    for (const url of result.pageUrls) {
      expect(result.pageRuleResults.get(url)?.get("test/counter-template")).toHaveLength(1);
      expect(result.pageRuleResults.get(url)?.get("test/counter-page")).toHaveLength(1);
    }

    // With fan-out off, the template-scoped rule runs per page like any other —
    // the difference between the two numbers is the whole feature.
    counters.reset();
    await run(streamPageRules(storage, CRAWL, runner, SITE_DATA, { templateFanout: false }));
    expect(counters.counts()).toEqual({ template: CORPUS.length, page: CORPUS.length });

    await run(storage.close());
  });

  test("a verdict that cannot be copied is not fanned out", async () => {
    // `detachFromPage` returns its ARGUMENT when structuredClone throws, which for
    // its usual callers costs retention and never correctness. Handing that back
    // here would alias one page's checks across a whole cluster, and the symptom
    // would be every member reporting the FIRST member's url — silent, and only
    // visible downstream. The cache checks the copy by identity instead.
    const storage = await corpusStorage();
    let ran = 0;
    const uncloneable: Rule = {
      meta: {
        id: "test/uncloneable",
        name: "Uncloneable",
        description: "emits a check structuredClone refuses",
        category: "core",
        scope: "page",
        severity: "info",
        weight: 1,
        verdictScope: "template",
      },
      run: () => {
        ran++;
        return {
          checks: [
            {
              name: "uncloneable",
              status: "pass",
              message: "seen",
              // A function is not structured-cloneable, and one failure aborts the
              // whole clone of the array.
              details: { onFix: () => undefined },
            } as unknown as CheckResult,
          ],
        };
      },
    };
    const runner = new RuleRunner({
      config: CONFIG,
      additionalNamespaces: [{ name: "test", rules: [uncloneable] }],
    });

    const result = await run(
      streamPageRules(storage, CRAWL, runner, SITE_DATA, { templateFanout: true }),
    );

    // Declared "template", but it ran on every page because its verdict could not
    // be copied — the degradation is in cost, never in what is reported.
    expect(ran).toBe(CORPUS.length);
    for (const url of result.pageUrls) {
      const checks = result.pageRuleResults.get(url)?.get("test/uncloneable") ?? [];
      expect(checks).toHaveLength(1);
      expect(checks[0]!.pageUrl).toBe(url);
    }

    await run(storage.close());
  });

  test("a singleton cluster runs its own rules, taking nothing from anyone", async () => {
    const storage = await corpusStorage();
    const counters = countingRules();
    const runner = new RuleRunner({
      config: CONFIG,
      additionalNamespaces: [{ name: "test", rules: counters.rules }],
    });
    const result = await run(
      streamPageRules(storage, CRAWL, runner, SITE_DATA, { templateFanout: true }),
    );

    // The two one-off pages are 2 of the 5 invocations: a cluster of one costs
    // exactly one run, which is what "no special case and no overhead" means.
    const singles = [`${ORIGIN}/contact`, `${ORIGIN}/status`];
    for (const url of singles) expect(result.pageUrls).toContain(url);
    expect(counters.counts().template).toBe(5);
    // 8 fanned pages + 5 that ran = 13, so no singleton was ever fanned.
    expect(result.templateFanout.fannedPages + counters.counts().template).toBe(CORPUS.length);

    await run(storage.close());
  });
});

// ---------------------------------------------------------------------------
// A fanned finding belongs to the MEMBER, not to the representative
// ---------------------------------------------------------------------------

describe("a fanned finding names the page it is about", () => {
  test("affectedPages and details.occurrences cover every member, not the representative", async () => {
    const storage = await corpusStorage();
    const result = await run(
      streamPageRules(storage, CRAWL, createRunner(CONFIG), SITE_DATA, { templateFanout: true }),
    );

    const checks = result.ruleResultsMap.get(FANNED_RULE)?.checks ?? [];
    expect(checks.length).toBe(CORPUS.length);
    // Every check carries its OWN page. Aliasing a sibling's objects would leave
    // one url repeated here and the assertion below at 1.
    expect(new Set(checks.map((c) => c.pageUrl)).size).toBe(CORPUS.length);

    // Through the real fold: maxChecks 1 forces the whole rule into one aggregate,
    // which is the shape the report renders for a rule that fires site-wide.
    const folded = foldOverflowChecks(checks as CheckResult[], {
      maxChecks: 1,
      maxItemsPerCheck: 100,
      maxPagesPerCheck: 100,
      maxSourcePagesPerItem: 100,
    });
    expect(folded).toHaveLength(1);
    const aggregate = folded[0]!;
    expect(aggregate.details?.occurrences).toBe(CORPUS.length);
    expect(new Set(aggregate.pages ?? [])).toEqual(new Set(CORPUS.map((c) => c.url)));
    // …and the report's own accessor agrees, so this is not a claim about fold's
    // internals (#1882: this surface has counted the wrong thing before).
    expect(checkAffectedPages(aggregate).size).toBe(CORPUS.length);

    await run(storage.close());
  });

  test("stored finding identity keys on the member, so a re-audit resolves nothing", async () => {
    const storage = await corpusStorage();
    // Sequential on purpose: both arms write page_features through the same
    // storage handle, and interleaving two passes over one connection is a
    // different thing to test than this.
    const arms = [];
    for (const templateFanout of [true, false]) {
      arms.push(
        await run(
          streamPageRules(storage, CRAWL, createRunner(CONFIG), SITE_DATA, { templateFanout }),
        ),
      );
    }

    // The real writer: what the container streams into page_findings.
    const [withFanout, without] = arms.map((r) =>
      buildStreamFindings(Object.fromEntries(r.ruleResultsMap), 1_000),
    );

    const keyed = (rows: ReturnType<typeof buildStreamFindings>) =>
      rows
        .map((f) => `${f.normalizedUrl} ${f.ruleId} ${f.checkName} ${f.locator}`)
        .sort();
    // Identical (url, rule, check, locator) keys AND identical fingerprints. A
    // fingerprint that keyed on the representative would make every re-audit
    // resolve and re-open the whole cluster (#1880).
    expect(keyed(withFanout!)).toEqual(keyed(without!));
    expect(withFanout!.map((f) => f.fingerprint).sort()).toEqual(
      without!.map((f) => f.fingerprint).sort(),
    );

    // And the fanned rule is genuinely represented per member here, not once.
    const forRule = withFanout!.filter((f) => f.ruleId === FANNED_RULE);
    expect(new Set(forRule.map((f) => f.normalizedUrl)).size).toBe(CORPUS.length);

    await run(storage.close());
  });
});

// ---------------------------------------------------------------------------
// The grouping key carries the page's origin, not just its template
// ---------------------------------------------------------------------------

describe("a verdict is never copied across origins", () => {
  test("two pages with identical markup but different schemes are separate groups", async () => {
    // `security/sri` decides "cross-origin" by comparing a resolved script's
    // origin to the page's, so the SAME markup gives different verdicts at
    // `https://shop.test/a` and `http://shop.test/a`: the script is same-origin on
    // one and cross-origin on the other. The chrome fingerprint sees neither, so
    // grouping on the template key alone would copy one verdict onto the other —
    // a security finding invented for, or erased from, a page nobody looked at.
    const html =
      `<!DOCTYPE html><html lang="en"><head><title>Same markup</title>` +
      `<meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<link rel="stylesheet" href="/assets/site.css">` +
      `<script src="https://shop.test/app.js"></script>` +
      `<style>:root{--brand:#101010}</style>` +
      `</head><body class="tpl-x"><nav><a href="/">Home</a></nav>` +
      `<main><h1>Same markup</h1></main><footer>f</footer></body></html>`;
    const secure = "https://shop.test/a";
    const insecure = "http://shop.test/a";

    const store = new SQLiteStorage(":memory:");
    await run(store.init());
    for (const url of [secure, insecure]) {
      await run(store.upsertPage(CRAWL, mkPage(url, html) as PageRecord));
    }

    const result = await run(
      streamPageRules(store, CRAWL, createRunner(CONFIG), SITE_DATA, { templateFanout: true }),
    );

    // Same template, two groups, and nothing inherited.
    expect(result.pageUrls.sort()).toEqual([insecure, secure]);
    expect(result.templateFanout.clusters).toBe(2);
    expect(result.templateFanout.fannedPages).toBe(0);

    // …and the verdicts really do differ, so the separation is load-bearing rather
    // than a distinction the rules would not have noticed.
    const sriOn = (url: string) => result.pageRuleResults.get(url)?.get(FANNED_RULE) ?? [];
    expect(sriOn(secure).map((c) => c.status)).not.toEqual(sriOn(insecure).map((c) => c.status));

    await run(store.close());
  });

  test("fanoutClusterKey separates origins and survives an unparseable url", () => {
    expect(fanoutClusterKey("abc123", "https://shop.test/a")).not.toBe(
      fanoutClusterKey("abc123", "http://shop.test/a"),
    );
    expect(fanoutClusterKey("abc123", "https://shop.test/a")).toBe(
      fanoutClusterKey("abc123", "https://shop.test/b?q=1"),
    );
    // No template key means no group, whatever the url.
    expect(fanoutClusterKey(null, "https://shop.test/a")).toBeNull();
    // A url that will not parse falls back to itself, so it can only ever group
    // with a byte-identical url.
    expect(fanoutClusterKey("abc123", "not a url")).not.toBe(
      fanoutClusterKey("abc123", "also not a url"),
    );
    expect(fanoutClusterKey("abc123", "not a url")).toBe(fanoutClusterKey("abc123", "not a url"));
  });
});

// ---------------------------------------------------------------------------
// The cluster cap: it may change cost, never output
// ---------------------------------------------------------------------------

describe("the cache is bounded", () => {
  test("past the cap, later clusters run the ordinary path and the output is unchanged", async () => {
    const storage = await corpusStorage();
    const reference = await residentPageRules(storage, createRunner(CONFIG));
    // Room for one cluster only. On a crawl where clustering has failed and nearly
    // every page is its own template, the cache would otherwise grow with the page
    // count — the term #1913 exists to keep out of this loop.
    const capped = await run(
      streamPageRules(storage, CRAWL, createRunner(CONFIG), SITE_DATA, {
        templateFanout: true,
        templateFanoutMaxClusters: 1,
      }),
    );

    expect(capped.templateFanout.clusters).toBe(1);
    expect(capped.templateFanout.pagesOverCap).toBeGreaterThan(0);
    // Fewer pages inherited than the uncapped 8, but every page still reported.
    expect(capped.templateFanout.fannedPages).toBeLessThan(8);
    expect(capped.templateFanout.fannedPages).toBeGreaterThan(0);
    for (const [url, checks] of reference.pageResults) {
      expect(capped.pageResults.get(url)).toEqual(checks as never);
    }

    await run(storage.close());
  });
});

// ---------------------------------------------------------------------------
// The kill switch
// ---------------------------------------------------------------------------

describe("SQUIRREL_TEMPLATE_FANOUT", () => {
  test("defaults on, and every spelling of off turns it off", () => {
    expect(templateFanoutEnabled({})).toBe(true);
    expect(templateFanoutEnabled({ SQUIRREL_TEMPLATE_FANOUT: "1" })).toBe(true);
    expect(templateFanoutEnabled({ SQUIRREL_TEMPLATE_FANOUT: "" })).toBe(true);
    for (const off of ["0", "false", "FALSE", "off", "no", " 0 "]) {
      expect(templateFanoutEnabled({ SQUIRREL_TEMPLATE_FANOUT: off })).toBe(false);
    }
  });
});
