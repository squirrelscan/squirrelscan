// content/voice-consistency - pages whose reading level departs from the site's own norm
//
// content/reading-level scores one page. The signal this rule adds is the spread across the
// site: the page written by a different hand, boilerplate pasted into a marketing section, or
// an obvious bulk-generated dump reads at a very different level from its neighbours. Nothing
// is compared with a fixed target; the norm is the median Flesch Reading Ease score of the
// site's own pages and only a page far from it is reported, in either direction.
//
// Deterministic (no model, no surcharge): the score is the one content/reading-level computes,
// stored on `page_features.reading_level` by the streaming engine. Both paths feed ONE
// accumulator and ONE check builder, so the output is byte-identical by construction (same
// shape as content/thin-vs-site-norm).
//
// Guards, in the order they matter:
//   1. Site floor (VOICE_MIN_PAGES): a small crawl has no norm.
//   2. Sample floor (VOICE_MIN_SAMPLE): too few scored pages to vote. Pages too short to score
//      (under 100 words) carry no reading level and never vote.
//   3. Legal pages (privacy, terms, imprint) are excluded by URL, or by a stored page type of
//      legal: their register is legitimately different. They are counted, not dropped silently.
//   4. Agreement (VOICE_MIN_AGREEMENT): a site whose pages do not cluster around one level has
//      no clear norm and nothing in it is a deviant. The rule skips.
//   5. A robust-z floor AND an absolute point gap must BOTH be crossed.
//   6. Noindex pages on an indexable site are left out, as in the other site-norm rules.

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";
import type { CheckItem, SiteQuery } from "@squirrelscan/core-contracts";

import { excludesNoindexPage, skipsNoindexPages } from "../shared/noindex";
import { isLegalPage } from "../links/no-contextual-inbound";
import { pageReadingLevel } from "./reading-level";

/** Crawl-wide page floor: below this there is no site norm to judge against. */
export const VOICE_MIN_PAGES = 10;

/** Scored (judgeable, non-legal) pages needed before a norm is trusted. */
export const VOICE_MIN_SAMPLE = 10;

/** Half-width, in Flesch points, of the "inside the norm" band used for the agreement test. */
export const VOICE_BAND = 15;

/** Share of scored pages that must sit inside {@link VOICE_BAND} of the median for a norm to exist. */
export const VOICE_MIN_AGREEMENT = 0.7;

/** A flagged page must differ from the median by at least this many Flesch points. */
export const VOICE_MIN_GAP = 25;

/** Robust z (deviations of 1.4826*MAD from the median) a flagged page must clear. */
export const VOICE_MIN_Z = 3;

/** Floor on the robust sigma in Flesch points, so a tight distribution cannot make a sibling deviant. */
export const VOICE_SIGMA_FLOOR = 5;

const VOICE_MAX_ITEMS = 10;
const MAD_TO_SIGMA = 1.4826;
const CHECK_NAME = "voice-consistency";

/** Stored page types treated as legal register. */
const LEGAL_PAGE_TYPES: ReadonlySet<string> = new Set(["legal"]);

interface VoicePageRecord {
  url: string;
  status: number;
  pageType: string | null;
  readingLevel: number | null;
  excluded?: boolean;
}

interface VoiceRollup {
  pageCount: number;
  skippedNoindexPages: number;
  excludedLegalPages: number;
  urls: string[];
  scores: number[];
}

function emptyRollup(): VoiceRollup {
  return { pageCount: 0, skippedNoindexPages: 0, excludedLegalPages: 0, urls: [], scores: [] };
}

function accumulatePage(rollup: VoiceRollup, record: VoicePageRecord): void {
  rollup.pageCount += 1;
  if (record.excluded) {
    rollup.skippedNoindexPages += 1;
    return;
  }
  if (record.status < 200 || record.status >= 300) return;
  const pageType = record.pageType?.trim().toLowerCase() ?? "";
  if (isLegalPage(record.url) || LEGAL_PAGE_TYPES.has(pageType)) {
    rollup.excludedLegalPages += 1;
    return;
  }
  if (record.readingLevel === null || !Number.isFinite(record.readingLevel)) return;
  rollup.urls.push(record.url);
  rollup.scores.push(record.readingLevel);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function skip(message: string, rollup?: VoiceRollup): CheckResult {
  return {
    name: CHECK_NAME,
    status: "skipped",
    message,
    ...(rollup
      ? {
          details: {
            skippedNoindexPages: rollup.skippedNoindexPages,
            excludedLegalPages: rollup.excludedLegalPages,
          },
        }
      : {}),
  };
}

function buildChecks(rollup: VoiceRollup, sitePageCount: number): CheckResult[] {
  if (sitePageCount < VOICE_MIN_PAGES) {
    return [
      skip(
        `Only ${sitePageCount} page(s) crawled; ${VOICE_MIN_PAGES} needed to establish a site voice`,
        rollup,
      ),
    ];
  }
  const sample = rollup.scores.length;
  if (sample < VOICE_MIN_SAMPLE) {
    return [
      skip(
        `Only ${sample} page(s) have enough text to score; ${VOICE_MIN_SAMPLE} needed to establish a site voice`,
        rollup,
      ),
    ];
  }

  const med = median(rollup.scores);
  const inBand = rollup.scores.filter((s) => Math.abs(s - med) <= VOICE_BAND).length;
  if (inBand / sample < VOICE_MIN_AGREEMENT) {
    return [skip("The pages' reading levels do not cluster around one norm, so no page is an outlier", rollup)];
  }

  const mad = median(rollup.scores.map((s) => Math.abs(s - med)));
  const sigma = Math.max(MAD_TO_SIGMA * mad, VOICE_SIGMA_FLOOR);
  const gap = Math.max(VOICE_MIN_GAP, VOICE_MIN_Z * sigma);

  const outliers: { url: string; score: number; delta: number }[] = [];
  for (const [i, score] of rollup.scores.entries()) {
    const delta = score - med;
    if (Math.abs(delta) >= gap) outliers.push({ url: rollup.urls[i]!, score, delta });
  }

  const details: Record<string, unknown> = {
    scoredPages: sample,
    medianFlesch: med,
    mad,
    flaggedPages: outliers.length,
    skippedNoindexPages: rollup.skippedNoindexPages,
    excludedLegalPages: rollup.excludedLegalPages,
  };

  if (outliers.length === 0) {
    return [
      {
        name: CHECK_NAME,
        status: "pass",
        message: `All ${sample} scored page(s) read at the site's level (median Flesch ${med})`,
        value: sample,
        details,
      },
    ];
  }

  outliers.sort(
    (a, b) => Math.abs(b.delta) - Math.abs(a.delta) || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0),
  );
  const items: CheckItem[] = outliers.slice(0, VOICE_MAX_ITEMS).map((o) => ({
    id: o.url,
    label: `Flesch ${o.score} vs the site norm of ${med} (${o.delta < 0 ? "harder" : "easier"} to read by ${Math.round(Math.abs(o.delta))} points)`,
    sourcePages: [o.url],
    meta: { fleschScore: o.score, medianFlesch: med },
  }));

  return [
    {
      name: CHECK_NAME,
      status: "info",
      message: `${outliers.length} of ${sample} page(s) read at a very different level from the rest of the site (median Flesch ${med})`,
      value: outliers.length,
      items,
      details,
    },
  ];
}

async function runViaSiteQuery(siteQuery: SiteQuery, skipNoindex: boolean): Promise<RuleResult> {
  const rollup = emptyRollup();
  for await (const row of siteQuery.pagesMatching(() => true)) {
    accumulatePage(rollup, {
      url: row.normalizedUrl,
      status: row.status,
      pageType: row.pageType,
      readingLevel: row.readingLevel ?? null,
      excluded: skipNoindex && row.robotsNoindex,
    });
  }
  return { checks: buildChecks(rollup, siteQuery.pageCount()) };
}

export const voiceConsistencyRule: Rule = {
  meta: {
    id: "content/voice-consistency",
    name: "Voice Consistency",
    description: "Finds pages whose reading level is far from the site's own norm",
    solution:
      "These pages read at a very different level from the rest of your site: a page written by a different author, text pasted in from another source, or bulk-generated copy usually shows up this way. Check each one. If it is meant to sound like the rest of the site, rewrite it in the site's voice (sentence length and word choice drive the score). If it is deliberately different (a technical reference, a children's section), that is fine. Legal pages are not judged, because their register is different on purpose.",
    category: "content",
    scope: "site",
    severity: "info",
    weight: 2,
  },

  run(ctx: RuleContext): RuleResult | Promise<RuleResult> {
    if (ctx.siteQuery) {
      return runViaSiteQuery(ctx.siteQuery, skipsNoindexPages(ctx.site));
    }

    const pages = ctx.site?.pages;
    if (!pages || pages.length === 0) {
      return { checks: [skip("No pages available for analysis")] };
    }

    const rollup = emptyRollup();
    for (const page of pages) {
      accumulatePage(rollup, {
        url: page.url,
        status: page.statusCode,
        pageType: page.parsed?.pageType ?? null,
        readingLevel: pageReadingLevel(page.parsed),
        excluded: excludesNoindexPage(ctx.site, page.parsed, page.headers),
      });
    }
    return { checks: buildChecks(rollup, rollup.pageCount) };
  },
};
