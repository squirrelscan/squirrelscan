/**
 * robots.txt URL checking utilities
 */

import type { RobotsTxtData, RobotsRule } from "@squirrelscan/core-contracts";

import { stripControlChars } from "@squirrelscan/core-contracts/control-chars";

/**
 * Check if a URL is disallowed by robots.txt rules, the way Google reads them
 * (pub#556), so every rule that asks "is this page blocked" gets one answer:
 *
 * - the groups for `userAgent` (matched without case, several merged), else
 *   the `*` groups;
 * - of the rules whose path matches, the longest wins, and Allow wins a tie;
 * - `*` in a rule matches any run of characters and a trailing `$` anchors
 *   the end;
 * - the path includes the query string;
 * - the rule and the URL are compared with their percent-encoding
 *   normalised, so `/café` matches `/caf%C3%A9` and `/%66oo` matches `/foo`.
 *
 * @param url - URL to check
 * @param robotsTxt - Parsed robots.txt data
 * @param userAgent - User-agent to check (default: "Googlebot")
 * @returns true if URL is disallowed, false if allowed
 */
export function isRobotsTxtDisallowed(
  url: string,
  robotsTxt: RobotsTxtData | null,
  userAgent = "Googlebot"
): boolean {
  if (!robotsTxt?.exists) return false;

  let target: string;
  try {
    const parsed = new URL(url);
    target = normalizeRobotsPath(parsed.pathname + parsed.search);
  } catch {
    return false;
  }

  const agent = userAgent.toLowerCase();
  let groups = robotsTxt.rules.filter((r) => r.userAgent.toLowerCase() === agent);
  if (groups.length === 0) groups = robotsTxt.rules.filter((r) => r.userAgent === "*");
  if (groups.length === 0) return false;

  let best: { length: number; allow: boolean } | null = null;
  for (const group of groups) {
    for (const rule of group.rules) {
      if (!rule.path) continue;
      const pattern = normalizeRobotsPath(rule.path);
      if (!robotsPathMatches(pattern, target)) continue;
      const length = pattern.length;
      const allow = rule.type === "allow";
      if (!best || length > best.length || (length === best.length && allow && !best.allow)) {
        best = { length, allow };
      }
    }
  }
  return best !== null && !best.allow;
}

/**
 * A rule path or URL path in one spelling: non-ASCII characters, controls,
 * spaces and the quote and angle-bracket characters percent-encoded as UTF-8
 * (as the URL parser encodes a path), `%XX` escapes of unreserved characters decoded, and every other
 * escape upper-cased. `*` and `$` are ASCII, so a pattern keeps its operators.
 */
function normalizeRobotsPath(path: string): string {
  let encoded = "";
  for (const ch of path) {
    const code = ch.charCodeAt(0);
    if (code > 0x20 && code < 0x7f && !'"<>`'.includes(ch)) {
      encoded += ch;
      continue;
    }
    try {
      encoded += encodeURIComponent(ch);
    } catch {
      encoded += ch; // a lone surrogate cannot be encoded
    }
  }
  return encoded.replace(/%([0-9a-fA-F]{2})/g, (_, hex: string) => {
    const char = String.fromCharCode(Number.parseInt(hex, 16));
    return /[A-Za-z0-9\-._~]/.test(char) ? char : `%${hex.toUpperCase()}`;
  });
}

/**
 * Whether a robots.txt path pattern matches `path` from its start. `*` is any
 * run of characters and a trailing `$` anchors the end. Greedy leftmost
 * matching of the literal pieces is exact for `*`-only patterns and linear in
 * the path, so a site's pattern full of `*` cannot make it backtrack.
 */
function robotsPathMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const parts = (anchored ? pattern.slice(0, -1) : pattern).split("*");
  const first = parts[0] ?? "";
  if (!path.startsWith(first)) return false;
  let pos = first.length;
  if (parts.length === 1) return anchored ? path.length === pos : true;
  for (let i = 1; i < parts.length - 1; i++) {
    const part = parts[i] ?? "";
    const at = path.indexOf(part, pos);
    if (at === -1) return false;
    pos = at + part.length;
  }
  const last = parts[parts.length - 1] ?? "";
  if (anchored) return path.length - last.length >= pos && path.endsWith(last);
  return path.indexOf(last, pos) !== -1;
}

/**
 * Parse robots.txt content into structured data
 */
export function parseRobotsTxt(content: string, url: string): RobotsTxtData {
  const lines = content.split("\n");
  const rules: RobotsRule[] = [];
  const sitemaps: string[] = [];
  const errors: string[] = [];

  let currentUserAgents: string[] = [];
  let currentRules: { type: "allow" | "disallow"; path: string }[] = [];
  let currentCrawlDelay: number | undefined;
  // Consecutive User-agent records belong to one group. The first non-UA
  // record closes that header, so a later User-agent starts a new group.
  let collectingUserAgents = true;
  // Empty Allow/Disallow records do not match a path, but they still make the
  // named group explicit and keep it from falling through to `*`.
  let hasGroupRecord = false;

  const flushCurrentGroup = () => {
    if (hasGroupRecord) {
      for (const userAgent of currentUserAgents) {
        rules.push({
          userAgent,
          rules: [...currentRules],
          crawlDelay: currentCrawlDelay,
        });
      }
    }
    currentUserAgents = [];
    currentRules = [];
    currentCrawlDelay = undefined;
    collectingUserAgents = true;
    hasGroupRecord = false;
  };

  for (const rawLine of lines) {
    const commentIndex = rawLine.indexOf("#");
    const line = (commentIndex === -1 ? rawLine : rawLine.slice(0, commentIndex)).trim();
    if (!line) continue;

    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;

    const directive = line.substring(0, colonIndex).trim().toLowerCase();
    const value = line.substring(colonIndex + 1).trim();

    switch (directive) {
      case "user-agent": {
        if (!value) break;
        if (!collectingUserAgents) flushCurrentGroup();
        currentUserAgents.push(value);
        break;
      }
      case "disallow":
        if (currentUserAgents.length > 0) {
          collectingUserAgents = false;
          hasGroupRecord = true;
          if (value) currentRules.push({ type: "disallow", path: value });
        }
        break;
      case "allow":
        if (currentUserAgents.length > 0) {
          collectingUserAgents = false;
          hasGroupRecord = true;
          if (value) currentRules.push({ type: "allow", path: value });
        }
        break;
      case "crawl-delay":
        if (currentUserAgents.length > 0) {
          collectingUserAgents = false;
          const delay = Number.parseFloat(value);
          if (!Number.isNaN(delay)) {
            currentCrawlDelay = delay;
            hasGroupRecord = true;
          }
        }
        break;
      case "sitemap":
        if (currentUserAgents.length > 0) collectingUserAgents = false;
        if (value) {
          sitemaps.push(value.trim());
        }
        break;
      default:
        if (currentUserAgents.length > 0) collectingUserAgents = false;
    }
  }

  flushCurrentGroup();

  return {
    exists: true,
    url,
    content,
    sizeBytes: new Blob([content]).size,
    sitemaps,
    rules,
    errors,
  };
}

// ============================================
// SITEMAP DIRECTIVE RESOLUTION (#2316)
// ============================================

/**
 * A robots.txt `Sitemap:` directive has to carry an absolute URL. Sites write
 * scheme-less ones anyway:
 *
 *   Sitemap: worldairops.com/sitemap.xml
 *
 * Resolving that with a plain `new URL(value, baseUrl)` reads it as a PATH, so
 * the crawl fetched `https://worldairops.com/worldairops.com/sitemap.xml`, 404'd,
 * and reported the site's robots.txt as pointing at a dead sitemap while the
 * real file was read from a common location under a different source.
 *
 * This is the single reading of a declared value, shared by the fetch path
 * (`discoverSitemaps`) and by what the report stores, so the two can never name
 * different URLs for one line. It mirrors the API-side publish repair
 * (`site-url-normalize.ts`, squirrelscan/repo#2308) value for value.
 */

/**
 * A declared scheme (`https:`, `ftp:`, `mailto:`, ...) at the head of a value.
 *
 * Deliberately narrower than RFC 3986, which allows `.` in a scheme name: that
 * would make `example.com:8080/sitemap.xml` a URL whose SCHEME is `example.com`,
 * which is never what a robots.txt author meant. Excluding `.` sends a
 * host:port value down the host branch instead. No scheme anyone publishes a
 * sitemap under contains a dot.
 */
const SITEMAP_HAS_SCHEME = /^[a-z][a-z0-9+-]*:/i;

/**
 * An http(s) value that spells out its authority.
 *
 * WHATWG also parses `https:sitemap.xml` and `https:/sitemap.xml` as absolute,
 * and gives BOTH the host `sitemap.xml`. Accepting them as already-absolute
 * would point the crawl at a domain the audited site does not own, which is the
 * same trap the host reading below is careful to avoid. They fall through
 * instead and are dropped by the declared-scheme check.
 */
const SITEMAP_HAS_HTTP_AUTHORITY = /^https?:\/\//i;

/**
 * Whitespace anywhere in a value being repaired. Any string at all is a legal
 * relative reference, so without this `not a url at all` would resolve to
 * `https://site/not%20a%20url%20at%20all` and put prose in the report as a
 * sitemap URL. A URL reference carries no unescaped whitespace, and robots.txt
 * directives are whitespace-delimited, so this is the line between "malformed
 * URL worth repairing" and "not a URL at all".
 */
const SITEMAP_HAS_WHITESPACE = /\s/;

/**
 * A first path segment that reads as a hostname: dot-separated labels plus an
 * optional port.
 *
 * Only applied to the segment before the first `/`, so a value has to carry a
 * PATH to read as a host. A bare `sitemap.xml`, and equally `sitemap.xml?p=2`
 * or `sitemap.php?type=posts`, stays a relative path resolved against the
 * origin rather than becoming the host `sitemap.xml`, which would point the
 * report at a domain the audited site does not own.
 */
const SITEMAP_LOOKS_LIKE_HOST =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d+)?$/i;

/** How much of a rejected value is quoted back in an errors entry. */
const MAX_QUOTED_SITEMAP_VALUE = 200;

/** How a declared `Sitemap:` value was read. */
export type RobotsSitemapReading =
  /** Already an absolute http(s) URL. Kept byte for byte. */
  | "absolute"
  /** Scheme-less but host-shaped, e.g. `worldairops.com/sitemap.xml`. */
  | "scheme-less-host"
  /** A relative reference resolved against the origin, e.g. `/sitemap.xml`. */
  | "relative"
  /** Not reachable as an http(s) URL at all. Skipped. */
  | "unresolvable";

export interface RobotsSitemapResolution {
  /** The value exactly as robots.txt declared it. */
  readonly raw: string;
  readonly reading: RobotsSitemapReading;
  /** The absolute http(s) URL to fetch and store, or null when unresolvable. */
  readonly url: string | null;
}

function toHttpUrl(value: string, base?: URL): URL | undefined {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return undefined;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
}

/**
 * The origin of the audited base URL, as the resolution base. robots.txt lives
 * at the origin root, so a relative declaration resolves there rather than
 * against a deep base URL path.
 */
function sitemapResolutionBase(baseUrl: string): URL | undefined {
  const url = toHttpUrl(baseUrl);
  return url ? new URL(url.origin) : undefined;
}

/**
 * Resolve one robots.txt `Sitemap:` value against the audited base URL.
 *
 * Every reading returns the URL in serialised form, which is what the crawl
 * fetched before this helper existed. It is also what makes one declared
 * sitemap dedupe against the same file found at a common location: without it
 * `https://SITE.COM:443/sitemap.xml` and `https://site.com/sitemap.xml` are two
 * entry points for one file, spending the walk's URL budget twice and, on a
 * 404, recording the same file as failed under two different sources.
 */
export function resolveRobotsSitemapUrl(value: unknown, baseUrl: string): RobotsSitemapResolution {
  const raw = typeof value === "string" ? value : "";
  if (typeof value !== "string") return { raw, reading: "unresolvable", url: null };

  const trimmed = raw.trim();
  if (SITEMAP_HAS_HTTP_AUTHORITY.test(trimmed)) {
    const absolute = toHttpUrl(trimmed);
    if (absolute) return { raw, reading: "absolute", url: absolute.href };
    return { raw, reading: "unresolvable", url: null };
  }

  const base = sitemapResolutionBase(baseUrl);
  // A value that declares its own scheme and did not spell out an http(s)
  // authority is either off-protocol (`ftp://`, `file://`) or malformed
  // (`https:sitemap.xml`). Neither is resolved against the base: #1393 already
  // refuses to fetch the first, and resolving the second lands on a host the
  // audited site does not own. Skip it.
  if (!trimmed || SITEMAP_HAS_WHITESPACE.test(trimmed) || SITEMAP_HAS_SCHEME.test(trimmed)) {
    return { raw, reading: "unresolvable", url: null };
  }
  if (!base) return { raw, reading: "unresolvable", url: null };

  const firstSegment = trimmed.split("/", 1)[0] ?? "";
  const isHost =
    firstSegment.length < trimmed.length && SITEMAP_LOOKS_LIKE_HOST.test(firstSegment);
  const resolved = toHttpUrl(isHost ? `${base.protocol}//${trimmed}` : trimmed, base)?.href;
  if (resolved === undefined) return { raw, reading: "unresolvable", url: null };
  return { raw, reading: isHost ? "scheme-less-host" : "relative", url: resolved };
}

/** A declared value quoted back into an errors entry, bounded and de-escaped. */
function quoteSitemapValue(raw: string): string {
  const safe = stripControlChars(raw).trim();
  return safe.length > MAX_QUOTED_SITEMAP_VALUE
    ? `${safe.slice(0, MAX_QUOTED_SITEMAP_VALUE)}...`
    : safe;
}

/**
 * The robots.txt parse problem a resolution represents, or null when the value
 * needed no repair.
 *
 * A scheme-less host is reported rather than silently repaired: the declaration
 * is invalid per the sitemaps protocol, the reader should fix it, and saying
 * which URL was read instead is what keeps the report's own sitemap entries
 * explicable.
 *
 * A relative value is NOT reported. Those already resolved against the origin
 * before this helper existed and still do, so flagging them would be a new
 * finding on a large share of healthy sites rather than a fix for this bug.
 */
export function robotsSitemapIssue(resolution: RobotsSitemapResolution): string | null {
  if (resolution.reading === "scheme-less-host" && resolution.url) {
    return `Sitemap "${quoteSitemapValue(resolution.raw)}" is missing a scheme; read as ${resolution.url}`;
  }
  if (resolution.reading === "unresolvable") {
    return `Sitemap "${quoteSitemapValue(resolution.raw)}" is not an absolute http(s) URL; ignored`;
  }
  return null;
}

export interface ResolvedRobotsSitemaps {
  /** Absolute http(s) URLs, in declaration order, with unusable values removed. */
  readonly urls: string[];
  /** robots.txt parse problems, for the report's `robotsTxt.errors` list. */
  readonly issues: string[];
}

/** `resolveRobotsSitemapUrl` over a whole `Sitemap:` list. */
export function resolveRobotsSitemapUrls(
  values: readonly unknown[],
  baseUrl: string
): ResolvedRobotsSitemaps {
  const urls: string[] = [];
  const issues: string[] = [];
  for (const value of values) {
    const resolution = resolveRobotsSitemapUrl(value, baseUrl);
    if (resolution.url !== null) urls.push(resolution.url);
    const issue = robotsSitemapIssue(resolution);
    if (issue !== null) issues.push(issue);
  }
  return { urls, issues };
}
