import {
  TECH_DETECT_HEADER_MAX_CHARS,
  TECH_DETECT_HEADER_NAMES,
  TECH_DETECT_MAX_COOKIE_NAMES,
} from "./constants";

// Shared validation for user-supplied HTTP request headers (#494, #532).
// These values are replayed onto outbound crawl/render requests, so a CR/LF/NUL
// in a value would enable header injection / request splitting — reject them.

// RFC 7230 token — valid header field-name characters.
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// RFC 7230 field-value chars: HTAB (0x09), SP (0x20), VCHAR (0x21-0x7e),
// obs-text (0x80-0xff). Excludes CR, LF, NUL, and all other control chars.
const HEADER_VALUE_RE = /^[\t\x20-\x7e\x80-\xff]*$/;

/** True if `name` is a valid RFC 7230 header field-name (token). */
export function isValidHeaderName(name: string): boolean {
  return HEADER_NAME_RE.test(name);
}

/**
 * True if `value` is something `[crawler] header_hosts` can read as a host: a
 * host name or address, optionally with an `http://` or `https://` prefix, a
 * port, and a path or trailing slash (which are ignored). Wildcards, userinfo,
 * other schemes, empty labels and a trailing dot are refused, and an
 * internationalised name is accepted (it is matched in its punycode form, #959).
 */
export function isValidHeaderHost(value: string): boolean {
  const raw = value.trim();
  if (raw === "" || /[*@\s\\]/.test(raw) || raw.includes("..")) return false;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
  if (scheme && !/^https?$/i.test(scheme[1]!)) return false;
  const authority = (scheme ? raw.slice(scheme[0].length) : raw).split(/[/?#]/)[0]!;
  if (authority === "" || authority.replace(/:\d{1,5}$/, "").endsWith(".")) return false;
  try {
    return new URL(`https://${authority}`).hostname !== "";
  } catch {
    return false;
  }
}

/**
 * The URL whose origin the custom request headers are scoped to (#959): the
 * crawl's base URL, except that an https start URL whose same-site redirect
 * landed on plain http keeps its https origin. The crawl still follows the
 * redirect, but the headers are never sent over http on the strength of it.
 * A missing or unreadable start URL falls back to the base URL.
 */
export function headerScopeBase(seedUrl: string | null | undefined, baseUrl: string): string {
  try {
    const seed = seedUrl ? new URL(seedUrl) : null;
    const base = baseUrl ? new URL(baseUrl) : null;
    if (seed && base && seed.protocol === "https:" && base.protocol === "http:") return seed.origin;
  } catch {
    // Unreadable: fall through to the base URL.
  }
  return baseUrl;
}

/**
 * Header records merged as HTTP reads them (squirrelscan/repo#3346): names are
 * case-insensitive, so a later record's `user-agent` replaces an earlier
 * `User-Agent` instead of sitting beside it. Spread records keep both keys, and
 * `new Headers(record)` then APPENDS them, sending a combined `a, b` value: a
 * custom header that differed only in case from a built-in one was sent twice.
 * Later records win; the winner's spelling of the name is kept. Absent records
 * are skipped.
 */
export function mergeHeaderRecords(
  ...records: Array<Readonly<Record<string, string>> | null | undefined>
): Record<string, string> {
  const merged = new Map<string, [name: string, value: string]>();
  for (const record of records) {
    if (!record) continue;
    for (const [name, value] of Object.entries(record)) {
      merged.set(name.toLowerCase(), [name, value]);
    }
  }
  return Object.fromEntries(merged.values());
}

/**
 * The agent a custom `User-Agent` header sets (case-insensitive name, last one
 * wins as in {@link mergeHeaderRecords}), or "" when none is set. A request that
 * carries the custom headers sends it, so the crawl's effective agent is this
 * value, not the sticky random one: probes that send no custom headers (the
 * internal link check, the soft-404 confirmation) take the crawl's agent from
 * here so they match the crawl (#1152).
 */
export function customUserAgent(
  headers: Readonly<Record<string, string>> | null | undefined,
): string {
  const found = mergeHeaderRecords(headers);
  for (const [name, value] of Object.entries(found)) {
    if (name.toLowerCase() === "user-agent") return value.trim();
  }
  return "";
}

/** True if `value` contains only safe RFC 7230 field-value chars (no CR/LF/NUL/CTL). */
export function isValidHeaderValue(value: string): boolean {
  return HEADER_VALUE_RE.test(value);
}

const CROSS_ORIGIN_REDIRECT_HEADER_ALLOWLIST = new Set([
  "accept",
  // Kept so a hop asks for the codings its caller can decode: a fetch with the
  // runtime's decoding off (#2717) would otherwise fall back to the default
  // set, which a caller like the sitemap reader does not decode.
  "accept-encoding",
  "accept-language",
  "upgrade-insecure-requests",
  // Kept, including one set through custom headers (`-H "User-Agent: ..."`,
  // `[crawler] headers`): it names the client, it is not a credential, and a
  // hop that dropped it would go out agentless, which WAFs refuse
  // (squirrelscan/repo#1899). A secret belongs in any other header, which a
  // cross-origin hop drops (squirrelscan/repo#3332).
  "user-agent",
]);

/**
 * Same-origin hops retain every header. Cross-origin hops retain only generic
 * browser capability headers, and stripped values stay stripped for the rest
 * of the redirect chain.
 */
export function headersForRedirect(
  headers: HeadersInit | undefined,
  fromUrl: string,
  toUrl: string,
): Headers {
  const result = new Headers(headers);
  if (new URL(fromUrl).origin === new URL(toUrl).origin) return result;

  for (const name of [...result.keys()]) {
    if (!CROSS_ORIGIN_REDIRECT_HEADER_ALLOWLIST.has(name.toLowerCase())) {
      result.delete(name);
    }
  }
  return result;
}

/**
 * Lays the headers the crawler kept for technology detection (pub#871) over a
 * header map built from a stored page. A record that carries them, even as
 * null (none sent), speaks for every header detection reads: one the response
 * stopped sending is dropped from the map, so an older curated value a reused
 * record still holds cannot bring a removed technology back. A record stored
 * before they existed (undefined) leaves the map as it is. `map` is changed in
 * place and returned: pass a map built for the call.
 */
export function overlayTechHeaders(
  map: Record<string, string>,
  techHeaders: Record<string, string> | null | undefined,
): Record<string, string> {
  if (techHeaders === undefined) return map;
  for (const name of TECH_DETECT_HEADER_NAMES) delete map[name];
  delete map["set-cookie"];
  return Object.assign(map, techHeaders);
}

/**
 * The names of the cookies some Set-Cookie values set, as technology
 * detection reads them: `name=`, one per line, null for none (pub#871). A
 * name ends at the first `=` or `;`, so an attribute never joins it. Names
 * are kept whole, at most TECH_DETECT_MAX_COOKIE_NAMES of them, and a name
 * over TECH_DETECT_HEADER_MAX_CHARS is left out rather than cut.
 */
export function techCookieNames(setCookies: Iterable<string>): string | null {
  const names: string[] = [];
  for (const cookie of setCookies) {
    const name = /^[^=;]*/.exec(cookie)?.[0]?.trim() ?? "";
    if (name === "" || name.length > TECH_DETECT_HEADER_MAX_CHARS || names.includes(`${name}=`)) {
      continue;
    }
    names.push(`${name}=`);
    if (names.length === TECH_DETECT_MAX_COOKIE_NAMES) break;
  }
  return names.length > 0 ? names.join("\n") : null;
}

// A DocumentFetcher's `headers["set-cookie"]` is "\n"-joined, one real
// Set-Cookie header per line (packages/fetchers/src/index.ts's headersToRecord)
// because repeated Set-Cookie headers are
// the one case `Headers` never combines, so they have to be flattened into a
// single record string somehow. Rehydrating that joined string back into a
// Headers object via `headers.set("set-cookie", joined)` — or via the
// `new Headers(record)` constructor, which hits the same code path — THROWS
// (a raw "\n" is not a legal single header value). Split and `append()` each
// cookie instead, which is how `Headers` natively keeps repeated Set-Cookie
// entries distinct. Any other malformed header value is skipped rather than
// throwing, so one bad header can't take down the whole rehydration.
/** Rehydrate a Headers object from a stored header record (e.g. a DocumentFetcher response). */
export function recordToHeaders(record: Record<string, string>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === "set-cookie") {
      for (const cookie of value.split("\n")) {
        const trimmed = cookie.trim();
        if (!trimmed) continue;
        try {
          headers.append("set-cookie", trimmed);
        } catch {
          // Ignore invalid header values and continue.
        }
      }
      continue;
    }
    try {
      headers.set(key, value);
    } catch {
      // Ignore invalid header values and continue.
    }
  }
  return headers;
}

/**
 * Whether a media type gets a real win from a transfer coding (#9). Shared by
 * the sub-resource checker (which decides whether a bodiless HEAD is trustworthy
 * evidence) and perf/asset-compression (which decides what to judge), so the two
 * can never disagree about what "text" means.
 *
 * Deliberately classifies by media type rather than by file extension or by
 * which crawl pool a URL came from: an SVG discovered as an <img> is the XML it
 * says it is, while a PNG/WebP/AVIF/font/PDF in that same pool is already
 * entropy-coded and gains nothing.
 */
export function isCompressibleContentType(
  contentType: string | null | undefined
): boolean {
  if (!contentType) return false;
  const t = contentType.toLowerCase();
  return (
    t.includes("text/") ||
    t.includes("application/json") ||
    t.includes("application/javascript") ||
    t.includes("application/xml") ||
    t.includes("+xml") ||
    t.includes("+json")
  );
}

// Which URLs get the audit's custom request headers (#732, #959). The headers
// usually carry credentials (Web Bot Auth, Cloudflare Access, API keys), so only
// the audited origin gets them, plus the hosts the user names.

/** True when the custom headers may be sent to `url`. */
export type HeaderScope = (url: string) => boolean;

interface NamedHeaderHost {
  host: string;
  /** Written with an explicit `http://` prefix: plain http is allowed too. */
  allowHttp: boolean;
}

function parseNamedHeaderHost(value: string): NamedHeaderHost | null {
  const raw = value.trim().toLowerCase();
  try {
    const host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.replace(/^\[|\]$/g, "");
    return host === "" ? null : { host, allowHttp: raw.startsWith("http://") };
  } catch {
    return null;
  }
}

/**
 * `baseUrl` is the start URL after its redirects. Its scheme, host and port
 * match; another port or scheme on the same host does not. `extraHosts` match
 * by host alone, as the user named them, and only over https: an entry written
 * with an explicit `http://` prefix also allows plain http.
 */
export function createHeaderScope(
  baseUrl: string,
  extraHosts: readonly string[] = [],
): HeaderScope {
  let origin = "";
  try {
    origin = baseUrl ? new URL(baseUrl).origin : "";
  } catch {
    // An unparseable base URL has no origin: nothing but named hosts matches.
  }
  const named = new Map<string, boolean>();
  for (const entry of extraHosts) {
    const parsed = parseNamedHeaderHost(entry);
    if (parsed) named.set(parsed.host, (named.get(parsed.host) ?? false) || parsed.allowHttp);
  }
  return (url) => {
    try {
      const parsed = new URL(url);
      if (origin !== "" && parsed.origin === origin) return true;
      const allowHttp = named.get(parsed.hostname.toLowerCase().replace(/^\[|\]$/g, ""));
      if (allowHttp === undefined) return false;
      return parsed.protocol === "https:" || (allowHttp && parsed.protocol === "http:");
    } catch {
      return false;
    }
  };
}
