// URL normalization shared by the feed index and lookup memo, so a feed entry
// and a crawled URL that denote the same resource collide on the same key.

import { getDomain } from "tldts";

/**
 * Canonical key for a URL: lower-cased host + path, query/fragment dropped,
 * scheme dropped, trailing slash trimmed, leading `www.` removed. Feeds list
 * URLs in many shapes; this collapses the common ones so membership is stable.
 * Falls back to the trimmed lower-cased input when the URL can't be parsed.
 */
export function normalizeUrl(raw: string): string {
  const input = raw.trim();
  let u: URL;
  try {
    u = new URL(input.includes("://") ? input : `http://${input}`);
  } catch {
    return input.toLowerCase();
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = u.pathname.replace(/\/+$/, "");
  return path ? `${host}${path}` : host;
}

/** Lower-cased host of a URL (no `www.` stripping — feeds may pin a subdomain). */
export function hostOf(raw: string): string | null {
  try {
    const u = new URL(raw.includes("://") ? raw : `http://${raw}`);
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Registrable domain (eTLD+1) via the Public Suffix List, or null. */
export function registrableDomain(raw: string): string | null {
  const host = hostOf(raw) ?? raw.trim().toLowerCase();
  return getDomain(host, { allowPrivateDomains: true });
}
