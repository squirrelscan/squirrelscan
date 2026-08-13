// content/title-pattern-outlier - titles that break the site's own title template (#1361)
//
// core/meta-title judges ONE title against fixed ideas of a good title (present,
// long enough, not too long). None of the per-page rules can see that a site titles
// 96% of its pages "Page name | Acme" and then ships a pocket of pages with no
// brand, the brand at the wrong end, or a different separator. That inconsistency is
// invisible per page and obvious across a corpus, so the template is inferred from
// the site itself and only the minority form is reported.
//
// What is inferred, in order:
//   1. the modal brand affix - the segment that most titles carry at the same end
//      (prefix or suffix), after splitting on `|`, `::`, `»`, `>`, ` - `, `: `
//   2. the modal separator that sits next to that brand
// Deviations, one class per page, most meaningful first:
//   brand-only      the title is nothing but the brand
//   brand-missing   the title never mentions the brand the rest of the site carries
//   brand-position  the brand is at the opposite end from the norm
//   separator       the brand is separated by something other than the modal separator
//
// Guards, in the order they matter:
//   1. Site floor (TITLE_NORM_MIN_PAGES) - a small crawl has no norm to speak of.
//   2. Sample floor (TITLE_NORM_MIN_SAMPLE) - too few titled pages to vote.
//   3. Modal agreement (TITLE_NORM_MIN_AGREEMENT) - a site whose titles do not
//      concentrate on one brand affix is legitimately heterogeneous and nothing in
//      it is a deviant. Skipping beats accusing a healthy site.
//   4. Cross-section evidence - on a multi-section site the brand candidate must be
//      seen in at least two sections, so a section label ("Blog | Post name") that
//      happens to dominate a lopsided crawl is never mistaken for the brand
//      (the trap from url/slug-convention's trailing-slash axis, #1366).
//   5. The homepage is exempt: "Acme - tools for X" is a normal home title and a
//      normal deviation from the template every other page follows.
// Together these mean a site whose titles follow no dominant template stays clean,
// and pages generated from the same template sit inside the norm by construction.
// A site running SEVERAL templates that disagree with each other (products joined by
// "::", collections by "|") is a finding rather than an exemption: unlike a trailing
// slash, which is a per-section decision (#1366), the title template comes from one
// layout and is one decision for the whole site. What is exempted is a template whose
// pages agree with the rest of the site, not one that is merely internally uniform.
//
// Precedence over core/meta-title (#1361): that rule owns missing/empty titles, so a
// page with no title never votes and is never a deviant here. Above that, meta-title
// only judges length, which is a different finding from template drift.
//
// Dual path: `ctx.siteQuery` streams (normalizedUrl, title) straight off
// page_features; the legacy path reads the same two fields from `ctx.site.pages`.
// Both feed ONE accumulator and ONE check builder, and every list is sorted before
// it is emitted, so the output is byte-identical by construction and independent of
// crawl order (same shape as content/duplicate-title, #1021/#1022).

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";
import type { CheckItem, SiteQuery } from "@squirrelscan/core-contracts";

/** Crawl-wide page floor: below this there is no site norm to judge against. */
export const TITLE_NORM_MIN_PAGES = 10;

/** Titled 2xx pages needed before a template is inferred at all. */
export const TITLE_NORM_MIN_SAMPLE = 10;

/** Pages needed in the separator vote before that dimension is judged. */
export const TITLE_NORM_MIN_SEPARATOR_SAMPLE = 10;

/**
 * Share of titled pages that must carry the same brand affix before it is treated
 * as the site's template. Below this the site genuinely mixes and no page deviates.
 */
export const TITLE_NORM_MIN_AGREEMENT = 0.7;

/** Share of judged pages that turns the warning into a failure. */
export const TITLE_NORM_FAIL_SHARE = 0.2;

/** Caps on reported items / urls, so one rule cannot bloat a report. */
const TITLE_NORM_MAX_ITEMS = 10;
const TITLE_NORM_MAX_URLS = 10;

const CHECK_NAME = "title-pattern-outlier";

/**
 * Title separators. `|`, `::`, `»` and `>>` are unambiguous, so padding is optional;
 * the dashes, the middot, the single `>` and the colon only separate when whitespace
 * says they do ("e-commerce" and "10:30" are not two segments).
 *
 * A title whose brand is joined by something NOT in this set (or by nothing at all)
 * simply casts no separator vote: it is never reported as using "the wrong
 * separator", because the rule has no evidence about what it used.
 */
const SEPARATOR_RE = /\s*(?:::|\||»|>>)\s*|\s+[-–—·>]\s+|:\s+/g;

/** Deviation classes, in the order they are reported. */
const CLASSES = ["brand-only", "brand-missing", "brand-position", "separator"] as const;
type DeviationClass = (typeof CLASSES)[number];

type BrandPosition = "prefix" | "suffix";

/** One page's contribution, from either path. */
interface TitlePageRecord {
  url: string;
  status: number;
  title: string | null;
}

/** A titled page the rule can judge. */
interface TitleSample {
  url: string;
  title: string;
  /** First path segment, or "/" for a single-segment or root path. */
  section: string;
  isRoot: boolean;
}

interface TitleRollup {
  /** Pages seen by the rule (both paths count the same universe). */
  pageCount: number;
  samples: TitleSample[];
}

/** A brand affix the corpus voted for. */
interface BrandCandidate {
  position: BrandPosition;
  /** Normalized comparison key. */
  key: string;
  count: number;
  sections: Set<string>;
  /** raw form -> times seen, so the reported spelling never depends on crawl order. */
  raws: Map<string, number>;
}

interface BrandNorm {
  position: BrandPosition;
  key: string;
  label: string;
  count: number;
  share: number;
}

interface SeparatorNorm {
  value: string;
  count: number;
  total: number;
  share: number;
}

interface Deviation {
  class: DeviationClass;
  url: string;
  /** The form this page used, for the item meta. */
  value: string;
}

function emptyRollup(): TitleRollup {
  return { pageCount: 0, samples: [] };
}

/** Whitespace-collapsed, trimmed. */
function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Comparison key: case- and whitespace-insensitive. */
function normalizeKey(value: string): string {
  return collapse(value).toLowerCase();
}

function pathOf(url: string): string | null {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return null;
  }
}

function segmentsOf(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

/**
 * Split a title into segments plus the separator used at each boundary.
 * `seps[i]` is the separator between `segments[i]` and `segments[i + 1]`.
 */
function splitTitle(title: string): { segments: string[]; seps: string[] } {
  const segments: string[] = [];
  const seps: string[] = [];
  let last = 0;
  SEPARATOR_RE.lastIndex = 0;
  for (let m = SEPARATOR_RE.exec(title); m !== null; m = SEPARATOR_RE.exec(title)) {
    // A separator with nothing before it is decoration, not a boundary.
    const segment = title.slice(last, m.index).trim();
    if (segment.length === 0) {
      last = m.index + m[0].length;
      continue;
    }
    segments.push(segment);
    seps.push(m[0].trim());
    last = m.index + m[0].length;
  }
  const tail = title.slice(last).trim();
  if (tail.length > 0) segments.push(tail);
  // A trailing separator leaves one more sep than boundaries; drop it.
  while (seps.length >= segments.length && seps.length > 0) seps.pop();
  return { segments, seps };
}

/**
 * Fold one page in. Untitled pages belong to core/meta-title and never vote here,
 * so this rule cannot accuse a page that one already owns.
 */
function accumulatePage(rollup: TitleRollup, record: TitlePageRecord): void {
  rollup.pageCount += 1;

  if (record.status < 200 || record.status >= 300) return;
  const title = collapse(record.title ?? "");
  if (title.length === 0) return;
  const path = pathOf(record.url);
  if (path === null) return;

  const segments = segmentsOf(path);
  rollup.samples.push({
    url: record.url,
    title,
    // Single-segment paths share the root bucket, or a flat site shatters into one
    // section per page and nothing ever clears the cross-section bar.
    section: segments.length > 1 ? segments[0]!.toLowerCase() : "/",
    isRoot: segments.length === 0,
  });
}

function candidateKey(position: BrandPosition, key: string): string {
  return `${position}:${key}`;
}

/** Most-seen raw spelling of a candidate; ties break lexicographically. */
function displayForm(raws: Map<string, number>): string {
  let best: { raw: string; count: number } | null = null;
  for (const [raw, count] of raws) {
    if (best === null || count > best.count || (count === best.count && raw < best.raw)) {
      best = { raw, count };
    }
  }
  return best!.raw;
}

/**
 * The site's brand affix, or null when no affix is dominant enough (or is only
 * evidenced inside one section of a multi-section crawl, which reads as a section
 * label rather than a brand).
 */
function inferBrand(samples: TitleSample[], multiSection: boolean): BrandNorm | null {
  const candidates = new Map<string, BrandCandidate>();

  const vote = (position: BrandPosition, raw: string, sample: TitleSample): void => {
    const key = normalizeKey(raw);
    if (key.length === 0) return;
    const id = candidateKey(position, key);
    let candidate = candidates.get(id);
    if (!candidate) {
      candidate = { position, key, count: 0, sections: new Set(), raws: new Map() };
      candidates.set(id, candidate);
    }
    candidate.count += 1;
    candidate.sections.add(sample.section);
    candidate.raws.set(collapse(raw), (candidate.raws.get(collapse(raw)) ?? 0) + 1);
  };

  for (const sample of samples) {
    const { segments } = splitTitle(sample.title);
    if (segments.length < 2) continue;
    vote("prefix", segments[0]!, sample);
    vote("suffix", segments[segments.length - 1]!, sample);
  }

  let best: BrandCandidate | null = null;
  for (const candidate of candidates.values()) {
    // A single-section candidate on a multi-section site is a section label.
    if (multiSection && candidate.sections.size < 2) continue;
    if (
      best === null ||
      candidate.count > best.count ||
      (candidate.count === best.count &&
        candidateKey(candidate.position, candidate.key) <
          candidateKey(best.position, best.key))
    ) {
      best = candidate;
    }
  }

  if (best === null) return null;
  const share = best.count / samples.length;
  if (share < TITLE_NORM_MIN_AGREEMENT) return null;
  return {
    position: best.position,
    key: best.key,
    label: displayForm(best.raws),
    count: best.count,
    share,
  };
}

/** The separator this page puts next to the brand, or null when it has none. */
function brandSeparator(sample: TitleSample, brand: BrandNorm): string | null {
  const { segments, seps } = splitTitle(sample.title);
  if (segments.length < 2 || seps.length === 0) return null;
  if (normalizeKey(segments[segments.length - 1]!) === brand.key) {
    return seps[seps.length - 1]!;
  }
  if (normalizeKey(segments[0]!) === brand.key) return seps[0]!;
  return null;
}

/** The modal separator sitting next to the brand, or null when there is no norm. */
function inferSeparator(samples: TitleSample[], brand: BrandNorm): SeparatorNorm | null {
  const votes = new Map<string, number>();
  let total = 0;
  for (const sample of samples) {
    const sep = brandSeparator(sample, brand);
    if (sep === null) continue;
    votes.set(sep, (votes.get(sep) ?? 0) + 1);
    total += 1;
  }
  if (total < TITLE_NORM_MIN_SEPARATOR_SAMPLE) return null;

  let best: { value: string; count: number } | null = null;
  for (const [value, count] of votes) {
    if (best === null || count > best.count || (count === best.count && value < best.value)) {
      best = { value, count };
    }
  }
  if (best === null) return null;
  const share = best.count / total;
  if (share < TITLE_NORM_MIN_AGREEMENT) return null;
  return { value: best.value, count: best.count, total, share };
}

/**
 * Where the brand sits in this title, or null when the title never mentions it.
 * Deliberately a substring test, not a segment test: a title that says the brand
 * anywhere ("About Acme Deals", "Acme Deals Sydney | Acme Deals") is not a page that
 * forgot the brand, and accusing it would be the expensive kind of wrong.
 */
function brandPlacement(sample: TitleSample, brand: BrandNorm): BrandPosition | "inline" | null {
  const key = normalizeKey(sample.title);
  if (!key.includes(brand.key)) return null;
  if (key.startsWith(brand.key)) return "prefix";
  if (key.endsWith(brand.key)) return "suffix";
  return "inline";
}

/**
 * One class per page, most meaningful first, so a page is never accused twice for
 * one root cause.
 */
function classify(
  sample: TitleSample,
  brand: BrandNorm,
  separator: SeparatorNorm | null
): Deviation | null {
  // The homepage legitimately has its own title: brand-only, brand-first and a
  // tagline separator are all normal there.
  if (sample.isRoot) return null;

  const placement = brandPlacement(sample, brand);
  if (placement === null) {
    return { class: "brand-missing", url: sample.url, value: sample.title };
  }
  if (normalizeKey(sample.title) === brand.key) {
    return { class: "brand-only", url: sample.url, value: sample.title };
  }
  if (placement !== "inline" && placement !== brand.position) {
    return { class: "brand-position", url: sample.url, value: placement };
  }

  if (separator !== null) {
    const sep = brandSeparator(sample, brand);
    if (sep !== null && sep !== separator.value) {
      return { class: "separator", url: sample.url, value: sep };
    }
  }
  return null;
}

function skip(message: string): CheckResult {
  return { name: CHECK_NAME, status: "skipped", message };
}

function positionLabel(position: BrandPosition): string {
  return position === "suffix" ? "last" : "first";
}

function classLabel(
  deviation: DeviationClass,
  count: number,
  judged: number,
  brand: BrandNorm,
  separator: SeparatorNorm | null,
  value: string
): string {
  switch (deviation) {
    case "brand-only":
      return `${count} of ${judged} page(s) have a title that is only the brand "${brand.label}"`;
    case "brand-missing":
      return `${count} of ${judged} page(s) never mention "${brand.label}", which ${Math.round(brand.share * 100)}% of titles carry`;
    case "brand-position":
      return `${count} of ${judged} page(s) put "${brand.label}" ${positionLabel(value as BrandPosition)} but the norm is ${positionLabel(brand.position)}`;
    case "separator":
      return `${count} of ${separator?.total ?? judged} page(s) separate "${brand.label}" with "${value}" but the norm is "${separator?.value ?? ""}"`;
  }
}

/**
 * The rule's full output for one rollup. ONE builder, both paths.
 *
 * `sitePageCount` is the crawl-wide page count: the streaming path takes it from
 * `siteQuery.pageCount()` (which includes rows this rule cannot sample), so the
 * site floor is judged on the crawl, not on the sampled subset.
 */
function buildChecks(rollup: TitleRollup, sitePageCount: number): CheckResult[] {
  if (sitePageCount < TITLE_NORM_MIN_PAGES) {
    return [
      skip(
        `Only ${sitePageCount} page(s) crawled; ${TITLE_NORM_MIN_PAGES} needed to establish a title template`
      ),
    ];
  }

  const samples = rollup.samples;
  if (samples.length < TITLE_NORM_MIN_SAMPLE) {
    return [
      skip(
        `Only ${samples.length} page(s) have a title; ${TITLE_NORM_MIN_SAMPLE} needed to establish a title template`
      ),
    ];
  }

  const sections = new Set(samples.map((s) => s.section));
  const brand = inferBrand(samples, sections.size >= 2);
  if (brand === null) {
    return [
      skip(
        `No title template reaches ${Math.round(TITLE_NORM_MIN_AGREEMENT * 100)}% agreement across the crawled titles`
      ),
    ];
  }

  const separator = inferSeparator(samples, brand);
  const normSummary = [
    `brand "${brand.label}" ${positionLabel(brand.position)} ${Math.round(brand.share * 100)}%`,
    separator === null
      ? null
      : `separator "${separator.value}" ${Math.round(separator.share * 100)}%`,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");

  const deviations: Deviation[] = [];
  for (const sample of samples) {
    const deviation = classify(sample, brand, separator);
    if (deviation !== null) deviations.push(deviation);
  }

  const details: Record<string, unknown> = {
    judgedPages: samples.length,
    flaggedPages: deviations.length,
    norms: [
      {
        dimension: "brand",
        norm: brand.label,
        position: brand.position,
        pages: brand.count,
        agreement: brand.share,
      },
      ...(separator === null
        ? []
        : [
            {
              dimension: "separator",
              norm: separator.value,
              pages: separator.count,
              agreement: separator.share,
            },
          ]),
    ],
  };

  if (deviations.length === 0) {
    return [
      {
        name: CHECK_NAME,
        status: "pass",
        message: `All ${samples.length} titled page(s) follow the site's own title template (${normSummary})`,
        value: samples.length,
        details,
      },
    ];
  }

  // Group by class (and, for the classes whose form varies, by that form) so one
  // finding names one root cause instead of one page.
  const groups = new Map<string, { class: DeviationClass; value: string; urls: string[] }>();
  for (const deviation of deviations) {
    const grouped =
      deviation.class === "brand-position" || deviation.class === "separator"
        ? deviation.value
        : "";
    const id = `${deviation.class}:${grouped}`;
    const group = groups.get(id);
    if (group) group.urls.push(deviation.url);
    else groups.set(id, { class: deviation.class, value: grouped, urls: [deviation.url] });
  }

  // Biggest group first; the class order breaks ties so the list never depends on
  // crawl order.
  const ordered = [...groups.values()].sort(
    (a, b) =>
      b.urls.length - a.urls.length ||
      CLASSES.indexOf(a.class) - CLASSES.indexOf(b.class) ||
      (a.value < b.value ? -1 : a.value > b.value ? 1 : 0)
  );

  const items: CheckItem[] = ordered.slice(0, TITLE_NORM_MAX_ITEMS).map((group) => ({
    id: `${group.class}:${group.value}`,
    label: classLabel(
      group.class,
      group.urls.length,
      samples.length,
      brand,
      separator,
      group.value
    ),
    sourcePages: group.urls.sort().slice(0, TITLE_NORM_MAX_URLS),
    meta: {
      deviation: group.class,
      value: group.value,
      brand: brand.label,
      pageCount: group.urls.length,
    },
  }));

  const share = deviations.length / samples.length;
  return [
    {
      name: CHECK_NAME,
      status: share >= TITLE_NORM_FAIL_SHARE ? "fail" : "warn",
      message: `${deviations.length} of ${samples.length} titled page(s) break the site's own title template (${normSummary})`,
      value: deviations.length,
      items,
      details,
    },
  ];
}

/**
 * Streaming path (#1361): read (normalizedUrl, title) off the page_features cursor.
 * Only the titles stay resident - the same bounded scalars content/duplicate-title
 * already holds; no parsed page is kept.
 *
 * The site floor is judged on `pageCount()`, which counts page_features rows; the
 * legacy universe additionally carries the error pages v1 appends to `site.pages`.
 * That is a property of this seam shared with every site rule on it (see
 * content/duplicate-title), not something specific to this rule.
 */
async function runViaSiteQuery(siteQuery: SiteQuery): Promise<RuleResult> {
  const rollup = emptyRollup();
  for await (const row of siteQuery.pagesMatching(() => true)) {
    accumulatePage(rollup, {
      url: row.normalizedUrl,
      status: row.status,
      title: row.title,
    });
  }

  return { checks: buildChecks(rollup, siteQuery.pageCount()) };
}

export const titlePatternOutlierRule: Rule = {
  meta: {
    id: "content/title-pattern-outlier",
    name: "Title Template Consistency",
    description: "Finds pages whose title breaks the template the rest of the site follows",
    solution:
      "Most of your pages title themselves the same way - a page name, a separator, and your brand - and these pages do not. Inconsistent titles cost you brand recall in the search results and make templated pages look hand-edited or broken. Fix the template at its source (the layout or CMS field that builds the title) rather than page by page, keeping the brand on the same side with the same separator everywhere. A page that deliberately differs, like the homepage or a campaign landing page, is fine: the point is that a handful of pages should not be the exception.",
    category: "content",
    scope: "site",
    severity: "warning",
    // Deliberately light: one site-wide check, capped items, so a single rule
    // cannot dominate the content category score.
    weight: 3,
  },

  run(ctx: RuleContext): RuleResult | Promise<RuleResult> {
    if (ctx.siteQuery) {
      return runViaSiteQuery(ctx.siteQuery);
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
        title: page.parsed?.meta?.title ?? null,
      });
    }

    return { checks: buildChecks(rollup, rollup.pageCount) };
  },
};
