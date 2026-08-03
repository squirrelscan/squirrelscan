import { getDomain } from "tldts";

import type { CrawlDecision, ScopeOptions, UrlNormalizationOptions } from "./types";

const DEFAULT_SCHEME = "https:";

const TRACKING_PARAM_PREFIXES = new Set([
  "utm_",
  "gclid",
  "gclsrc",
  "dclid",
  "gbraid",
  "wbraid",
  "_ga",
  "_gid",
  "_gat",
  "fbclid",
  "msclkid",
  "cvid",
  "oicd",
  "twclid",
  "li_fat_id",
  "igshid",
  "yclid",
  "_openstat",
  "mc_cid",
  "mc_eid",
  "mkt_tok",
  "vgo_ee",
  "_hsenc",
  "_hsmi",
  "__hssc",
  "__hstc",
  "hsctaTracking",
  "oly_anon_id",
  "oly_enc_id",
  "otc",
  "wickedid",
  "soc_src",
  "soc_trk",
  "rb_clickid",
  "icid",
  "__s",
  "_kx",
  "s_kwcid",
  "sfmc_id",
]);

/**
 * The same path with its trailing slash toggled, or null when there is no
 * meaningful variant (the root path, whose slash is not optional).
 *
 * Used purely for DEDUPE: `/about` and `/about/` are different resources on the
 * wire, so the frontier keeps whichever form the site actually linked, but it
 * refuses to enqueue the other form once one of them is already queued. Fetching
 * a form nobody linked invents a redirect that only exists because we asked for
 * it (#1510) — trailing-slash canonicalization is the default on WordPress,
 * Hugo and most static hosts, so that mistake fires site-wide.
 */
export function trailingSlashVariant(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.pathname === "/") return null;
    parsed.pathname = parsed.pathname.endsWith("/")
      ? parsed.pathname.slice(0, -1)
      : `${parsed.pathname}/`;
    return parsed.toString();
  } catch {
    return null;
  }
}

function shouldDropQueryParam(key: string, allowQueryParams: string[]): boolean {
  const lowerKey = key.toLowerCase();

  for (const prefix of TRACKING_PARAM_PREFIXES) {
    if (lowerKey === prefix || lowerKey.startsWith(prefix)) {
      return true;
    }
  }

  if (allowQueryParams.length > 0) {
    const allowList = allowQueryParams.map((value) => value.toLowerCase());
    return !allowList.includes(lowerKey);
  }

  return false;
}

export function normalizeUrl(rawUrl: string, options: UrlNormalizationOptions): string | null {
  try {
    const resolved = new URL(rawUrl, options.baseUrl);

    resolved.hash = "";
    resolved.protocol = resolved.protocol.toLowerCase() || DEFAULT_SCHEME;
    resolved.hostname = resolved.hostname.toLowerCase();

    if (
      (resolved.protocol === "http:" && resolved.port === "80") ||
      (resolved.protocol === "https:" && resolved.port === "443")
    ) {
      resolved.port = "";
    }

    // The trailing slash is NOT noise: `/about` and `/about/` are distinct
    // request targets, and the normalized URL is the URL we actually fetch.
    // Stripping it made every slash-canonical site look like it redirected
    // (#1510). Dedupe across the two forms happens at enqueue time instead.

    if (resolved.search) {
      const params = new URLSearchParams(resolved.search);
      const filtered = new URLSearchParams();

      for (const [key, value] of params.entries()) {
        if (shouldDropQueryParam(key, options.allowQueryParams)) {
          continue;
        }
        filtered.append(key, value);
      }

      resolved.search = filtered.toString() ? `?${filtered.toString()}` : "";
    }

    return resolved.toString();
  } catch {
    return null;
  }
}

function matchesPattern(input: string, pattern: string): boolean {
  if (pattern === "*") return true;

  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -1);
    return input.startsWith(prefix);
  }

  if (pattern.includes("*")) {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`^${escaped.replace(/\\\*/g, ".*")}$`, "i");
    return regex.test(input);
  }

  return input.startsWith(pattern);
}

function isAllowedDomain(hostname: string, allowedDomains: string[]): boolean {
  const lowerHost = hostname.toLowerCase();
  return allowedDomains.some((domain) => {
    const lowerDomain = domain.toLowerCase();
    return lowerHost === lowerDomain || lowerHost.endsWith(`.${lowerDomain}`);
  });
}

export function isInScope(url: string, options: ScopeOptions): CrawlDecision {
  const { baseUrl, include, exclude, allowedDomains } = options;
  const baseUrlObj = new URL(baseUrl);
  const candidateUrlObj = new URL(url);
  const baseHost = baseUrlObj.host.toLowerCase();
  const candidateHost = candidateUrlObj.host.toLowerCase();
  const candidateHostname = candidateUrlObj.hostname.toLowerCase();
  const candidatePath = candidateUrlObj.pathname;

  const matchTarget = (pattern: string) =>
    pattern.startsWith("http://") || pattern.startsWith("https://") ? url : candidatePath;

  if (exclude.some((pattern) => matchesPattern(matchTarget(pattern), pattern))) {
    return { allowed: false, reason: "excluded" };
  }

  if (include.length > 0) {
    const allowed = include.some((pattern) => matchesPattern(matchTarget(pattern), pattern));
    return allowed ? { allowed: true } : { allowed: false, reason: "not_included" };
  }

  if (allowedDomains && allowedDomains.length > 0) {
    if (!isAllowedDomain(candidateHostname, allowedDomains)) {
      return { allowed: false, reason: "cross_domain" };
    }
    return { allowed: true };
  }

  if (candidateHost !== baseHost) {
    return { allowed: false, reason: "cross_domain" };
  }

  return { allowed: true };
}

/**
 * Registrable domain (eTLD+1) of a hostname, resolved against the real Public
 * Suffix List. `allowPrivateDomains` keeps free-hosting platforms per-tenant
 * (`a.pages.dev` and `b.pages.dev` are DIFFERENT sites, not one `pages.dev`) —
 * two tenants of the same host are not the same site.
 *
 * Falls back to the trailing-dot-stripped, lowercased host whenever tldts cannot
 * derive one (IP literal, `localhost`, single-label or bare-suffix host) so both
 * sides of a comparison still normalize identically — for those, equality means
 * "identical host", which is the conservative answer.
 */
function registrableDomain(host: string): string {
  const normalized = host.replace(/\.$/, "").toLowerCase();
  return getDomain(normalized, { allowPrivateDomains: true }) ?? normalized;
}

/**
 * True when `final` belongs to the same SITE as `seed` — same registrable
 * domain on the same port. Scheme may differ (an http→https upgrade is the
 * single most common seed redirect there is).
 *
 * The port must match because a port change is a different service, not a
 * different hostname of the same site: `http://localhost:8750` →
 * `http://localhost:8751` collapses to the same (fallback) registrable domain
 * yet is exactly the loopback pivot this guard exists to stop.
 */
function isSameSite(seed: URL, final: URL): boolean {
  if (seed.port !== final.port) return false;
  return registrableDomain(seed.hostname) === registrableDomain(final.hostname);
}

export interface SeedRedirectResolution {
  /** Origin the crawl is keyed on: probes, scope checks and the report's baseUrl. */
  baseUrl: string;
  /** URL enqueued as the crawl seed. */
  seedUrl: string;
  /** True when the seed's redirect target was refused instead of adopted. */
  offSite: boolean;
}

/**
 * Decide which origin a crawl is *about*, given the URL the user asked for and
 * the URL its redirects actually landed on.
 *
 * A seed redirect is adopted only when it stays on the seed's own site. A
 * redirect that leaves it (a parked domain, a CDN, another service on another
 * port) is REFUSED: the base stays pinned to the seed, and the seed URL itself
 * is what gets crawled.
 *
 * Adopting the target instead re-points the whole audit at a site the user
 * never asked about: every root probe (robots.txt, llms.txt, sitemaps, the
 * `.well-known/*` and agent-manifest sweep) is built from `baseUrl`, so one
 * followed redirect turns into a full discovery sweep of the target, and the
 * target's content is what ends up in the report while the report still claims
 * to describe the seed.
 */
export function resolveSeedRedirect(seedUrl: string, finalUrl: string): SeedRedirectResolution {
  const seed = parseHttpUrl(seedUrl);
  const final = parseHttpUrl(finalUrl);

  if (!seed) {
    // No usable seed to pin to. Fall back to the URL that was actually fetched
    // rather than to `seedUrl`'s own origin: for a nested scheme like
    // `blob:https://host/…`, `URL.origin` reports the EMBEDDED origin, so
    // pinning to it would base the whole crawl — every root probe included — on
    // a host that was never fetched and never named as a site.
    return { baseUrl: final?.origin ?? finalUrl, seedUrl: finalUrl, offSite: false };
  }

  if (!final) {
    return { baseUrl: seed.origin, seedUrl, offSite: false };
  }

  if (seed.origin === final.origin) {
    return { baseUrl: seed.origin, seedUrl: finalUrl, offSite: false };
  }

  if (isSameSite(seed, final)) {
    return { baseUrl: final.origin, seedUrl: finalUrl, offSite: false };
  }

  return { baseUrl: seed.origin, seedUrl, offSite: true };
}

/**
 * True when following a fetch's redirects landed outside the crawl's own site.
 *
 * The frontier only ever holds in-scope URLs, so a document that comes back
 * from another site is by definition not part of what is being audited — the
 * crawler stores response bodies unconditionally, and a per-page `Location:` is
 * exactly as page-controlled as the seed's. Same-site hops (an http→https
 * upgrade, an apex→www bounce) are NOT off-site and stay storable.
 *
 * An empty `finalUrl` is no evidence of a redirect, so it stays storable. A
 * NON-empty one we cannot compare (unparseable, or a nested scheme whose
 * `origin` is not the host that served it) fails CLOSED: the whole point is that
 * a landing we cannot attribute to the audited site must not be stored under it.
 */
export function isOffSiteFinalUrl(baseUrl: string, finalUrl: string): boolean {
  if (!finalUrl) return false;
  const base = parseHttpUrl(baseUrl);
  const final = parseHttpUrl(finalUrl);
  if (!base) return false;
  if (!final) return true;
  if (base.origin === final.origin) return false;
  return !isSameSite(base, final);
}

/** Parsed URL, but only for the schemes a crawl can actually be about. */
function parseHttpUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}
