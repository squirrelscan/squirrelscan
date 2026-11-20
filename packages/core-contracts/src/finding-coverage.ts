/**
 * Per-finding coverage for a partial audit (squirrelscan/squirrelscan#2079).
 *
 * A smart audit re-checks some pages and carries the rest. A consumer that decides whether an issue
 * can resolve needs, per rule check, how many pages held an open finding going in and how many of
 * those this run looked at again. This module folds that into `coverage.findings` and states the
 * page set the caller asked the run to check as `coverage.requested`.
 *
 * Counts only, no threshold: whether "3 of 40 pages re-checked" is enough to resolve an issue is the
 * consumer's call. Pure and dependency-free, so the engine, the renderers and the hosted merge share it.
 */

/** Page rows listed individually; the counts are always exact. */
export const FINDING_COVERAGE_MAX_ROWS = 100;
/** Requested URLs listed individually; `pages` is always exact. */
export const REQUESTED_PAGES_MAX_URLS = 100;

/** `coverage.requested`: the page set the caller asked this run to check. */
export interface RequestedPages {
  /** Distinct pages requested. */
  pages: number;
  /** Of those, the ones this run re-observed (fetched and judged, gone, or redirected). */
  rechecked: number;
  /** Requested pages listed, sorted; clipped at {@link REQUESTED_PAGES_MAX_URLS}. */
  urls: string[];
  /** Set when `urls` was clipped. */
  urlsTruncated?: true;
}

/** One rule check with open findings going into the run. */
export interface FindingCoverageRow {
  ruleId: string;
  checkName: string;
  /** Pages that held an open finding of this check before this run. */
  pagesHeld: number;
  /** Of those, pages this run re-checked: the finding was re-observed or resolved. */
  pagesRechecked: number;
  /** Of those, pages left carried: `pagesHeld` minus `pagesRechecked`. */
  pagesCarried: number;
}

export interface FindingCoverage {
  rows: FindingCoverageRow[];
  /** Set when `rows` was clipped; the rows kept are those with the most carried pages. */
  truncated?: true;
}

export interface HeldFinding {
  normalizedUrl: string;
  ruleId: string;
  checkName: string;
}

const SEP = "\u0000";

/**
 * Fold the open findings that entered a run and the ones it left carried into one row per rule check.
 * Null when nothing was held, so a first run's report is byte-identical to before.
 */
export function summarizeFindingCoverage(input: {
  /** Open findings before this run's merge. */
  held: Iterable<HeldFinding>;
  /** Findings still carried after the merge (never re-observed this run). */
  carried: Iterable<HeldFinding>;
}): FindingCoverage | null {
  const pagesByCheck = new Map<string, { ruleId: string; checkName: string; pages: Set<string> }>();
  for (const f of input.held) {
    const key = `${f.ruleId}${SEP}${f.checkName}`;
    let entry = pagesByCheck.get(key);
    if (!entry) {
      entry = { ruleId: f.ruleId, checkName: f.checkName, pages: new Set() };
      pagesByCheck.set(key, entry);
    }
    entry.pages.add(f.normalizedUrl);
  }
  if (pagesByCheck.size === 0) return null;

  const carriedByCheck = new Map<string, Set<string>>();
  for (const f of input.carried) {
    const key = `${f.ruleId}${SEP}${f.checkName}`;
    // A carried page that was not held is not this run's to report (it entered some other way).
    if (!pagesByCheck.get(key)?.pages.has(f.normalizedUrl)) continue;
    let set = carriedByCheck.get(key);
    if (!set) carriedByCheck.set(key, (set = new Set()));
    set.add(f.normalizedUrl);
  }

  const rows: FindingCoverageRow[] = [];
  for (const [key, entry] of pagesByCheck) {
    const pagesHeld = entry.pages.size;
    const pagesCarried = carriedByCheck.get(key)?.size ?? 0;
    rows.push({
      ruleId: entry.ruleId,
      checkName: entry.checkName,
      pagesHeld,
      pagesRechecked: pagesHeld - pagesCarried,
      pagesCarried,
    });
  }
  rows.sort(
    (a, b) =>
      b.pagesCarried - a.pagesCarried ||
      (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0) ||
      (a.checkName < b.checkName ? -1 : a.checkName > b.checkName ? 1 : 0),
  );
  const clipped = rows.length > FINDING_COVERAGE_MAX_ROWS;
  return {
    rows: clipped ? rows.slice(0, FINDING_COVERAGE_MAX_ROWS) : rows,
    ...(clipped ? { truncated: true as const } : {}),
  };
}

/**
 * State the requested set and how much of it the run re-observed. Null when nothing was requested.
 * `observed` is every page the run re-observed, gone and redirecting pages included.
 */
export function summarizeRequestedPages(input: {
  requested: Iterable<string>;
  observed: ReadonlySet<string>;
}): RequestedPages | null {
  const requested = [...new Set(input.requested)].sort();
  if (requested.length === 0) return null;
  const clipped = requested.length > REQUESTED_PAGES_MAX_URLS;
  return {
    pages: requested.length,
    rechecked: requested.filter((u) => input.observed.has(u)).length,
    urls: clipped ? requested.slice(0, REQUESTED_PAGES_MAX_URLS) : requested,
    ...(clipped ? { urlsTruncated: true as const } : {}),
  };
}
