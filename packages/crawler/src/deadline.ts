// Request deadlines that survive into the body read (#1699).

import { safeRedirectFetch } from "@squirrelscan/utils/safe-fetch";

/**
 * Run a request under a deadline that stays armed until its body has been read.
 *
 * The tempting shape — `fetch(...).finally(() => clearTimeout(timer))` — disarms
 * the abort the moment the response HEADERS land, which leaves the body read
 * with no time bound at all: an origin that answers 200 promptly and then
 * trickles or stalls the body parks the caller forever. `readBodyCapped` caps
 * BYTES, not seconds, so it cannot save you either. Holding the timer across
 * `use` means such a stall aborts the body stream instead of hanging.
 *
 * `use` must finish with the response (read or cancel its body) before it
 * returns — the deadline is disarmed as soon as it does.
 */
export async function withRequestDeadline<T>(
  timeoutMs: number,
  perform: (signal: AbortSignal) => Promise<Response>,
  use: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await use(await perform(controller.signal));
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * `withRequestDeadline` over `safeRedirectFetch` — the shape every root probe in
 * the crawl preamble (robots, llms, markdown, well-known, agent-access, rsl,
 * sitemaps) uses. Manual redirects apply the per-hop scheme allowlist and strip
 * secret customHeaders when the origin changes (#1395).
 */
export function safeFetchWithDeadline<T>(
  url: string,
  options: RequestInit,
  timeoutMs: number,
  use: (response: Response) => Promise<T>,
): Promise<T> {
  return withRequestDeadline(
    timeoutMs,
    (signal) => safeRedirectFetch(url, { ...options, signal }).then((result) => result.response),
    use,
  );
}
