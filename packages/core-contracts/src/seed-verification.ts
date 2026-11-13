/**
 * What became of the pages an earlier audit left with open findings
 * (squirrelscan/squirrelscan#1759).
 *
 * A page that is unlinked, moved or deleted keeps its open findings carried from
 * audit to audit. A run may seed such pages into the crawl (`carriedSeedUrls`) so
 * they are looked at again inside the page budget. This module turns the run's
 * evidence (the pages it fetched, the frontier it left) into the one answer the
 * report states: how many of those pages were re-verified and how, and how many
 * were left carried, and why.
 *
 * Pure and dependency-free so the audit engine, the renderers and the hosted
 * merge can all use it. It never changes what the merge resolves or carries: a
 * page this run chose not to visit keeps today's carried behaviour, and is only
 * counted.
 */

/** Statuses that mean a page is gone (the merge stales its findings). */
const GONE_STATUSES: ReadonlySet<number> = new Set([404, 410]);

/** Page rows listed individually; the counts are always exact. */
export const SEED_VERIFICATION_MAX_PAGES = 100;

/**
 * How a known page with open findings ended up this run.
 *  - `live`: re-fetched and answered 2xx. Its findings are fresh; a live page no
 *    link reaches is left to the orphan-page rules, which read the crawl's link
 *    graph.
 *  - `gone`: answered 404 or 410. Its findings resolve; `status` names which.
 *  - `redirected`: answered with a redirect off its old URL. Its page-level
 *    findings resolve (the URL is a redirect, not a page); `destination` and
 *    `status` record it.
 *  - `skipped-budget`: queued but not fetched before the page budget or time
 *    limit stopped the crawl. Left carried.
 *  - `not-linked`: not reached by the crawl at all (no link, sitemap entry or
 *    seed queued it). Left carried.
 *  - `unverified`: fetched or queued, but the answer proved nothing (a 5xx, a
 *    rate limit or bot wall, a failed fetch) or the URL is now refused by scope
 *    or robots. Left carried, and counted apart so it is never read as "gone".
 */
export type SeedPageOutcome =
  | "live"
  | "gone"
  | "redirected"
  | "skipped-budget"
  | "not-linked"
  | "unverified";

export interface SeedPageVerification {
  url: string;
  outcome: SeedPageOutcome;
  /** HTTP status of the answer: the source's own 3xx for a redirect. Absent when the page was not fetched. */
  status?: number;
  /** Where a `redirected` page now leads. */
  destination?: string;
}

/** `coverage.seedVerification` on a report. */
export interface SeedVerification {
  /** Known pages with open findings that entered this run. */
  knownPages: number;
  /** Of those, the ones the run queued as seeds. */
  seeded: number;
  /** Re-verified this run: `live` + `gone` + `redirected`. */
  reverified: number;
  live: number;
  gone: number;
  redirected: number;
  /** Left carried: `skippedByBudget` + `noLongerLinked` + `unverified`. */
  leftCarried: number;
  skippedByBudget: number;
  noLongerLinked: number;
  unverified: number;
  /** Pages with their outcome, redirects and gone pages first; clipped at {@link SEED_VERIFICATION_MAX_PAGES}. */
  pages: SeedPageVerification[];
  /** Set when `pages` was clipped. */
  pagesTruncated?: boolean;
}

export interface SeedVerificationPage {
  normalizedUrl: string;
  status: number;
  /** Where the page led, for a redirect row. */
  finalUrl?: string;
  /** The row is a redirect, not a page (its findings resolve). */
  redirect?: boolean;
}

export interface SeedVerificationFrontier {
  normalizedUrl: string;
  /** Frontier status: `pending`, `fetching`, `done`, `failed` or `skipped`. */
  status: string;
  /** Why a `skipped` entry was refused (`over_max_pages`, scope, robots...). */
  reason?: string;
}

export interface SeedVerificationInput {
  /** Normalized URLs of the pages that entered the run with open findings. */
  carriedPages: Iterable<string>;
  /** Normalized URLs the run queued as carried seeds. */
  seeded?: Iterable<string>;
  /** Every page row this run stored. */
  pages: Iterable<SeedVerificationPage>;
  /** The run's frontier, for pages it queued and did not fetch. */
  frontier?: Iterable<SeedVerificationFrontier>;
}

/** Skip reasons that are the page budget or the time limit, not a refusal of the URL. */
function isBudgetSkip(entry: SeedVerificationFrontier): boolean {
  if (entry.status === "pending" || entry.status === "fetching") return true;
  return (
    entry.status === "skipped" &&
    (entry.reason === "over_max_pages" ||
      entry.reason === "max_pages" ||
      entry.reason === "budget" ||
      entry.reason === "crawl_timeout" ||
      entry.reason === "max_duration")
  );
}

const ORDER: Record<SeedPageOutcome, number> = {
  redirected: 0,
  gone: 1,
  live: 2,
  unverified: 3,
  "skipped-budget": 4,
  "not-linked": 5,
};

/**
 * Classify every known page with open findings and count the outcomes. Null when
 * there are no such pages, so a report without any is byte-identical to before.
 */
export function summarizeSeedVerification(input: SeedVerificationInput): SeedVerification | null {
  const carried = new Set(input.carriedPages);
  if (carried.size === 0) return null;
  const seeded = new Set<string>();
  for (const url of input.seeded ?? []) if (carried.has(url)) seeded.add(url);

  const pages = new Map<string, SeedVerificationPage>();
  for (const page of input.pages)
    if (carried.has(page.normalizedUrl)) pages.set(page.normalizedUrl, page);
  const frontier = new Map<string, SeedVerificationFrontier>();
  for (const entry of input.frontier ?? []) {
    if (carried.has(entry.normalizedUrl)) frontier.set(entry.normalizedUrl, entry);
  }

  const rows: SeedPageVerification[] = [];
  for (const url of carried) {
    const page = pages.get(url);
    if (page) {
      if (page.redirect === true) {
        rows.push({
          url,
          outcome: "redirected",
          status: page.status,
          ...(page.finalUrl && page.finalUrl !== url ? { destination: page.finalUrl } : {}),
        });
      } else if (GONE_STATUSES.has(page.status)) {
        rows.push({ url, outcome: "gone", status: page.status });
      } else if (page.status >= 200 && page.status < 300) {
        rows.push({ url, outcome: "live", status: page.status });
      } else {
        rows.push({ url, outcome: "unverified", status: page.status });
      }
      continue;
    }
    const entry = frontier.get(url);
    if (entry) {
      rows.push({ url, outcome: isBudgetSkip(entry) ? "skipped-budget" : "unverified" });
    } else {
      // Seeded but never queued means the crawl refused the URL (scope, robots, length).
      rows.push({ url, outcome: seeded.has(url) ? "unverified" : "not-linked" });
    }
  }

  const count = (outcome: SeedPageOutcome) => rows.filter((r) => r.outcome === outcome).length;
  const live = count("live");
  const gone = count("gone");
  const redirected = count("redirected");
  const skippedByBudget = count("skipped-budget");
  const noLongerLinked = count("not-linked");
  const unverified = count("unverified");
  rows.sort(
    (a, b) => ORDER[a.outcome] - ORDER[b.outcome] || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0),
  );
  const clipped = rows.length > SEED_VERIFICATION_MAX_PAGES;
  return {
    knownPages: carried.size,
    seeded: seeded.size,
    reverified: live + gone + redirected,
    live,
    gone,
    redirected,
    leftCarried: skippedByBudget + noLongerLinked + unverified,
    skippedByBudget,
    noLongerLinked,
    unverified,
    pages: clipped ? rows.slice(0, SEED_VERIFICATION_MAX_PAGES) : rows,
    ...(clipped ? { pagesTruncated: true } : {}),
  };
}

/**
 * One sentence for a report, e.g. "Known pages with open findings: 12 re-verified (2 gone, 3
 * redirected, 7 still live), 4 left carried (3 skipped by the page budget, 1 no longer linked)."
 * Counts only: stored reports of any origin reach this, so anything that is not a whole number is
 * read as zero and no URL is printed.
 */
export function seedVerificationLine(
  value: Partial<SeedVerification> | null | undefined,
): string | null {
  if (!value || typeof value !== "object") return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : 0);
  const reverified = n(value.reverified);
  const left = n(value.leftCarried);
  if (reverified + left === 0) return null;
  const part = (count: number, label: string) => (count > 0 ? `${count} ${label}` : "");
  const join = (parts: string[]) => parts.filter(Boolean).join(", ");
  const re = join([
    part(n(value.gone), "gone"),
    part(n(value.redirected), "redirected"),
    part(n(value.live), "still live"),
  ]);
  const lc = join([
    part(n(value.skippedByBudget), "skipped by the page budget"),
    part(n(value.noLongerLinked), "no longer linked"),
    part(n(value.unverified), "could not be verified"),
  ]);
  return `Known pages with open findings: ${reverified} re-verified${re ? ` (${re})` : ""}, ${left} left carried${lc ? ` (${lc})` : ""}.`;
}
