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

/** A script element as {@link hasJavaScriptDetections} reads it (a DOM element satisfies it). */
interface ScriptLike {
  textContent: string | null;
  getAttribute(name: string): string | null;
}

/** The inline snippet sets `window.__CF$cv$params`; inline and external forms reference the challenge platform path. */
const JSD_MARKER = /__CF\$cv\$params|\/cdn-cgi\/challenge-platform\//i;
/** Characters of one inline script read, and scripts looked at: the snippet is a few hundred bytes. */
const JSD_SCRIPT_CHARS = 2048;
const JSD_MAX_SCRIPTS = 60;

/**
 * Whether a page carries Cloudflare JavaScript Detections (Bot Fight Mode turns it on), the one
 * ETag-removing Cloudflare feature that leaves a marker in the page (#605). The marker is in a
 * `<script>`: an inline one that sets `__CF$cv$params` or references `/cdn-cgi/challenge-platform/`,
 * or an external one whose `src` is that path. Text that merely mentions the path is not a script and
 * never counts. Bounded and linear: at most {@link JSD_MAX_SCRIPTS} scripts and
 * {@link JSD_SCRIPT_CHARS} characters of each are read, so a megabyte of script costs no more than a kilobyte.
 */
export function hasJavaScriptDetections(doc: { querySelectorAll(selector: string): Iterable<ScriptLike> }): boolean {
  let seen = 0;
  for (const script of doc.querySelectorAll("script")) {
    if (++seen > JSD_MAX_SCRIPTS) return false;
    const src = script.getAttribute("src");
    if (src && JSD_MARKER.test(src.slice(0, JSD_SCRIPT_CHARS))) return true;
    const text = script.textContent;
    if (text && JSD_MARKER.test(text.length > JSD_SCRIPT_CHARS ? text.slice(0, JSD_SCRIPT_CHARS) : text)) return true;
  }
  return false;
}

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
  // `providers`, not `provider`: a DataDome block served by Cloudflare is
  // attributed to DataDome, and it still came through Cloudflare.
  return detectWafFromHeaders(h).providers.includes("cloudflare") ? "cloudflare" : null;
}
