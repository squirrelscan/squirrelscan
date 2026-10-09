// Which CDN served a response, read from its headers (pub#600).
//
// A rule sometimes has to say that a header was changed at the edge rather
// than at the origin: Cloudflare drops the ETag from HTML it rewrites, so a
// missing validator behind Cloudflare may not be the site's doing. "Came
// through Cloudflare" already has one definition, the waf-detect header table
// (`cf-ray`, `server: cloudflare`, `cf-cache-status`), so this asks it rather
// than keeping a second list that could drift.

import { detectWafFromHeaders } from "@squirrelscan/waf-detect";

import { recordToHeaders } from "./headers";

/** Edge networks a rule can attribute a header change to. */
export type CdnProvider = "cloudflare";

/**
 * The CDN that served a response, from its headers; `null` when none is
 * recognised. Takes either a `Headers` or the lower-cased header map rules see
 * (`buildHeadersMap`), which stores `server` and `cf-cache-status` but not
 * `cf-ray`.
 */
export function detectCdnFromHeaders(
  headers: Headers | Readonly<Record<string, string>>,
): CdnProvider | null {
  const h = headers instanceof Headers ? headers : recordToHeaders(headers);
  return detectWafFromHeaders(h).provider === "cloudflare" ? "cloudflare" : null;
}
