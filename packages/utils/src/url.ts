/// <reference path="./external.d.ts" />
/// <reference types="node" />

// URL utilities for SquirrelScan

import { isIP } from "node:net";

// ============================================
// URL Parsing (user input normalization)
// ============================================

export type UrlParseResult =
  | {
      ok: true;
      url: string;
    }
  | {
      ok: false;
      error: string;
    };

/**
 * True when `input` carries an explicit non-http(s) "://" scheme (e.g.
 * "ftp://example.com"). Callers that default schemeless input to https://
 * must check this first — otherwise prefixing "https://" onto "ftp://example.com"
 * mangles it into hostname "ftp". Slashless schemes like "javascript:x" miss
 * this guard but are rejected downstream by `new URL()`. Shared by
 * parseUserUrl (CLI) and normalizeWebsiteInput (api) — see #892.
 */
export function hasNonHttpScheme(input: string): boolean {
  return input.includes("://") && !/^https?:\/\//i.test(input);
}

function isPrivateIPv4(hostname: string): boolean {
  const octets = hostname.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((octet) => Number.isNaN(octet))) {
    return false;
  }

  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 192 && b === 168) return true;
  return a === 172 && b >= 16 && b <= 31;
}

function isPrivateIPv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:")
  );
}

function normalizeIpHostname(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

/**
 * Check if hostname is localhost or localhost-like
 */
export function isLocalhost(hostname: string): boolean {
  const normalized = normalizeIpHostname(hostname);
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    return isPrivateIPv4(normalized);
  }
  if (ipVersion === 6) {
    return normalized === "::1" || isPrivateIPv6(normalized);
  }

  return normalized === "localhost" || normalized.endsWith(".localhost");
}

/**
 * True only for loopback hosts — the machine running the audit itself: localhost,
 * *.localhost, the 127.0.0.0/8 range, and IPv6 ::1. Narrower than `isLocalhost`
 * (which also matches private LAN ranges like 192.168/16); a loopback target is
 * unambiguously the user's own dev server, so politeness throttling is pointless
 * there. Used to gate the crawl fast path (#1068).
 */
export function isLoopbackHost(hostname: string): boolean {
  const normalized = normalizeIpHostname(hostname).toLowerCase();
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    return normalized.split(".")[0] === "127";
  }
  if (ipVersion === 6) {
    return normalized === "::1";
  }
  return normalized === "localhost" || normalized.endsWith(".localhost");
}

/**
 * Reject IPv4 ranges that `isLocalhost` (private/loopback only) misses but that
 * are still dangerous SSRF targets: link-local incl. the cloud metadata
 * endpoint (169.254.169.254), 0.0.0.0/8, and 100.64/10 (carrier-grade NAT).
 */
export function isReservedIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) {
    return false;
  }
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8 (incl. "this host")
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  return false;
}

/**
 * Reject dangerous IPv6 targets that `isLocalhost`'s IPv6 check (loopback +
 * fc/fd/fe80 prefixes only) misses or only partially covers: the unspecified
 * address `::`, loopback `::1`, link-local `fe80::/10`, ULA `fc00::/7`, and the
 * IPv4-embedding forms — IPv4-mapped `::ffff:a.b.c.d` AND IPv4-translated
 * `::ffff:0:a.b.c.d` (`::ffff:0:0/96`) — whose embedded v4 is re-checked against
 * the v4 guards (blocks e.g. `::ffff:169.254.169.254`, `::ffff:0:10.0.0.1`).
 */
export function isReservedIpv6(hostname: string): boolean {
  if (isIP(hostname) !== 6) return false;
  const lower = hostname.toLowerCase();
  if (lower === "::" || lower === "::1") return true; // unspecified + loopback
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // link-local fe80::/10
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
  // IPv4-mapped/-translated ::ffff:[0:]a.b.c.d — the WHATWG URL parser
  // canonicalizes the dotted tail into two hex hextets, so match both forms (with
  // the optional `0:` translated prefix) and re-check the embedded v4.
  const mappedDotted = lower.match(/^::ffff:(?:0:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mappedDotted) {
    const v4 = mappedDotted[1];
    return isLocalhost(v4) || isReservedIpv4(v4);
  }
  const mappedHex = lower.match(/^::ffff:(?:0:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isLocalhost(v4) || isReservedIpv4(v4);
  }
  return false;
}

/**
 * True when `hostname` is localhost-like, private, link-local, or otherwise
 * reserved — i.e. an unsafe SSRF/internal-egress target. Combines `isLocalhost`
 * (private ranges) with the reserved-range guards above. Syntactic + literal-IP
 * only; a hostname can still resolve to a private IP at request time (no DNS
 * rebind protection).
 */
export function isPrivateOrReservedHost(hostname: string): boolean {
  const host = normalizeIpHostname(hostname);
  return isLocalhost(host) || isReservedIpv4(host) || isReservedIpv6(host);
}

/**
 * Guard a user-supplied URL we are about to fetch server-side: require http(s)
 * and reject private/localhost/reserved hosts. Returns true only when safe to
 * fetch. Use before any server-initiated `fetch()` of a caller-controlled URL.
 */
export function isPublicHttpUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  // URL.hostname keeps IPv6 literals bracketed (`[::1]`) — strip for the checks.
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  return !isPrivateOrReservedHost(host);
}

/**
 * Host bucket for a full URL (host incl. port, lowercased); unparseable URLs
 * bucket to "unknown". Shared key for per-host crawl scheduling and per-host
 * batch diversity so both bucket identically (#440).
 */
export function urlHostKey(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "unknown";
  }
}

/**
 * Configurable reserved names that should be rejected as domains.
 * Set by CLI to reject command names like "audit", "init", etc.
 */
let _reservedNames: readonly string[] = [];

export function setReservedNames(names: readonly string[]): void {
  _reservedNames = names;
}

export type DomainValidationResult = { valid: boolean; error?: string };

/**
 * Check if hostname looks like a valid domain
 * Rejects reserved names, requires TLD for regular domains
 * Exported (#892) so normalizeWebsiteInput (api) shares this instead of its
 * own looser dot-only check.
 */
export function isValidDomain(hostname: string): DomainValidationResult {
  const lower = hostname.toLowerCase();

  // Reject reserved names (e.g. CLI command names)
  if (_reservedNames.includes(lower)) {
    return {
      valid: false,
      error: `"${hostname}" doesn't look like a valid domain. Did you mean to run a command?`,
    };
  }

  // Allow localhost variants
  if (lower === "localhost" || lower.endsWith(".localhost")) {
    return { valid: true };
  }

  // Allow IP addresses (handle both bracketed and non-bracketed IPv6)
  const normalizedHost = normalizeIpHostname(hostname);
  if (isIP(normalizedHost)) {
    return { valid: true };
  }

  // Require at least one dot for regular domains
  if (!hostname.includes(".")) {
    return {
      valid: false,
      error: `"${hostname}" doesn't look like a valid domain (missing TLD)`,
    };
  }

  // Basic TLD validation: last segment must be 2+ letters
  const parts = hostname.split(".");
  const tld = parts[parts.length - 1];
  if (!/^[a-z]{2,}$/i.test(tld)) {
    return {
      valid: false,
      error: `"${hostname}" has an invalid TLD`,
    };
  }

  return { valid: true };
}

/**
 * Parse user-entered URL and normalize
 * - Regular domains → https://
 * - Localhost/local IPs → http://
 */
export function parseUserUrl(input: string): UrlParseResult {
  const trimmed = input.trim();

  if (!trimmed) {
    return { ok: false, error: "URL cannot be empty" };
  }

  // Reject non-http(s) schemes
  if (hasNonHttpScheme(trimmed)) {
    return {
      ok: false,
      error: "Unsupported protocol. Use http:// or https://",
    };
  }

  // Add scheme if missing
  let urlString = trimmed;
  const hasScheme = trimmed.includes("://");
  if (!hasScheme) {
    urlString = `https://${trimmed}`;
  }

  try {
    const parsed = new URL(urlString);

    // Validate domain looks reasonable
    const domainCheck = isValidDomain(parsed.hostname);
    if (!domainCheck.valid) {
      return { ok: false, error: domainCheck.error! };
    }

    const local = isLocalhost(parsed.hostname);

    // Only normalize scheme when user didn't provide one
    if (!hasScheme) {
      if (local) {
        parsed.protocol = "http:";
      } else {
        parsed.protocol = "https:";
      }
    }

    return { ok: true, url: parsed.toString() };
  } catch {
    return { ok: false, error: `Invalid URL: "${input}"` };
  }
}

// ============================================
// URL utilities (internal usage)
// ============================================

/**
 * Normalize a URL for comparison/deduplication
 * - Lowercases scheme and host (case-insensitive per RFC)
 * - Preserves pathname case (case-sensitive on most servers)
 * - Removes trailing slashes and hash fragments
 */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    let path = parsed.pathname;
    if (path.endsWith("/") && path !== "/") {
      path = path.slice(0, -1);
    }
    // Only lowercase scheme and host, preserve path case
    const scheme = parsed.protocol.toLowerCase();
    const host = parsed.host.toLowerCase();
    return `${scheme}//${host}${path}`;
  } catch {
    return url;
  }
}

/**
 * Check if a URL is valid
 */
export function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a URL is internal (same origin)
 */
export function isInternalUrl(url: string, baseUrl: string): boolean {
  try {
    const urlOrigin = new URL(url).origin;
    const baseOrigin = new URL(baseUrl).origin;
    return urlOrigin === baseOrigin;
  } catch {
    return false;
  }
}

/**
 * Get the origin from a URL
 */
export function getOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * Resolve a relative URL against a base URL
 */
export function resolveUrl(href: string, baseUrl: string): string | null {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

// TLDs we accept when guessing that a schemeless href like "example.com/page"
// was meant to be an absolute URL. Deliberately excludes TLDs that collide
// with common file extensions (.zip, .md, .mov, .sh, .pl, .py) — a bare
// "index.html"-style href must resolve relative to the page, like browsers do.
const SCHEMELESS_COERCIBLE_TLDS = new Set([
  "com",
  "org",
  "net",
  "io",
  "co",
  "dev",
  "app",
  "ai",
  "edu",
  "gov",
  "mil",
  "info",
  "biz",
  "me",
  "tv",
  "cc",
  "xyz",
  "site",
  "online",
  "store",
  "shop",
  "blog",
  "cloud",
  "design",
  "agency",
  "studio",
  "tech",
  "digital",
  "media",
  "news",
  "live",
  "world",
  "today",
  "uk",
  "de",
  "fr",
  "es",
  "it",
  "nl",
  "be",
  "at",
  "ch",
  "se",
  "no",
  "dk",
  "fi",
  "ie",
  "pt",
  "gr",
  "cz",
  "ro",
  "hu",
  "ru",
  "ua",
  "tr",
  "il",
  "ae",
  "sa",
  "in",
  "cn",
  "jp",
  "kr",
  "tw",
  "hk",
  "sg",
  "my",
  "th",
  "vn",
  "id",
  "ph",
  "au",
  "nz",
  "za",
  "ng",
  "ke",
  "eg",
  "br",
  "mx",
  "ar",
  "cl",
  "pe",
  "ca",
  "us",
  "eu",
  "asia",
]);

/**
 * Coerce a schemeless domain-shaped href ("example.com/page") to https.
 * Anything else — including bare filenames like "index.html" — is returned
 * unchanged so it resolves relative to the page URL, matching browser
 * behavior. Only hosts ending in a well-known TLD (or starting with "www.")
 * are treated as authoring mistakes worth coercing.
 */
export function coerceSchemelessUrl(href: string): string {
  const lowerHref = href.toLowerCase();
  if (lowerHref.startsWith("http://") || lowerHref.startsWith("https://")) return href;
  if (href.startsWith("/") || href.startsWith("./") || href.startsWith("../")) return href;
  if (href.includes(":")) return href;

  const host = href.split(/[/?#]/, 1)[0];
  const labels = host.split(".");
  if (labels.length < 2 || labels.some((l) => l.length === 0)) return href;

  const tld = labels[labels.length - 1].toLowerCase();
  if (labels[0].toLowerCase() === "www" || SCHEMELESS_COERCIBLE_TLDS.has(tld)) {
    return `https://${href}`;
  }

  return href;
}

function explicitUrlScheme(href: string): string | null {
  const input = href.trimStart();
  const colon = input.indexOf(":");
  if (colon <= 0 || colon > 64) return null;

  let scheme = "";
  for (let i = 0; i < colon; i++) {
    const char = input[i];
    // WHATWG URL parsing ignores ASCII tabs/newlines in schemes. Compact them
    // here so values such as "java\nscript:" cannot evade the filter.
    if (char === "\t" || char === "\n" || char === "\r") continue;
    const code = char.charCodeAt(0);
    const isAlpha = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    const isDigit = code >= 48 && code <= 57;
    if (
      (scheme.length === 0 && !isAlpha) ||
      (!isAlpha && !isDigit && char !== "+" && char !== "-" && char !== ".")
    ) {
      return null;
    }
    scheme += char.toLowerCase();
  }
  return scheme || null;
}

/** True for browser-executable or inline-data URL schemes. */
export function hasUnsafeUrlScheme(href: string): boolean {
  const scheme = explicitUrlScheme(href);
  return scheme === "javascript" || scheme === "vbscript" || scheme === "data";
}

/** True when an href has an explicit scheme other than HTTP(S). */
export function hasNonCrawlableUrlScheme(href: string): boolean {
  const scheme = explicitUrlScheme(href);
  return scheme !== null && scheme !== "http" && scheme !== "https";
}

/**
 * Check if a crawl href should be skipped. Relative URLs and HTTP(S) are
 * crawlable; fragments and every other explicit scheme are not.
 */
export function shouldSkipUrl(href: string): boolean {
  const trimmed = href.trimStart();
  if (trimmed.startsWith("#")) return true;
  return hasNonCrawlableUrlScheme(trimmed);
}

/**
 * Get pathname from a URL safely
 * Returns empty string if URL is invalid
 */
export function getPathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

/**
 * Get hostname from a URL safely
 * Returns empty string if URL is invalid
 */
export function getHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

// ============================================
// Project Name Utilities
// ============================================

export interface ProjectNameContext {
  isLocal: boolean;
  suggestedName: string;
  needsCustomName: boolean;
}

/**
 * Get project name context for a URL
 * Determines if a custom project name should be prompted for local addresses
 */
export function getProjectNameContext(url: string, configName?: string): ProjectNameContext {
  try {
    const parsed = new URL(url);
    const local = isLocalhost(parsed.hostname);

    // Generate suggested name (matches domainToProjectName logic)
    const hostname = parsed.hostname;
    const base = hostname.replace(/\./g, "-");
    const suggestedName = local && parsed.port ? `${base}-${parsed.port}` : base;

    return {
      isLocal: local,
      suggestedName,
      // Prompt for custom name if local AND no config name set
      needsCustomName: local && !configName,
    };
  } catch {
    return {
      isLocal: false,
      suggestedName: "default",
      needsCustomName: false,
    };
  }
}
