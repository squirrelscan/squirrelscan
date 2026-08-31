// shared/redirect-evidence - what counts as proof that a request redirected
//
// A `RedirectChain` is a record of hops, not a promise that any of them
// redirected. Producers that only ever saw the landing response still emit a
// chain, and a rule that reads `chainLength > 0` or `url !== finalUrl` as proof
// accuses sites of redirects they never performed: every trailing-slash-
// canonical site reported its own pages as `(200) → (200)` moves (#1510).
//
// These predicates are the shared answer to "did we actually watch this
// redirect happen", so every rule that reports a chain asks the same question.

import type { RedirectChain } from "@squirrelscan/core-contracts";

/**
 * Identity of the resource a URL names, for deciding whether a request LANDED
 * somewhere else and for joining links to redirect targets.
 *
 * This is `@squirrelscan/utils`' `normalizeUrl` with the trailing slash KEPT.
 * `/about` and `/about/` are different request targets, and telling them apart
 * is the entire point: folding them together both hides a genuine
 * `/about → /about/` move and lets a page that links the canonical form get
 * blamed for the other form's redirect (#1510).
 */
export function targetKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${parsed.pathname}`;
  } catch {
    return url;
  }
}

/**
 * A NON-final hop we watched actually redirect: an HTTP hop carrying a 3xx, or
 * any client-side hop at all — a `javascript` / `meta-refresh` hop IS the
 * redirect, whatever status the document that performed it returned.
 */
export function hasObservedRedirect(chain: RedirectChain | undefined): boolean {
  if (!chain || chain.hops.length < 2) return false;
  return chain.hops
    .slice(0, -1)
    .some((hop) => hop.type !== "http" || (hop.statusCode >= 300 && hop.statusCode < 400));
}

/**
 * True when the chain contradicts itself: an HTTP hop it says was followed by
 * another hop reports a 2xx, and an HTTP response that returned 200 did not
 * redirect.
 *
 * Such a chain was assembled from a source URL and a landing URL by something
 * that never watched the responses in between, and it is what made every
 * trailing-slash-canonical site report its own pages as redirecting,
 * `(200) → (200)`, blaming every page that linked them (#1510). The producers
 * are fixed to record an unobserved hop as `0` rather than borrowing the landing
 * status; this is the rules refusing to accuse on that shape even if one regresses.
 *
 * Client-side hops are exempt: a `javascript` / `meta-refresh` redirect is by
 * definition a document that returned 200 and then sent the visitor elsewhere,
 * so a 2xx there is the truth, not a borrowed status.
 */
export function contradictsItself(chain: RedirectChain | undefined): boolean {
  if (!chain || chain.hops.length < 2) return false;
  return chain.hops
    .slice(0, -1)
    .some((hop) => hop.type === "http" && hop.statusCode >= 200 && hop.statusCode < 300);
}

/**
 * The request target a URL names: everything the server is asked for, query
 * INCLUDED, fragment excluded because it never leaves the browser.
 *
 * Deliberately not `targetKey`. This one answers "did the request land
 * somewhere else", and a redirect that only rewrites the query string still
 * redirected. `targetKey` is a join key for matching links to the redirect they
 * hit, where folding the query in would stop a link carrying a tracking
 * parameter from matching the path-level redirect it lands on.
 */
function requestTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

/**
 * Did this request redirect? Two independent kinds of evidence: it landed on a
 * different request target, or we watched a hop return a 3xx. The first covers
 * the render path, which reports the landing page but never the statuses that
 * led to it. A self-contradicting chain is neither, whatever the URLs say.
 */
export function didRedirect(
  url: string,
  finalUrl: string | undefined,
  chain: RedirectChain | undefined
): boolean {
  if (contradictsItself(chain)) return false;
  const landedElsewhere =
    finalUrl !== undefined && requestTarget(url) !== requestTarget(finalUrl);
  return landedElsewhere || hasObservedRedirect(chain);
}
