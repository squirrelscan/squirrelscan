// Byte-budget batch sizing for the streamed pipeline (#1860).
//
// Every streamed walk holds one batch of pages live: read, parse, use, drop.
// Peak RSS is therefore `batch × per-page cost`, and per-page cost is set by the
// SITE, not by us — a docs site's 20 KB pages and a Shopify product page's 1 MB
// differ by fifty times. A fixed page count cannot be right for both. At 50
// pages it is generous for the first and, measured on ~1 MB pages, a 400-670 MB
// swing for the second; the same 50 on a light site wastes the headroom it was
// sized for and makes the walk slower than it needs to be.
//
// So the batch is sized from a BYTE budget instead: how much raw html we are
// willing to hold at once. Pages per batch falls out of the site's own average
// page size. The budget is the thing an operator actually reasons about against
// a container's memory ceiling, and it holds across site shapes without a
// per-site override.
//
// The budget counts RAW HTML bytes, not the parsed footprint. Parsing multiplies
// it — measured around 13x on script-heavy ~1 MB pages, less on lighter markup —
// so the budget is not a memory limit, it is the input that determines one. It
// is deliberately the quantity we can measure exactly and cheaply, rather than a
// parsed-size estimate that would be wrong per site in a way nobody could debug.

import { Effect } from "effect";

import type { SQLiteStorage } from "@squirrelscan/crawler";

/**
 * Default raw-html bytes held per batch. 48 MB parses to roughly 600 MB on the
 * heaviest pages measured, which fits a standard-3 container (8 GiB) alongside
 * the crawl's own high-water and the report tail with room to spare. That
 * sizing predates the sweep below and is not established by it.
 *
 * WHAT WAS MEASURED (scripts/batch-budget-sweep.ts, 150 real 959 KB pages, peak
 * read from the OS rather than an in-process sampler, batch resolved from the
 * budget by this module, three runs per budget, one machine, one load):
 *
 *   budget    batch    peak RSS over 3 runs
 *     6 MB        6      480, 486, 516 MB
 *    12 MB       12      357, 401, 417 MB
 *    24 MB       25      492, 517, 592 MB
 *    48 MB       51      579, 634, 635 MB
 *    96 MB      102      682, 705, 706 MB
 *
 * OBSERVATIONS, and deliberately not more than these.
 *
 * No budget tried produced a peak under 357 MB, and an 8.5-fold larger batch
 * (12 to 102 pages) produced a peak 1.9 times larger on the minima and 2.0
 * times larger taking the extremes. What that means for the invariant part
 * of the peak is not established here: five budgets on one fixture cannot
 * identify a component or say what it is made of. Do not read a formula off
 * these points either — a straight line through the ends misses the middle of
 * its own table by 100 MB, and the spread within a single budget runs from 24 to
 * 100 MB.
 *
 * All three runs at a 6 MB budget peaked above all three at 12 MB. Two things
 * differ between them at once — the batch holds less, and the same crawl takes
 * about twice as many read-parse-collect cycles — so this is a reason not to
 * assume the direction, not a threshold and not a cause. If a container is
 * tight, measure the budget you intend to set.
 *
 * The incremental RSS one batch costs is much smaller after a run than before
 * it: 51 pages cost 312 MB of fresh RSS from a standing start and 41 MB again
 * afterwards; 12 pages cost 89 MB and then 0. The two arms are not controlled
 * against each other — after the run, SQLite's cache, the OS page cache, the
 * parser and the JIT are all warm — so each of those is an alternative
 * explanation, and this does not measure how much of the residency is reusable.
 *
 * Bun honours mimalloc's environment options — `MIMALLOC_VERBOSE=1` prints its
 * option dump — so `MIMALLOC_PURGE_DELAY=0`, which asks it to decommit freed
 * pages immediately, is a setting that reaches the allocator. One run per cell
 * (`--mimalloc`):
 *
 *   budget      default    purge delay 0
 *     6 MB       303 MB           312 MB
 *    12 MB       370 MB           362 MB
 *    24 MB       541 MB           582 MB
 *    48 MB       552 MB           878 MB
 *    96 MB      1070 MB           719 MB
 *
 * The differences are +9, -8, +41, +326 and -351 MB. They go both ways and the
 * two largest exceed the whole within-budget spread above, but one run per cell
 * cannot separate an allocator effect from run variability in either direction.
 * This is a reason to measure the setting before relying on it, not evidence
 * that it does nothing.
 *
 * Every peak in the table is a whole child process's high-water — universe, site
 * fetch, page loop, site query, site rules, assembly — because that is what a
 * container is charged for. The budget sizes more than one of those phases, so
 * none of the table attributes a peak to the page loop alone. And the values are
 * one machine under one load: re-running two of these budgets while the machine
 * was busy gave 515 and 845 MB where the table says 357 and 579. The shape is
 * the finding; the numbers are not a spec, and a container is not safe because
 * it exceeds one of them.
 */
export const STREAM_BATCH_BYTES = 48 * 1024 * 1024;

/**
 * Floor: below this the per-batch storage round-trips start to dominate.
 *
 * Left where it is deliberately. The sweep above found a 6-page batch peaking
 * higher than a 12-page one, but raising this clamp would bind at the NEW
 * threshold rather than fixing that case, and it only engages at all when the
 * budget divided by the average page falls under it — at the default budget,
 * pages of nearly 10 MB. Moving it is a change to the budget's meaning at every
 * size, on the evidence of two adjacent points.
 */
export const STREAM_BATCH_MIN_PAGES = 5;

/** Ceiling: a light-page site must not talk itself into a whole-crawl batch. */
export const STREAM_BATCH_MAX_PAGES = 500;

/** Pages sampled to estimate the site's average page size. */
const SIZE_SAMPLE_PAGES = 12;

/**
 * A finite positive integer, or `fallback`.
 *
 * Every number in this module ends up as a SQLite `LIMIT`/`OFFSET`, where the
 * failure modes are silent and severe: `limit: 0` and `limit: NaN` are both
 * falsy, so the query drops the LIMIT clause and returns the whole crawl, and a
 * `NaN` offset never advances — an infinite loop re-reading every page forever.
 * A fractional limit is a SQLite bind error. So nothing reaches a query without
 * passing through here, including caller-supplied bounds.
 */
function toPositiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const floored = Math.floor(value);
  return floored >= 1 ? floored : fallback;
}

/**
 * Pages per batch for a site whose average page is `avgPageBytes` of html.
 *
 * A non-positive or non-finite average (an empty crawl, a crawl of pages with no
 * stored html) yields the floor rather than a division by zero: a tiny batch is
 * always safe, and the walk is over almost immediately anyway.
 */
export function resolveStreamBatchPages(opts: {
  avgPageBytes: number;
  byteBudget?: number;
  minPages?: number;
  maxPages?: number;
}): number {
  const min = toPositiveInt(opts.minPages, STREAM_BATCH_MIN_PAGES);
  const max = Math.max(min, toPositiveInt(opts.maxPages, STREAM_BATCH_MAX_PAGES));
  const budget = toPositiveInt(opts.byteBudget, STREAM_BATCH_BYTES);
  if (!Number.isFinite(opts.avgPageBytes) || opts.avgPageBytes <= 0) return min;
  const pages = Math.floor(budget / opts.avgPageBytes);
  // `pages` is finite here (finite budget over a positive finite average), so the
  // clamp cannot propagate a NaN.
  return Math.min(max, Math.max(min, pages));
}

/**
 * Average stored html bytes per page, from a small sample.
 *
 * Sampled rather than read from `crawl.stats.bytesTotal` deliberately: that
 * counter sums the crawler's fetched `sizeBytes`, which for a gzipped origin is
 * the TRANSFER size — the incident page was 105 KB on the wire and 1 MB of html
 * — so budgeting against it would pick a batch ten times too large on exactly
 * the sites that need it smallest. `html.length` is the quantity the batch
 * actually holds, so that is what gets measured.
 *
 * The sample is spread across the crawl (start, middle, end) instead of taken
 * from the front, because `getPages` orders by normalized_url and a site's URL
 * order correlates with page type — a front-only sample on a site whose `/a…`
 * paths are light index pages would size the batch for the wrong page.
 *
 * Costs `SIZE_SAMPLE_PAGES` page reads, dropped immediately. Returns 0 for an
 * empty crawl, which {@link resolveStreamBatchPages} turns into the floor.
 */
export function sampleAveragePageBytes(
  storage: SQLiteStorage,
  crawlId: string,
  totalPages: number,
): Effect.Effect<number, never, never> {
  return Effect.gen(function* () {
    if (!Number.isFinite(totalPages) || totalPages <= 0) return 0;
    const total = Math.floor(totalPages);
    if (total <= SIZE_SAMPLE_PAGES) {
      const batch = yield* storage
        .getPages(crawlId, { limit: total })
        .pipe(Effect.catchAll(() => Effect.succeed([])));
      return averageHtmlBytes(batch);
    }

    // Three DISJOINT windows: front, middle, back. Disjointness is enforced
    // rather than assumed — at 13 pages the naive offsets (0, 6, 9) with a
    // 4-page window overlap on page 9, which counts one page twice and silently
    // samples fewer distinct pages than intended.
    const perWindow = Math.max(1, Math.ceil(SIZE_SAMPLE_PAGES / 3));
    const starts: number[] = [];
    for (const candidate of [0, Math.floor((total - perWindow) / 2), total - perWindow]) {
      const start = Math.max(0, Math.min(total - perWindow, Math.floor(candidate)));
      const previous = starts[starts.length - 1];
      if (previous === undefined || start >= previous + perWindow) starts.push(start);
    }

    let bytes = 0;
    let counted = 0;
    for (const offset of starts) {
      const batch = yield* storage
        .getPages(crawlId, { limit: perWindow, offset })
        .pipe(Effect.catchAll(() => Effect.succeed([])));
      for (const page of batch) {
        // Pages with no html (redirects, non-HTML) are not what the batch holds,
        // so they must not drag the average down and inflate the batch.
        if (!page.html) continue;
        bytes += page.html.length;
        counted++;
      }
    }
    return counted > 0 ? Math.round(bytes / counted) : 0;
  });
}

/** Mean html length over the pages that have html; 0 when none do. */
function averageHtmlBytes(pages: ReadonlyArray<{ html: string | null }>): number {
  let bytes = 0;
  let counted = 0;
  for (const page of pages) {
    if (!page.html) continue;
    bytes += page.html.length;
    counted++;
  }
  return counted > 0 ? Math.round(bytes / counted) : 0;
}

/**
 * The batch size a streamed walk should use for this crawl, and the numbers that
 * produced it — the caller reports them so a batch can be explained after the
 * fact from the run's own events rather than guessed at.
 */
export interface ResolvedStreamBatch {
  pages: number;
  avgPageBytes: number;
  byteBudget: number;
  /** True when an explicit page count was supplied and the budget was ignored. */
  explicit: boolean;
}

/**
 * Resolve the batch for one crawl. An explicit `pages` override wins outright
 * (still clamped) — an operator pinning a page count is answering a question
 * this heuristic would otherwise re-answer every run.
 */
export function resolveStreamBatch(
  storage: SQLiteStorage,
  crawlId: string,
  totalPages: number,
  opts?: { pages?: number; byteBudget?: number; minPages?: number; maxPages?: number },
): Effect.Effect<ResolvedStreamBatch, never, never> {
  return Effect.gen(function* () {
    const byteBudget = toPositiveInt(opts?.byteBudget, STREAM_BATCH_BYTES);
    if (opts?.pages !== undefined) {
      const min = toPositiveInt(opts.minPages, STREAM_BATCH_MIN_PAGES);
      const max = Math.max(min, toPositiveInt(opts.maxPages, STREAM_BATCH_MAX_PAGES));
      // An unusable explicit count (NaN, 0, fractional) falls back to the floor
      // rather than propagating: a NaN batch is an infinite walk, not a slow one.
      return {
        pages: Math.min(max, Math.max(min, toPositiveInt(opts.pages, min))),
        avgPageBytes: 0,
        byteBudget,
        explicit: true,
      };
    }
    const avgPageBytes = yield* sampleAveragePageBytes(storage, crawlId, totalPages);
    return {
      pages: resolveStreamBatchPages({
        avgPageBytes,
        byteBudget,
        minPages: opts?.minPages,
        maxPages: opts?.maxPages,
      }),
      avgPageBytes,
      byteBudget,
      explicit: false,
    };
  });
}
