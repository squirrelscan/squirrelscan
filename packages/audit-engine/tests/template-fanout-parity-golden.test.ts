// TEMPLATE FAN-OUT PARITY GATE (#1950).
//
// `meta.verdictScope: "template"` is a claim that a page rule's verdict is a
// property of the page's TEMPLATE, so #1951 may run it once per cluster and fan
// the verdict to the members — a claim about pages the rule never ran on. This
// file is what makes that claim falsifiable: every rule declaring "template" must
// produce a byte-identical verdict for every member of every multi-page cluster of
// a corpus that HAS multi-page clusters.
//
// WHY THE FIXTURE IS SHAPED THE WAY IT IS: see helpers/template-corpus.ts. In
// short, a corpus whose pages are all one template passes this vacuously, so the
// corpus is authored rather than generated, and its members differ the way real
// template siblings differ.
//
// The corpus is checked for adversarialness before it is trusted: it must produce
// several multi-page clusters AND a substantial number of "page"-declared rules
// that genuinely disagree inside a cluster. A fixture where nothing varies would
// make every rule look invariant, which is the failure this gate exists to prevent.
//
// Clusters come from the SHIPPED path: `extractPageFeatures` writes
// `page_features.template_fp` (#1949) and `SiteQuery.templateClusters()` groups on
// it. The gate reads the stored key, not one it computed for itself.
//
// This is evidence, not proof, and it is only one of the two falsifiers. The other
// is `apps/cli/scripts/template-rule-invariance.ts --check`, which runs the same
// comparison (`templateVerdictKey`, shared with this file so the two falsifiers
// cannot drift) against a real crawl. Measured on gymshark.com (247 pages, 8
// multi-page clusters, 89/198 rules constant) and openelectricity.org.au (100
// pages, 3 clusters, 142/198), every rule declared "template" is constant on both;
// that result is recorded in
// packages/rules/tests/fixtures/template-invariance-measured.json and asserted by
// rule-verdict-scope.test.ts.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { SQLiteStorage } from "@squirrelscan/crawler";
import { createRunner, loadAllRules, mayFanOutAcrossTemplate } from "@squirrelscan/rules";
import type { PageData, SiteData } from "@squirrelscan/rules";
import type { Config } from "@squirrelscan/config";

import { createSiteQuery, extractPageFeatures, templateVerdictKey } from "../src/index";
import { parseHtmlForRules } from "../src/adapter";
import { CORPUS, mkPage, ORIGIN } from "./helpers/template-corpus";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

const CRAWL = "crawl-1";

// ---------------------------------------------------------------------------
// Running it
//
// The corpus — three templates with 4/4/3 members plus two singletons — lives in
// helpers/template-corpus.ts, shared with #1951's fan-out equivalence gate so the
// two falsifiers cannot drift apart.
// ---------------------------------------------------------------------------

const CONFIG = { rule_options: {}, rules: { enable: ["*"] } } as unknown as Config;
const SITE_DATA = {
  baseUrl: ORIGIN,
  pages: [],
  robotsTxt: null,
  sitemaps: null,
} as unknown as SiteData;

interface Measured {
  /** ruleId -> normalizedUrl -> verdict */
  readonly verdicts: Map<string, Map<string, string>>;
  /** cluster key -> member urls, multi-page clusters only, from the STORED column */
  readonly clusters: Array<{ fp: string; urls: string[] }>;
  readonly clusterCount: number;
  readonly pageCount: number;
}

async function measure(): Promise<Measured> {
  const store = new SQLiteStorage(":memory:");
  await run(store.init());

  const runner = createRunner(CONFIG);
  const verdicts = new Map<string, Map<string, string>>();

  for (const { url, html } of CORPUS) {
    const page = mkPage(url, html);
    const parsed = parseHtmlForRules(html, url);
    await run(store.upsertPageFeatures(CRAWL, extractPageFeatures(page, parsed)));

    const pageData: PageData = {
      url,
      html,
      statusCode: 200,
      loadTime: 12,
      headers: { "content-type": "text/html; charset=utf-8" },
      parsed,
      finalUrl: url,
    };
    const result = await runner.runPageRules(pageData, SITE_DATA);
    for (const [ruleId, rr] of result.ruleResults) {
      let byUrl = verdicts.get(ruleId);
      if (!byUrl) verdicts.set(ruleId, (byUrl = new Map()));
      byUrl.set(url, templateVerdictKey(rr.checks as unknown as Array<Record<string, unknown>>, url));
    }
  }

  const sq = await run(createSiteQuery(store, CRAWL));
  const clusters = sq.templateClusters().map((c) => ({ fp: c.fp, urls: [...c.urls] }));
  const all = await run(store.getPageFeatureTemplateClusters(CRAWL, { maxGroups: 1000, maxUrlsPerGroup: 1000 }));
  await run(store.close());

  return { verdicts, clusters, clusterCount: all.length, pageCount: CORPUS.length };
}

/** Rules that disagree inside a multi-page cluster, with the pair that proves it. */
function divergences(m: Measured, ruleIds: Iterable<string>): Map<string, { fp: string; a: string; b: string }> {
  const out = new Map<string, { fp: string; a: string; b: string }>();
  for (const ruleId of ruleIds) {
    const byUrl = m.verdicts.get(ruleId);
    if (!byUrl) continue;
    for (const { fp, urls } of m.clusters) {
      const present = urls.filter((u) => byUrl.has(u));
      if (present.length < 2) continue;
      const base = byUrl.get(present[0]!)!;
      const other = present.find((u) => byUrl.get(u) !== base);
      if (other) {
        out.set(ruleId, { fp, a: present[0]!, b: other });
        break;
      }
    }
  }
  return out;
}

const measured = await measure();
const pageRules = [...loadAllRules().values()].filter((r) => r.meta.scope === "page");
const fannable = pageRules.filter((r) => mayFanOutAcrossTemplate(r.meta)).map((r) => r.meta.id);
const perPage = pageRules.filter((r) => !mayFanOutAcrossTemplate(r.meta)).map((r) => r.meta.id);

// ---------------------------------------------------------------------------
// The corpus is only evidence if it is adversarial
// ---------------------------------------------------------------------------

describe("the fixture corpus has real multi-page clusters", () => {
  test("three templates cluster, and the two one-off pages do not", () => {
    expect(measured.clusters.length).toBe(3);
    expect(measured.clusters.map((c) => c.urls.length).sort()).toEqual([3, 4, 4]);
    // 5 groups in total: 3 templates + 2 singletons. `templateClusters()` reports
    // only the multi-page ones, which is why a singleton can never make a rule
    // look invariant here.
    expect(measured.clusterCount).toBe(3);
    const clustered = new Set(measured.clusters.flatMap((c) => c.urls));
    expect(clustered.has(`${ORIGIN}/contact`)).toBe(false);
    expect(clustered.has(`${ORIGIN}/status`)).toBe(false);
    expect(clustered.size).toBe(measured.pageCount - 2);
  });

  test("members of a cluster really do differ, page-rule-visibly", () => {
    // Without this the gate below could pass on a corpus of identical pages,
    // which is the exact way the synthetic sites answer this question wrongly.
    const varying = divergences(measured, perPage);
    expect(varying.size).toBeGreaterThanOrEqual(15);
  });

  test.each(fannable.map((id) => [id] as const))(
    "%s is actually compared here, on a non-empty verdict",
    (ruleId) => {
      // The other vacuity hole, and it has to be per-rule: an aggregate "60% of
      // them said something" lets a specific rule sail through in silence, which
      // is the one thing a per-rule classification cannot afford. Every declared
      // rule must produce a non-empty verdict on at least two members of a
      // multi-page cluster, so its pass here is a comparison and not an absence.
      //
      // A verdict of "no such element on this page" IS a verdict — it is what
      // fan-out would assert about the other members — so it counts. What does
      // not count is a rule that emitted nothing at all.
      const byUrl = measured.verdicts.get(ruleId);
      expect(byUrl).toBeDefined();
      const comparedOn = measured.clusters
        .map((c) => c.urls.filter((u) => (byUrl!.get(u) ?? "[]") !== "[]"))
        .find((present) => present.length >= 2);
      if (!comparedOn) {
        throw new Error(
          `${ruleId} declares verdictScope "template" but emitted no verdict on two members ` +
            "of any cluster in this corpus, so the gate below proves nothing about it.",
        );
      }
    },
  );
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe("rules declaring verdictScope template are constant across a cluster", () => {
  test("the classification is not empty", () => {
    expect(fannable.length).toBeGreaterThan(20);
  });

  test.each(fannable.map((id) => [id] as const))(
    "%s gives one verdict per cluster",
    (ruleId) => {
      const byUrl = measured.verdicts.get(ruleId);
      if (!byUrl) return; // rule did not run on this corpus (gated by applicability)
      for (const { fp, urls } of measured.clusters) {
        const present = urls.filter((u) => byUrl.has(u));
        if (present.length < 2) continue;
        const base = present[0]!;
        for (const other of present.slice(1)) {
          // The failure message names the rule, the cluster and the two members,
          // so a failure is actionable without re-running anything.
          if (byUrl.get(other) !== byUrl.get(base)) {
            throw new Error(
              `${ruleId} is declared verdictScope "template" but disagrees inside cluster ${fp}:\n` +
                `  ${base}\n    ${byUrl.get(base)}\n` +
                `  ${other}\n    ${byUrl.get(other)}`,
            );
          }
        }
      }
    },
  );
});
