/**
 * Fetches a site refused, as opposed to answered.
 *
 * A bot wall that returns 403 for `/robots.txt` has told us nothing about
 * whether the file exists. Reporting it as "No robots.txt found" turns a
 * coverage failure into a false statement about the site, so the crawler
 * records each refusal here and the rules and renderers say "refused".
 *
 * Leaf module by design: the crawler, the rules and the report all read it.
 */

/** Which root resource the refused request was for. */
export const REFUSED_RESOURCES = ["robots.txt", "sitemap", "llms.txt", "markdown"] as const;

export type RefusedResource = (typeof REFUSED_RESOURCES)[number];

export interface RefusedFetch {
  url: string;
  resource: RefusedResource;
  /** HTTP status the site answered with (401, 403, 429, 430, or a 503 challenge). */
  status: number;
  /** Bot-protection vendor named by the response headers, when one was recognised. */
  provider?: string;
}

/** Bounds the persisted list: a sitemap index can fan out to thousands of refused children. */
export const MAX_REFUSED_FETCHES = 20;

/** One short sentence per refusal, shared by every renderer: `/robots.txt: HTTP 403 (Cloudflare)`. */
export function describeRefusedFetch(refusal: RefusedFetch): string {
  let path = refusal.url;
  try {
    const parsed = new URL(refusal.url);
    path = `${parsed.pathname}${parsed.search}`;
  } catch {
    // Keep the raw string: a stored value that no longer parses is still evidence.
  }
  const by = refusal.provider ? ` (${refusal.provider})` : "";
  return `${path}: HTTP ${refusal.status}${by}`;
}

/**
 * One line per resource, status and vendor instead of one per request: a site
 * that walls every sitemap candidate refuses nine URLs, and nine lines saying
 * the same thing bury the one fact. A group of one reads as
 * {@link describeRefusedFetch}; a larger group names its count and first URL.
 */
export function summarizeRefusedFetches(refusals: readonly RefusedFetch[]): string[] {
  const groups = new Map<string, RefusedFetch[]>();
  for (const refusal of refusals) {
    const key = `${refusal.resource}|${refusal.status}|${refusal.provider ?? ""}`;
    const group = groups.get(key);
    if (group) group.push(refusal);
    else groups.set(key, [refusal]);
  }
  return [...groups.values()].map((group) => {
    const first = group[0]!;
    if (group.length === 1) return describeRefusedFetch(first);
    const by = first.provider ? ` (${first.provider})` : "";
    return `${first.resource}, ${group.length} requests (first ${describeRefusedFetch(first).split(": ")[0]}): HTTP ${first.status}${by}`;
  });
}
