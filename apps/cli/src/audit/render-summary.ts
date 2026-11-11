// What cloud rendering did on one audit (#1664): the `render` block of the report.
//
// Pure, so what the report says about rendering is a tested fact: the mode comes from the fetcher
// the controller resolved, the counts from the `fetcherId` each fetched page reported, and the
// fallback reason from the render fetcher's own `onFallback`, which used to be a `logger.warn` only.

import type {
  ReportRender,
  ReportRenderMode,
} from "@squirrelscan/core-contracts";

/** The fetcher ids a browser render reports: the cloud render, and the container's browser queue. */
const RENDERED_FETCHER_IDS: ReadonlySet<string> = new Set([
  "cloud-render",
  "browser",
]);

/** Whether a page's `fetcherId` says a browser rendered it. */
export function isRenderedFetcher(fetcherId: string | undefined): boolean {
  return fetcherId !== undefined && RENDERED_FETCHER_IDS.has(fetcherId);
}

/**
 * The crawl's render mode from the resolved fetcher's id: no render fetcher is plain HTTP,
 * `hybrid-http-first` is HTTP first with a render for client-rendered shells (`auto`), and the
 * cloud render fetcher (also wrapped by the conditional-render gate) renders every page.
 */
export function renderModeOf(fetcherId: string | undefined): ReportRenderMode {
  if (fetcherId === "hybrid-http-first") return "auto";
  if (fetcherId !== undefined && RENDERED_FETCHER_IDS.has(fetcherId))
    return "all";
  return "http";
}

/** Counts the pages an audit fetched, by whether a browser rendered them. */
export interface RenderTally {
  /** Note one fetched page by the `fetcherId` it reported. */
  note: (fetcherId: string | undefined) => void;
  counts: () => { rendered: number; plain: number };
}

export function createRenderTally(): RenderTally {
  let rendered = 0;
  let plain = 0;
  return {
    note: (fetcherId) => {
      if (isRenderedFetcher(fetcherId)) rendered++;
      else plain++;
    },
    counts: () => ({ rendered, plain }),
  };
}

export interface RenderSummaryInput {
  /** Cloud rendering was asked for. */
  requested: boolean;
  /** The id of the fetcher the crawl used; undefined for the crawler's default plain fetch. */
  fetcherId: string | undefined;
  /**
   * Why rendering did not carry the crawl, as the fetcher or the controller said it, or undefined.
   * Ignored when rendering was not asked for.
   */
  fallbackReason?: string;
  rendered: number;
  plain: number;
}

/** Longest fallback reason the report carries (the fetcher's own are short; a runaway one is cut). */
const MAX_REASON_CHARS = 200;

/** The report's `render` block. Whole non-negative counts; a reason only when rendering was asked for. */
export function buildReportRender(input: RenderSummaryInput): ReportRender {
  const count = (n: number) =>
    Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  const reason = input.fallbackReason?.trim();
  return {
    requested: input.requested,
    mode: renderModeOf(input.fetcherId),
    ...(input.requested && reason
      ? { fallbackReason: reason.slice(0, MAX_REASON_CHARS) }
      : {}),
    pagesRendered: count(input.rendered),
    pagesFetchedPlain: count(input.plain),
  };
}

/**
 * The one console line for a render that fell back, or null when it did not. Says the reason and how
 * the pages split, so a user paying for render sees that some or all pages are plain HTTP.
 */
export function renderFallbackLine(
  render: ReportRender | undefined
): string | null {
  if (!render?.fallbackReason) return null;
  const total = render.pagesRendered + render.pagesFetchedPlain;
  const split =
    total === 0
      ? "no pages were fetched"
      : `${render.pagesRendered.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} pages were rendered, the rest fetched as plain HTML`;
  return `Cloud rendering fell back to plain HTTP (${render.fallbackReason}): ${split}.`;
}
