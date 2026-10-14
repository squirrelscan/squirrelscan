// The internal link probe (repo#2729): a status-only request for each internal
// link target the crawl did not fetch, so links/broken-links can find a linked
// 404 the crawl never reached.
//
// A GET to a link the crawl did not choose to follow can change state on the
// site (log out, unsubscribe, delete, confirm a token, add to a cart), so the
// probe is safe by construction:
//
// - It never requests a link that looks like an action (`looksLikeAnAction`,
//   `linkTextLooksLikeAnAction`): action words in a path segment, a query key
//   or value, token-like query values, and rel=nofollow or action-worded links.
// - It sends no credentials: no cookies, no Authorization, and none of the
//   audit's custom request headers, which can carry auth. Only a User-Agent
//   and Accept.
// - HEAD first. GET (a one-byte range, body discarded) only when the server
//   answers the HEAD with 405 or 501, which say HEAD is not supported.
// - Redirects are followed by hand, and every hop must pass the same checks
//   as the first request (scope, robots.txt, the action filter). A redirect
//   that leaves them is not followed: its 3xx is the target's status.
// - The caller holds it to the crawl's scope, robots.txt, per-host concurrency
//   and a per-audit limit (`[internal_links] max_targets`).

import { Effect } from "effect";

import { LINK_PROBE_HEAD_UNRELIABLE_ERROR } from "@squirrelscan/core-contracts";

import { isRateLimitedResponse } from "@squirrelscan/utils/rate-limit";
import { fetchUndecoded } from "@squirrelscan/utils/response-body";
import { isHttpOrHttpsUrl } from "@squirrelscan/utils/safe-fetch";

import type { FetchBudget } from "./fetch-budget";

// The action and token rules live in @squirrelscan/utils/link-actions, shared
// with the external link checker and usable from the cloud (repo#2759).
export { linkTextLooksLikeAnAction, looksLikeAnAction } from "@squirrelscan/utils/link-actions";

export interface LinkTargetProbeOptions {
  /** The crawl's user agent. */
  userAgent: string;
  timeoutMs: number;
  /** Requests in flight at once (the crawl's per-host concurrency). */
  concurrency: number;
  /**
   * May this URL be requested: in scope, allowed by robots.txt, not an action.
   * Applied to every redirect hop.
   */
  mayRequest: (url: string) => boolean;
  budget?: FetchBudget;
  /**
   * A page on the same site the crawl fetched with a 2xx, asked first. A
   * server that answers its HEAD with 4xx or 5xx (some frameworks route only
   * GET) cannot be trusted on the targets either: their 4xx and 5xx are
   * reported as unanswered, never as broken.
   */
  controlUrl?: string;
  /** Test seam. */
  send?: (url: string, init: RequestInit) => Promise<Response>;
}

export interface LinkTargetProbeResult {
  url: string;
  /** The final status; a 3xx when a redirect left what the probe may request. */
  status: number | null;
  error: string | null;
  rateLimited?: boolean;
}

const MAX_HOPS = 5;

async function requestStatus(
  url: string,
  method: "HEAD" | "GET",
  options: LinkTargetProbeOptions,
  signal: AbortSignal,
): Promise<Response> {
  const send = options.send ?? fetchUndecoded;
  let current = url;
  for (let hop = 0; ; hop++) {
    const response = await send(current, {
      method,
      // No cookies, no Authorization, no custom headers: see the top of this file.
      headers: {
        "User-Agent": options.userAgent,
        Accept: "*/*",
        ...(method === "GET" ? { Range: "bytes=0-0" } : {}),
      },
      credentials: "omit",
      redirect: "manual",
      signal,
    });
    response.body?.cancel().catch(() => {});
    const location =
      response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (!location || hop + 1 >= MAX_HOPS) return response;
    let next: string;
    try {
      next = new URL(location, current).href;
    } catch {
      return response;
    }
    if (!isHttpOrHttpsUrl(next) || !options.mayRequest(next)) return response;
    current = next;
  }
}

async function probeOne(url: string, options: LinkTargetProbeOptions): Promise<LinkTargetProbeResult> {
  if (!options.mayRequest(url)) return { url, status: null, error: "not requested" };
  if (options.budget?.shouldSkip(url)) return { url, status: null, error: "skipped" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const started = Date.now();
  try {
    let response = await requestStatus(url, "HEAD", options, controller.signal);
    // 405 Method Not Allowed and 501 Not Implemented say the server does not
    // do HEAD; only then is the GET sent.
    if (response.status === 405 || response.status === 501) {
      response = await requestStatus(url, "GET", options, controller.signal);
    }
    // A 5xx strikes like an error, so an erroring host trips the budget too.
    options.budget?.record(url, Date.now() - started, response.status >= 500 ? "error" : "ok");
    const rateLimited = isRateLimitedResponse(response.status, response.headers.get("retry-after"));
    return { url, status: response.status, error: null, ...(rateLimited ? { rateLimited } : {}) };
  } catch (error) {
    const timedOut = controller.signal.aborted;
    options.budget?.record(url, Date.now() - started, timedOut ? "timeout" : "error");
    return {
      url,
      status: null,
      error: timedOut ? "timeout" : error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface LinkTargetProbe {
  results: LinkTargetProbeResult[];
  /** The control page's HEAD failed, so no target's 4xx or 5xx was trusted. */
  headUnreliable: boolean;
}

/** Status-check each URL as described at the top of this file, in input order. */
export function probeLinkTargets(
  urls: string[],
  options: LinkTargetProbeOptions,
): Effect.Effect<LinkTargetProbe, never, never> {
  const unique = [...new Set(urls)];
  return Effect.gen(function* () {
    if (unique.length === 0) return { results: [], headUnreliable: false };
    // The control is a page the crawl already fetched, so it is asked
    // whatever the filters say (they are for links the crawl did not follow;
    // its redirect hops still pass them), and outside the budget. No answer
    // says nothing either way.
    const controlUrl = options.controlUrl;
    const control = controlUrl
      ? yield* Effect.promise(() =>
          probeOne(controlUrl, {
            ...options,
            mayRequest: (url) => url === controlUrl || options.mayRequest(url),
            budget: undefined,
          }),
        )
      : null;
    const headUnreliable = control?.status != null && control.status >= 400;
    const results = yield* Effect.all(
      unique.map((url) => Effect.promise(() => probeOne(url, options))),
      { concurrency: Math.max(1, options.concurrency) },
    );
    if (!headUnreliable) return { results, headUnreliable };
    return {
      headUnreliable,
      results: results.map((r) =>
        r.status !== null && r.status >= 400
          ? { url: r.url, status: null, error: LINK_PROBE_HEAD_UNRELIABLE_ERROR }
          : r,
      ),
    };
  });
}
