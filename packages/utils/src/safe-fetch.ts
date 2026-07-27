// Redirect-safe outbound fetch for server-initiated requests of URLs derived
// from untrusted page content (redirect Location headers, robots.txt
// directives, meta refresh, Link headers). See #1392-#1396.

import { headersForRedirect } from "./headers";

const MAX_REDIRECTS = 10;

/**
 * Only `http:`/`https:` are permitted for a server-initiated fetch of a
 * page-content-derived URL (a redirect Location, a robots.txt directive, a Link
 * header, a meta refresh). Blocks `file:`, `data:`, `blob:`, `ftp:`, `gopher:`,
 * `javascript:`, etc. — the local-file-read and scheme-SSRF vectors.
 *
 * SCHEME-ONLY: this deliberately does NOT restrict the HOST. Private, loopback
 * and internal hosts stay fetchable because squirrelscan legitimately audits
 * localhost / staging / internal / private-IP sites — blocking those here would
 * be a functional regression. (`isPublicHttpUrl` in ./url does block private
 * hosts; do NOT use it on shared crawler fetch paths.) Returns false for
 * unparseable input.
 */
export function isHttpOrHttpsUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

export interface SafeRedirectResult {
  /** Final response after manually following redirects; its body is unread. */
  response: Response;
  /** URL of the final hop actually fetched. */
  finalUrl: string;
  /** True when at least one redirect was followed. */
  redirected: boolean;
}

/**
 * A `fetch()` that follows redirects MANUALLY so that, per hop, it can:
 *  (a) enforce the http/https scheme allowlist above — a `Location:` pointing at
 *      `file:`/`data:`/`blob:`/`ftp:`/… is refused, never fetched (throws a
 *      `TypeError`, matching native fetch on an unsupported scheme). A
 *      hand-rolled `new URL(location, base)` + re-fetch loop otherwise blindly
 *      follows it, enabling a local-file read / scheme-SSRF whose body the
 *      crawler would then store; and
 *  (b) drop non-allowlisted (secret) request headers when the origin changes,
 *      via `headersForRedirect` — so the caller's `X-Api-Key` / Web-Bot-Auth /
 *      `CF-Access-Client-Secret` headers don't leak to a redirect target on
 *      another origin. (undici/Bun natively strip only authorization / cookie /
 *      proxy-authorization / host.)
 *
 * SECURITY SCOPE: restricts the SCHEME only, never the HOST (see
 * `isHttpOrHttpsUrl`). Per-request private-IP / cloud-metadata blocking is a
 * hosted-egress concern and is deliberately NOT done here; gate that at the
 * egress boundary if a cloud deployment needs it, not in this shared helper.
 *
 * The returned response's body is unread — the caller reads it. A non-3xx
 * response (or a 3xx without a `Location`, e.g. 304 Not Modified) is returned as
 * the final response. Exceeding the redirect cap throws, like native fetch.
 */
export async function safeRedirectFetch(
  url: string,
  init: RequestInit = {},
): Promise<SafeRedirectResult> {
  if (!isHttpOrHttpsUrl(url)) {
    throw new TypeError(`Refusing to fetch non-http(s) URL: ${url}`);
  }

  let currentUrl = url;
  let headers = new Headers(init.headers);

  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    const response = await fetch(currentUrl, { ...init, headers, redirect: "manual" });

    const location =
      response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (!location) {
      return { response, finalUrl: currentUrl, redirected: currentUrl !== url };
    }

    let nextUrl: string;
    try {
      nextUrl = new URL(location, currentUrl).toString();
    } catch {
      // Unparseable Location — stop and hand back this 3xx as the final response.
      return { response, finalUrl: currentUrl, redirected: currentUrl !== url };
    }

    if (!isHttpOrHttpsUrl(nextUrl)) {
      // Cross-protocol redirect (e.g. Location: file:///etc/passwd) — refuse it.
      response.body?.cancel().catch(() => {});
      throw new TypeError(`Refusing redirect to non-http(s) URL: ${nextUrl}`);
    }

    // Discard the 3xx body before the next hop so the socket can be reused.
    response.body?.cancel().catch(() => {});
    headers = headersForRedirect(headers, currentUrl, nextUrl);
    currentUrl = nextUrl;
  }

  throw new TypeError(`Too many redirects while fetching ${url}`);
}
