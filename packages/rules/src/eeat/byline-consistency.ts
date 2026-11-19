// eeat/byline-consistency - pages that break the site's own byline convention (#1364)
//
// eeat/author-byline and eeat/content-dates ask a site-wide question with a fixed
// answer in mind: what share of content pages carry an author, or a date. Neither
// can see that a site bylines 22 of its 24 articles and then ships two without one.
// "You have a standard and broke it on 2 pages" is a far stronger finding than
// "consider adding bylines", and it needs no outside idea of what a good page is:
// the convention is read off the site itself.
//
// What is measured, per `pageType` group, for each of two signals:
//   author   `visibleAuthor` - a visible (non-schema) byline was detected
//   date     `visibleDate`   - a visible published or modified date was detected
// When the signal is present on at least BYLINE_NORM_MIN_AGREEMENT of the group,
// that is the group's convention and the members without it are the deviants.
// Only presence is ever a convention: a page that HAS a byline is never reported,
// so a site that never uses bylines stays clean here by construction.
//
// Guards, in the order they matter:
//   1. Site floor (BYLINE_NORM_MIN_PAGES) - a small crawl has no norm to speak of.
//   2. Group floor (BYLINE_NORM_MIN_GROUP_PAGES) - a page type with 3 pages cannot
//      carry a convention; the group is dropped, not guessed at.
//   3. Agreement (BYLINE_NORM_MIN_AGREEMENT) - a group where only some pages carry
//      a byline is legitimately mixed, and nothing in it is a deviant.
//   4. "unknown" pages never vote: that bucket is whatever the classifier could not
//      place, so a convention inside it means nothing.
// When no (page type, signal) pair reaches the agreement threshold the check is
// skipped, not passed: there is no convention to measure against.
//
// Noindex pages (meta or X-Robots-Tag) are left out of the vote and never judged,
// but only when the site itself is indexable (pub#488, the #457 gate). They still
// count toward the site floor.
//
// Precedence over eeat/author-byline and eeat/content-dates (#1364): a page this
// rule reports is one the site's own convention says should carry the signal, so it
// is reported ONCE, here. Both per-page rules call {@link bylineConsistencyDeviants}
// over the same `site.pages` and leave those pages out of their share (only when the
// page would otherwise count as missing the signal, and only when this rule is
// enabled for the run). A page that breaks no convention is still theirs.
//
// Dual path: `ctx.siteQuery` streams (normalizedUrl, status, pageType, visibleAuthor,
// visibleDate, robotsNoindex) off page_features; the legacy path derives the same
// fields from `ctx.site.pages` exactly as audit-engine's page-features extractor
// does. Both feed ONE accumulator and ONE check builder, and every list is sorted
// before it is emitted, so the output is byte-identical by construction and
// independent of crawl order (same shape as content/duplicate-title, #1021/#1022).

import type { Rule, RuleContext, RuleResult, CheckResult, ParsedPage, SiteData } from "../types";
import type { CheckItem, SiteQuery } from "@squirrelscan/core-contracts";

import { excludesNoindexPage, skipsNoindexPages } from "../shared/noindex";

export const BYLINE_CONSISTENCY_RULE_ID = "eeat/byline-consistency";

/** Crawl-wide page floor: below this there is no site norm to judge against. */
export const BYLINE_NORM_MIN_PAGES = 10;

/** Pages a `pageType` group needs before it can carry a convention at all. */
export const BYLINE_NORM_MIN_GROUP_PAGES = 8;

/**
 * Share of a group that must carry the signal before it is treated as the group's
 * convention. Below this the group genuinely mixes and no member deviates.
 */
export const BYLINE_NORM_MIN_AGREEMENT = 0.7;

/** Share of judged pages that turns the warning into a failure. */
export const BYLINE_NORM_FAIL_SHARE = 0.2;

/**
 * Items reported: one per broken convention (page type x signal), biggest first.
 * Deliberately small. The scorer counts each item of a FAILED check as one issue
 * unit, and a category whose units reach ISSUE_PENALTY_THRESHOLD (10) takes the
 * density penalty, so a 10-item fail alone would cut the E-E-A-T score nearly
 * in half. Four keeps this rule's worst case under that threshold; `details.norms`
 * still lists every convention measured. Real sites rarely break more than a
 * couple: there are only so many page types with 8+ pages.
 */
export const BYLINE_NORM_MAX_ITEMS = 4;
/** Urls listed per item. */
const BYLINE_NORM_MAX_URLS = 10;

const CHECK_NAME = "byline-consistency";

/** The two signals, in the order they are reported. */
const SIGNALS = ["author", "date"] as const;
export type BylineSignal = (typeof SIGNALS)[number];

/** One page's contribution, from either path. */
interface BylinePageRecord {
  url: string;
  status: number;
  pageType: string | null;
  visibleAuthor: boolean;
  visibleDate: boolean;
  /** Left out of the vote (noindex page on an indexable site, pub#488). */
  excluded?: boolean;
}

interface BylineGroup {
  pageType: string;
  urls: string[];
  /** Urls of members WITHOUT each signal. */
  missing: Record<BylineSignal, string[]>;
}

interface BylineRollup {
  /** Pages seen by the rule (both paths count the same universe). */
  pageCount: number;
  groups: Map<string, BylineGroup>;
}

/** One (page type, signal) pair that reached the agreement threshold. */
interface BylineNorm {
  pageType: string;
  signal: BylineSignal;
  pages: number;
  present: number;
  share: number;
  /** Members without the signal, sorted. */
  deviants: string[];
}

/** What the rule decided, before it is rendered into checks. */
type BylineVerdict =
  | { kind: "skip"; message: string }
  | { kind: "judged"; norms: BylineNorm[]; judgedPages: number };

function emptyRollup(): BylineRollup {
  return { pageCount: 0, groups: new Map() };
}

/** Fold one page in. */
function accumulatePage(rollup: BylineRollup, record: BylinePageRecord): void {
  // The site floor counts every page; a noindex page only sits out of the vote.
  rollup.pageCount += 1;

  if (record.excluded) return;
  if (record.status < 200 || record.status >= 300) return;
  const pageType = record.pageType?.trim().toLowerCase();
  if (!pageType || pageType === "unknown") return;

  let group = rollup.groups.get(pageType);
  if (!group) {
    group = { pageType, urls: [], missing: { author: [], date: [] } };
    rollup.groups.set(pageType, group);
  }
  group.urls.push(record.url);
  if (!record.visibleAuthor) group.missing.author.push(record.url);
  if (!record.visibleDate) group.missing.date.push(record.url);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function pct(share: number): number {
  return Math.round(share * 100);
}

/**
 * The verdict for one rollup. `sitePageCount` is the crawl-wide page count: the
 * streaming path takes it from `siteQuery.pageCount()`, so the site floor is judged
 * on the crawl, not on the sampled subset.
 */
function judge(rollup: BylineRollup, sitePageCount: number): BylineVerdict {
  if (sitePageCount < BYLINE_NORM_MIN_PAGES) {
    return {
      kind: "skip",
      message: `Only ${sitePageCount} page(s) crawled; ${BYLINE_NORM_MIN_PAGES} needed to establish a byline convention`,
    };
  }

  const norms: BylineNorm[] = [];
  const judged = new Set<string>();
  let eligibleGroups = 0;
  for (const group of rollup.groups.values()) {
    const pages = group.urls.length;
    if (pages < BYLINE_NORM_MIN_GROUP_PAGES) continue;
    eligibleGroups += 1;
    for (const signal of SIGNALS) {
      const missing = group.missing[signal];
      const present = pages - missing.length;
      const share = present / pages;
      if (share < BYLINE_NORM_MIN_AGREEMENT) continue;
      norms.push({
        pageType: group.pageType,
        signal,
        pages,
        present,
        share,
        deviants: [...missing].sort(compare),
      });
      for (const url of group.urls) judged.add(url);
    }
  }

  if (eligibleGroups === 0) {
    return {
      kind: "skip",
      message: `No page type has ${BYLINE_NORM_MIN_GROUP_PAGES}+ comparable pages to establish a byline convention`,
    };
  }
  if (norms.length === 0) {
    return {
      kind: "skip",
      message: `No page type shows a visible author or date on ${pct(BYLINE_NORM_MIN_AGREEMENT)}% of its pages, so there is no byline convention to measure against`,
    };
  }

  norms.sort(
    (a, b) =>
      compare(a.pageType, b.pageType) || SIGNALS.indexOf(a.signal) - SIGNALS.indexOf(b.signal),
  );
  return { kind: "judged", norms, judgedPages: judged.size };
}

function signalNoun(signal: BylineSignal): string {
  return signal === "author" ? "visible author byline" : "visible date";
}

function skip(message: string): CheckResult {
  return { name: CHECK_NAME, status: "skipped", message };
}

/** The rule's full output for one rollup. ONE builder, both paths. */
function buildChecks(rollup: BylineRollup, sitePageCount: number): CheckResult[] {
  const verdict = judge(rollup, sitePageCount);
  if (verdict.kind === "skip") return [skip(verdict.message)];

  const { norms, judgedPages } = verdict;
  const normSummary = norms
    .map((n) => `${n.pageType} ${n.signal} ${pct(n.share)}%`)
    .join(", ");

  const flagged = new Set<string>();
  for (const norm of norms) for (const url of norm.deviants) flagged.add(url);

  const details: Record<string, unknown> = {
    judgedPages,
    flaggedPages: flagged.size,
    norms: norms.map((n) => ({
      pageType: n.pageType,
      signal: n.signal,
      pages: n.pages,
      present: n.present,
      agreement: n.share,
    })),
  };

  if (flagged.size === 0) {
    return [
      {
        name: CHECK_NAME,
        status: "pass",
        message: `All ${judgedPages} page(s) follow the site's own byline convention (${normSummary})`,
        value: judgedPages,
        details,
      },
    ];
  }

  // One item per broken convention, biggest first; page type then signal break
  // ties so the list never depends on crawl order.
  const broken = norms
    .filter((n) => n.deviants.length > 0)
    .sort(
      (a, b) =>
        b.deviants.length - a.deviants.length ||
        compare(a.pageType, b.pageType) ||
        SIGNALS.indexOf(a.signal) - SIGNALS.indexOf(b.signal),
    );

  const items: CheckItem[] = broken.slice(0, BYLINE_NORM_MAX_ITEMS).map((n) => ({
    id: `${n.pageType}:${n.signal}`,
    label: `${n.deviants.length} of ${n.pages} ${n.pageType} page(s) have no ${signalNoun(n.signal)}, which ${n.present} (${pct(n.share)}%) of ${n.pageType} pages carry`,
    sourcePages: n.deviants.slice(0, BYLINE_NORM_MAX_URLS),
    meta: {
      pageType: n.pageType,
      signal: n.signal,
      convention: n.share,
      pageCount: n.deviants.length,
    },
  }));

  details.brokenConventions = broken.length;

  const share = flagged.size / judgedPages;
  return [
    {
      name: CHECK_NAME,
      status: share >= BYLINE_NORM_FAIL_SHARE ? "fail" : "warn",
      message: `${flagged.size} of ${judgedPages} page(s) break the site's own byline convention (${normSummary})`,
      value: flagged.size,
      items,
      details,
    },
  ];
}

/** The legacy record for one `site.pages` entry, derived as page_features does. */
function legacyRecord(
  site: SiteData | undefined,
  page: SiteData["pages"][number],
): BylinePageRecord {
  const parsed: ParsedPage | undefined = page.parsed;
  return {
    url: page.url,
    status: page.statusCode,
    pageType: parsed?.pageType ?? null,
    visibleAuthor: parsed?.visibleAuthor != null,
    visibleDate: parsed?.visibleDatePublished != null || parsed?.visibleDateModified != null,
    excluded: excludesNoindexPage(site, parsed, page.headers),
  };
}

function legacyRollup(site: SiteData | undefined): BylineRollup {
  const rollup = emptyRollup();
  for (const page of site?.pages ?? []) accumulatePage(rollup, legacyRecord(site, page));
  return rollup;
}

/**
 * The pages this rule reports, per signal, over `site.pages` (empty when it would
 * skip or pass). eeat/author-byline and eeat/content-dates use it to leave those
 * pages to this rule, so a page is reported once (#1364).
 */
export function bylineConsistencyDeviants(
  site: SiteData | undefined,
): Record<BylineSignal, Set<string>> {
  const out: Record<BylineSignal, Set<string>> = { author: new Set(), date: new Set() };
  const pages = site?.pages;
  if (!pages || pages.length === 0) return out;
  const verdict = judge(legacyRollup(site), pages.length);
  if (verdict.kind === "skip") return out;
  for (const norm of verdict.norms) {
    for (const url of norm.deviants) out[norm.signal].add(url);
  }
  return out;
}

/**
 * Whether a per-page E-E-A-T rule should defer to this one: true unless the runner
 * says this rule is not enabled for the run. A caller that never sets
 * `ctx.ruleEnabled` (tests, embedders) runs the full default rule set.
 */
export function defersToBylineConsistency(ctx: RuleContext): boolean {
  return ctx.ruleEnabled?.(BYLINE_CONSISTENCY_RULE_ID) ?? true;
}

/**
 * Streaming path: read the presence flags off the page_features cursor. Only urls
 * stay resident, the same bounded scalars content/duplicate-title holds.
 */
async function runViaSiteQuery(siteQuery: SiteQuery, skipNoindex: boolean): Promise<RuleResult> {
  const rollup = emptyRollup();
  for await (const row of siteQuery.pagesMatching(() => true)) {
    accumulatePage(rollup, {
      url: row.normalizedUrl,
      status: row.status,
      pageType: row.pageType,
      visibleAuthor: row.visibleAuthor,
      visibleDate: row.visibleDate,
      excluded: skipNoindex && row.robotsNoindex,
    });
  }
  return { checks: buildChecks(rollup, siteQuery.pageCount()) };
}

export const bylineConsistencyRule: Rule = {
  meta: {
    id: BYLINE_CONSISTENCY_RULE_ID,
    name: "Byline Consistency",
    description:
      "Finds pages missing the visible author or date that most pages of the same type carry",
    solution:
      "Most of your pages of this type show a visible author byline or date, and these pages do not. A site that bylines its articles and then publishes a few anonymously looks careless at best, and readers and quality raters notice the gap more than they would on a site that never bylines anything. The cause is usually one template, a missing CMS field, or posts imported from elsewhere: fix it at the source so the byline and date render on every page of the type. A page that deliberately has no author, like a press release or a policy page, is fine if it is classified as a different type.",
    category: "eeat",
    scope: "site",
    findingScope: "page",
    severity: "warning",
    // Deliberately light: one site-wide check with at most four items, weighted
    // under eeat/author-byline (5) and eeat/content-dates (4), so its worst case
    // (a fail) costs the E-E-A-T category less than either of those warning
    // (tests/byline-consistency-scoring.test.ts in audit-engine).
    weight: 2,
    checks: [
      { name: CHECK_NAME, outcome: "problem" },
      { name: CHECK_NAME, outcome: "clean", clears: [CHECK_NAME] },
      { name: CHECK_NAME, outcome: "skipped" },
    ],
  },

  run(ctx: RuleContext): RuleResult | Promise<RuleResult> {
    if (ctx.siteQuery) {
      return runViaSiteQuery(ctx.siteQuery, skipsNoindexPages(ctx.site));
    }

    const pages = ctx.site?.pages;
    if (!pages || pages.length === 0) {
      return { checks: [skip("No pages available for analysis")] };
    }

    const rollup = legacyRollup(ctx.site);
    return { checks: buildChecks(rollup, rollup.pageCount) };
  },
};
