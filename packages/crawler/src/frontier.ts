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

function normalizeTrailingSlash(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
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

    resolved.pathname = normalizeTrailingSlash(resolved.pathname);

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
