// Template fan-out (#1951) — run a page rule ONCE per template cluster and hand
// its verdict to the cluster's other members.
//
// This is the payoff for #1026. Measured by attributing the real page-rule pass
// to pages that are not the first of their chrome cluster: 96.5% of gymshark's
// page-rule time (70.5 s of 73.1 s) and 64.6% of openelectricity's is spent on
// non-first members. Fan-out reclaims the share of that belonging to rules whose
// verdict is a property of the template.
//
// WHAT MAKES IT SOUND. Fanning a verdict out asserts something about pages the
// rule never visited, so it is gated on THREE things, none of which lives here:
//
//  1. `meta.verdictScope: "template"` (#1950) — the rule author's claim, read only
//     through `mayFanOutAcrossTemplate`, which answers false for silence.
//  2. The cluster key (#1949) — `page_features.template_fp`, the equality
//     reduction of the chrome fingerprint, computed from the live DOM.
//  3. Falsifiers that run the classified rules per page AND per cluster and require
//     byte-identical verdicts: `template-fanout-parity-golden.test.ts` and
//     `template-fanout-equivalence-golden.test.ts` in CI,
//     `apps/cli/scripts/template-rule-invariance.ts --check` and
//     `apps/cli/scripts/template-fanout-bench.ts --verify` against real crawls.
//
// WHAT THIS FILE IS RESPONSIBLE FOR: that a fanned member's checks are
// indistinguishable from having run the rule on it. Three things follow.
//
// **Each member gets its OWN copy.** The checks are cloned per member, so the
// caller's ordinary `check.pageUrl = pageUrl` stamp lands on this page's objects
// and not on a sibling's. Aliasing here would be silent: the findings would look
// right until the last member of a cluster overwrote every earlier member's
// `pageUrl`, collapsing `affectedPages` onto one page and re-fingerprinting the
// whole cluster onto it (#1880 keys findings on `(rule, check, locator)` and the
// report attributes pages from `pageUrl`).
//
// **The cached copy carries no `pageUrl`.** It is taken before the caller stamps
// the representative, so the stamp on a member is a first write, exactly as it is
// on a page that really ran. Nothing here re-writes urls INSIDE a check, because
// nothing should have to: a rule that emits its own page's url is not
// template-scoped, and `template-verdict-page-independence.test.ts` fails a
// declaration that does, by running the rule under two urls that share only scheme
// and host.
//
// **A COPY THAT DID NOT COPY IS NOT USED.** `detachFromPage` is deliberately
// forgiving — a value it cannot `structuredClone` is returned AS IS, because for
// its usual callers the cost of that is retention and never a wrong finding. Here
// it would be a wrong finding: the member would stamp `pageUrl` onto the cached
// objects, the guard that stamps only an unset `pageUrl` would then leave every
// later member reading the first one's url, and the whole cluster would collapse
// onto one page. So every copy is checked by IDENTITY (`structuredClone` never
// returns its argument) and anything that came back uncopied is dropped from the
// cache or from the hand-out, which puts those pages back on the ordinary path.
//
// **A rule that threw is never cached.** `runOneRule` turns a throw into a
// `<ruleId>-error` check whose message quotes the exception, which can carry page
// content and need not recur on a sibling. Those clusters simply run the rule
// per page.
//
// WHAT THE CLUSTER KEY DOES NOT CONSTRAIN, and what this file does about it. The
// key (#1949) is chrome: asset hosts, body classes, CSS custom properties,
// stylesheet hrefs, nav/footer presence. It is an APPROXIMATION of "same
// template", chosen because the intuitive alternative — an exact DOM skeleton —
// puts 224 of gymshark's 247 pages in a cluster of one (#1026). So two pages can
// share a key and still differ in markup the key never looked at, and the reason
// fan-out is nonetheless sound is the DECLARATION plus its falsifiers, not the key.
// That is #1950's premise and it is empirical: a rule constant on two real crawls
// can vary on a third.
//
// Two things are NOT left to that, because they are properties of the PAGE rather
// than claims about a rule's markup inputs, and because a corpus of one origin can
// never exhibit them:
//
//  - **The page's ORIGIN is part of the grouping key here.** Several declared rules
//    resolve resources against it: `security/sri` reports a script as cross-origin
//    by comparing `resolved.origin` to the page's, so the same markup at
//    `https://shop.test/a` and `http://shop.test/b` genuinely gets different
//    verdicts. Grouping by origin costs nothing on a real site, which has one, and
//    it is exact rather than a claim about any rule.
//  - **`core/charset` was DEMOTED to page scope** in this change, because its
//    verdict can come from the `Content-Type` response header, which the key
//    constrains in no way. See its meta and the counterexample pinned in
//    packages/rules/tests/template-verdict-page-independence.test.ts.
//
// MEMORY (#1913). The cache holds one detached copy of the declared rules' checks
// per cluster, and nothing else — no page, no DOM, no per-member entry. On a
// site where every page is its own template that is still one entry per page, so
// it is capped: past {@link DEFAULT_MAX_CLUSTERS} new clusters stop being cached
// and their pages run the ordinary path. The cap changes cost, never output.

import { detachFromPage } from "./detach";

import type { CheckResult } from "@squirrelscan/core-contracts";
import type { RuleRunResult, RuleRunner } from "@squirrelscan/rules";
import { mayFanOutAcrossTemplate } from "@squirrelscan/rules";

/**
 * Clusters whose verdicts are kept. A real site has tens (13 on gymshark, 12 on
 * openelectricity); the cap only binds on a crawl where clustering has failed and
 * nearly every page is its own template, which is exactly the case where caching
 * buys nothing and costs residency.
 */
export const DEFAULT_MAX_CLUSTERS = 1_000;

/**
 * The kill switch (#1951). Fan-out is ON for every streamed rules pass — the CLI
 * and the cloud both run `runStreamingRules` — and `SQUIRREL_TEMPLATE_FANOUT` set
 * to `0`, `false`, `off` or `no` turns it off for a run without a rebuild. The v1
 * `runRulesOnStorage` path never consults this: it does not stream, has no cluster
 * key, and is left exactly as it was.
 *
 * Read per pass rather than at module load so a test (or a support session) can
 * flip it between runs in one process.
 */
export function templateFanoutEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.SQUIRREL_TEMPLATE_FANOUT;
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

export interface TemplateFanoutStats {
  /** Distinct template clusters that produced a representative. */
  readonly clusters: number;
  /** Pages that took at least one verdict from a sibling. */
  readonly fannedPages: number;
  /** Rule invocations skipped — the thing the saving is actually made of. */
  readonly fannedRuleRuns: number;
  /**
   * Pages whose cluster was not cached because {@link DEFAULT_MAX_CLUSTERS} was
   * reached. Counted per page rather than per cluster (holding the over-cap keys
   * to count them distinctly would reintroduce the growth the cap exists to
   * stop), so a non-zero value means "clustering is not paying here", not a count
   * of templates.
   */
  readonly pagesOverCap: number;
}

/**
 * The grouping key: the template cluster AND the page's origin.
 *
 * Origin is here rather than in `page_features.template_fp` deliberately —
 * `template_fp` answers "same template?" for `SiteQuery.templateClusters()` and
 * for #1950's gate, and a crawl that spans `http://` and `https://` should still
 * report those pages as one template. What it must not do is let a verdict
 * computed against one origin be copied onto a page with another.
 *
 * A url that will not parse gets its whole string as the origin, so it can only
 * ever share a group with a byte-identical url — the conservative answer.
 */
export function fanoutClusterKey(templateKey: string | null, pageUrl: string): string | null {
  if (!templateKey) return null;
  let origin: string;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    origin = pageUrl;
  }
  // NUL cannot appear in an origin or in a 16-hex key, so the join is injective.
  return `${origin}\u0000${templateKey}`;
}

export interface TemplateFanout {
  /**
   * The checks a member of `clusterKey` should use instead of running, or
   * `undefined` for the first page of a cluster (and for every page while the
   * cluster key is unknown). Freshly cloned, so the caller owns them.
   *
   * `clusterKey` is {@link fanoutClusterKey}'s output, not the raw template key.
   */
  take(clusterKey: string | null): ReadonlyMap<string, CheckResult[]> | undefined;
  /**
   * Keep this page's declared-template verdicts as the cluster's representative.
   * Call it with the results of a page that really ran, BEFORE `pageUrl` is
   * stamped on them. A second call for the same key is a no-op.
   */
  record(clusterKey: string | null, ruleResults: ReadonlyMap<string, RuleRunResult>): void;
  stats(): TemplateFanoutStats;
}

/**
 * Build a fan-out cache for one streamed rules pass.
 *
 * The set of fannable rule ids is resolved ONCE from the runner's enabled rules,
 * so a rule disabled by config never enters the cache and the per-page path costs
 * a `Set.has` rather than a `meta` read.
 */
export function createTemplateFanout(
  runner: RuleRunner,
  opts?: { maxClusters?: number },
): TemplateFanout {
  const maxClusters = Math.max(0, opts?.maxClusters ?? DEFAULT_MAX_CLUSTERS);
  const fannable = new Set(
    runner
      .getEnabledRules()
      .filter((r) => mayFanOutAcrossTemplate(r.meta))
      .map((r) => r.meta.id),
  );

  /**
   * Copy a checks array free of its page, or `null` when the copy did not happen.
   * `detachFromPage` returns its ARGUMENT when `structuredClone` throws; that is
   * the right answer for a retention-only caller and the wrong one here, so the
   * identity check is the whole point of this wrapper.
   */
  const copyChecks = (checks: CheckResult[]): CheckResult[] | null => {
    const copy = detachFromPage(checks, "template-fanout");
    return copy === checks ? null : copy;
  };

  /** clusterKey -> ruleId -> the representative's checks, detached, unstamped. */
  const cache = new Map<string, Map<string, CheckResult[]>>();
  let fannedPages = 0;
  let fannedRuleRuns = 0;
  let pagesOverCap = 0;

  return {
    take(clusterKey) {
      if (!clusterKey || fannable.size === 0) return undefined;
      const entry = cache.get(clusterKey);
      if (!entry || entry.size === 0) return undefined;
      // One copy per member, and a rule whose copy did not happen is simply left
      // out — it then runs on this page, which is always a correct answer.
      const out = new Map<string, CheckResult[]>();
      for (const [ruleId, checks] of entry) {
        const copy = copyChecks(checks);
        if (copy) out.set(ruleId, copy);
      }
      if (out.size === 0) return undefined;
      fannedPages++;
      fannedRuleRuns += out.size;
      return out;
    },

    record(clusterKey, ruleResults) {
      if (!clusterKey || fannable.size === 0 || cache.has(clusterKey)) return;
      if (cache.size >= maxClusters) {
        pagesOverCap++;
        return;
      }
      const entry = new Map<string, CheckResult[]>();
      for (const ruleId of fannable) {
        const rr = ruleResults.get(ruleId);
        if (!rr) continue; // not run on this page (disabled mid-run / unknown id)
        // A rule that threw produced a `<ruleId>-error` check whose message is the
        // exception's, which may quote this page. Not a template property.
        if (rr.checks.some((c) => c.name === `${ruleId}-error`)) continue;
        const copy = copyChecks(rr.checks as CheckResult[]);
        // An uncopied array would be the LIVE result the caller is about to stamp.
        if (copy) entry.set(ruleId, copy);
      }
      // Recorded even when empty: it marks the cluster as seen, so a later member
      // does not re-record and the representative stays the first page.
      cache.set(clusterKey, entry);
    },

    stats() {
      return {
        clusters: cache.size,
        fannedPages,
        fannedRuleRuns,
        pagesOverCap,
      };
    },
  };
}
