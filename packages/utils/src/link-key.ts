/**
 * Canonical link key (#2114 milestone 1).
 *
 * One global, org-blind cache key for an external URL, so every audit of every
 * org that links to the same resource shares one verdict. The rules that
 * consume a verdict still report the RAW url the page linked to, which is why
 * {@link canonicalLinkKey} hands both back.
 *
 * The key is computed from the URL after the redactor's site-independent passes
 * (credentials, userinfo, JWTs in any URL; #3384), the same rewrite the
 * published report applies to its hrefs, so the key of a raw href and the key of
 * the report's redacted href are one string and no secret reaches a shared key.
 *
 * Deliberately NOT `normalizeUrl`/`normalizePageUrl` from `@squirrelscan/utils`
 * (#2063): the first is query-BLIND, which would collapse `?id=1` and `?id=2`
 * into one verdict, and the second keeps the query VERBATIM, which would split
 * one link into a fresh cache miss per `utm_campaign`. A link-check key needs
 * the middle ground: keep the query, drop the tracking noise, sort the rest.
 */

import { carriesRedactedValue, redactSecretText } from "./secret-url-redaction";

/**
 * No host is the audited site's own, so only what the redactor removes from
 * every URL goes (credentials, userinfo, JWTs); the per-visitor passes, which
 * apply to a site's own URLs, do not (#3384). Never `null`: that treats every
 * URL as the site's own.
 */
const NO_SITE_HOSTS: ReadonlySet<string> = new Set();

/**
 * `raw` as the shared keys see it: the redactor's site-independent passes
 * applied. The one function every verdict-key producer goes through
 * ({@link canonicalLinkKey}); idempotent, so a key from an already-redacted
 * report href is the key from the raw one.
 */
export function redactForLinkKey(raw: string): string {
  // Percent-encoding is normalized first, so an encoded secret (`%65yJ…`, a JWT
  // header) is read as the redactor reads it plain, and to a fixed point, so a
  // key built from the result is itself unchanged by this function.
  let out = raw;
  for (let round = 0; round < 4; round++) {
    const next = redactSecretText(normalizePercentEncoding(out), NO_SITE_HOSTS);
    if (next === out) return out;
    out = next;
  }
  return out;
}

/**
 * Query parameters dropped before keying, per the epic. Split into prefixes
 * (`utm_source`, `utm_campaign`, … all collapse to one key) and exact names.
 *
 * Deliberately SHORTER than the crawler frontier's list
 * (`@squirrelscan/crawler`): the frontier is choosing which of a site's OWN
 * urls to fetch, where over-dropping costs a page. Here, over-dropping means
 * two different external resources share a verdict, so the list stays at the
 * ones the epic named until a measured miss rate argues for more.
 */
export const TRACKING_PARAM_PREFIXES: readonly string[] = ["utm_"];

export const TRACKING_PARAM_NAMES: readonly string[] = [
  "fbclid",
  "gclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "ref",
  "igshid",
  "_hsenc",
  "yclid",
];

const TRACKING_NAME_SET = new Set(TRACKING_PARAM_NAMES);

/**
 * Query parameters that carry a credential (#2782): a bearer or session token, a
 * signature, an API key. Bloomberg's gift links carry the sharer's
 * `accessToken` JWT, and a signed S3 url its `X-Amz-Signature`.
 *
 * Dropped from the key, like tracking parameters, so no token becomes the
 * primary key of a shared row; links that differ only by one share a verdict.
 * Their VALUES are replaced by `REDACTED` in anything stored or printed
 * ({@link redactCredentialParams}). The fetch url keeps them: a signed url is
 * not fetchable without its signature, and the fetch url never reaches a
 * shared row unredacted.
 */
export const CREDENTIAL_PARAM_NAMES: readonly string[] = [
  "access_token",
  "access-token",
  "accesstoken",
  "token",
  "id_token",
  "refresh_token",
  "auth",
  "auth_token",
  "auth-token",
  "authorization",
  "jwt",
  "sig",
  "signature",
  "x-amz-signature",
  "x-amz-credential",
  "x-amz-security-token",
  "x-goog-signature",
  "x-goog-credential",
  "api_key",
  "api-key",
  "x-api-key",
  "apikey",
  "password",
  "passwd",
  "pwd",
  "secret",
  "client_secret",
  "sessionid",
  "session_id",
];

const CREDENTIAL_NAME_SET = new Set(CREDENTIAL_PARAM_NAMES);
/** A JSON Web Token as a query value, whatever the parameter is called. */
const JWT_VALUE = /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;

/** True for a parameter that carries a credential, by its name or a JWT value. */
export function isCredentialParam(name: string, value = ""): boolean {
  return CREDENTIAL_NAME_SET.has(name.toLowerCase()) || JWT_VALUE.test(value);
}

/**
 * Query parameters that are not a credential on their own but are per-visitor or
 * per-request (#2797): a session id, an OAuth callback's `code` and `state`, and
 * the other halves of a signed url (S3 and GCS v4, CloudFront, Azure SAS, Akamai
 * token auth). A redirect's landing url is minted for the request Perch sent,
 * so these are stored only as {@link REDACTED_VALUE}
 * (`storableLandingUrl`). Keys keep them: they can choose what a page serves,
 * and a page that links to one publishes it itself.
 *
 * Generous on purpose: in a stored landing url an over-redacted value costs a
 * display detail, a missed one leaks a session to every org.
 */
export const SESSION_PARAM_NAMES: readonly string[] = [
  "sid",
  "session",
  "sess",
  "sessid",
  "session_token",
  "session-token",
  "sessiontoken",
  "phpsessid",
  "jsessionid",
  "aspsessionid",
  "cfid",
  "cftoken",
  "ticket",
  "code",
  "state",
  "nonce",
  "otp",
  "key",
  "hmac",
  "exp",
  "expires",
  "policy",
  "key-pair-id",
  "x-amz-algorithm",
  "x-amz-date",
  "x-amz-expires",
  "x-amz-signedheaders",
  "googleaccessid",
  "x-goog-algorithm",
  "x-goog-date",
  "x-goog-expires",
  "x-goog-signedheaders",
  "se",
  "sp",
  "sr",
  "st",
  "sv",
  "skoid",
  "sktid",
  "hdnts",
  "__token__",
  "relaystate",
];

const SESSION_NAME_SET = new Set(SESSION_PARAM_NAMES);

/**
 * Name fragments that mark a per-visitor value whatever the rest of the name
 * (`_wpnonce`, `session_state`, `sesskey`, `csrf_token`, `oauth_verifier`,
 * `SAMLResponse`, `__cf_chl_tk` and a Cloudflare challenge's other landing
 * parameters): a short value under such a name is too short for the
 * token-shape rule to catch. Anchored at the start of the name or after `_` or
 * `-`, so `assessment` and `possession` are not sessions.
 */
const SESSION_NAME_FRAGMENT =
  /(?:^|[_-])(?:sess|token|nonce|csrf|xsrf|verifier|ticket|saml)|wpnonce|__cf_chl/;

/** True for a per-visitor or per-request parameter ({@link SESSION_PARAM_NAMES}), any case. */
export function isSessionParam(name: string): boolean {
  const lower = name.toLowerCase();
  return SESSION_NAME_SET.has(lower) || SESSION_NAME_FRAGMENT.test(lower);
}

/** What a credential parameter's value becomes in anything stored or printed. */
export const REDACTED_VALUE = "REDACTED";

/**
 * `url` with every credential parameter's value replaced by
 * {@link REDACTED_VALUE}, the names and everything else kept byte for byte. For
 * the urls a shared row stores (the raw example, a redirect's final url) and
 * any report that prints one. A url that does not parse comes back unchanged.
 * The name and value are judged percent-decoded, as {@link canonicalQuery}
 * judges them, so `access%5Ftoken` is redacted as surely as it is dropped.
 */
export function redactCredentialParams(url: string): string {
  const query = url.indexOf("?");
  if (query === -1) return url;
  const fragment = url.indexOf("#", query);
  const end = fragment === -1 ? url.length : fragment;
  const parts = url.slice(query + 1, end).split("&");
  let changed = false;
  const redacted = parts.map((part) => {
    const equals = part.indexOf("=");
    if (equals === -1) return part;
    const name = part.slice(0, equals);
    const value = part.slice(equals + 1);
    if (value === REDACTED_VALUE) return part;
    if (!isCredentialParam(normalizePercentEncoding(name), normalizePercentEncoding(value))) {
      return part;
    }
    changed = true;
    return `${name}=${REDACTED_VALUE}`;
  });
  return changed ? `${url.slice(0, query + 1)}${redacted.join("&")}${url.slice(end)}` : url;
}

/** Whether a key still carries a credential parameter (a key from before #2782). */
export function keyCarriesCredential(key: string): boolean {
  return redactCredentialParams(key) !== key;
}

/**
 * Whether a key holds anything the redactor would replace (#3384): a credential
 * parameter ({@link keyCarriesCredential}), or a nested token, a JWT or userinfo
 * a key built by {@link canonicalLinkKey} never has. The test for a key some
 * writer sent, which may predate the redacted form.
 */
export function keyCarriesSecret(key: string): boolean {
  return keyCarriesCredential(key) || redactForLinkKey(key) !== key;
}

/**
 * THE decision every path that takes a link URL makes (#3384): does the redactor
 * change this URL, so it is never requested, cached, pre-warmed or inventoried?
 * The dead-links route and provider, the link-check Worker, the pre-warm and both
 * inventories all call this one function, so none can parse differently. It
 * judges the URL as submitted AND as the WHATWG parser reads it (a tab, a
 * newline, a backslash or a scheme case hides nothing), refuses anything past
 * {@link MAX_LINK_INPUT_LENGTH} unjudged, and a string the parser rejects is
 * refused (a scheme-less secret is judged as submitted first).
 */
export function linkUrlCarriesSecret(url: string): boolean {
  if (url.length > MAX_LINK_INPUT_LENGTH) return true;
  // Against the percent-normalized URL, not the URL as written: an ordinary
  // escape (`/caf%c3%a9`, `/%7Euser`) is rewritten by normalization alone and is
  // not a secret.
  const carries = (candidate: string): boolean =>
    keyCarriesCredential(candidate) ||
    redactForLinkKey(candidate) !== normalizePercentEncoding(candidate);
  if (carries(url)) return true;
  try {
    const href = new URL(url.trim()).href;
    return href !== url && carries(href);
  } catch {
    // Not a URL the parser reads, so nothing can vouch for it (fail closed).
    return true;
  }
}

/**
 * Longest key we will store. The input is harvested off an audited page, so it
 * is fully untrusted: an unbounded primary key is a row a hostile site gets to
 * size. 2 KB is past every real url (browsers stop caring around 2 KB too) and
 * anything longer is reported as unkeyable rather than truncated: a truncated
 * url is a DIFFERENT url, and keying two of them together would hand one
 * resource's verdict to another.
 */
export const MAX_LINK_KEY_LENGTH = 2048;

/** Longest href {@link canonicalLinkKey} will redact: 16 times the key it must fit in. */
const MAX_LINK_INPUT_LENGTH = 16 * MAX_LINK_KEY_LENGTH;

const UNRESERVED_CHAR = /^[A-Za-z0-9\-._~]$/;
const PERCENT_ESCAPE = /%[0-9A-Fa-f]{2}/g;
/** A final path segment that names a file: `.html`, `.PDF`, `.tar.gz`'s `.gz`. */
const FILE_EXTENSION = /\.[A-Za-z0-9]{1,10}$/;

/** True for the parameter names dropped before keying (case-insensitive). */
export function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  if (TRACKING_NAME_SET.has(lower)) return true;
  return TRACKING_PARAM_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * RFC 3986 §6.2.2 percent-encoding normalisation: decode escapes of unreserved
 * characters (`%7E` → `~`) and uppercase the hex of the ones that must stay
 * encoded (`%2f` → `%2F`). Without this, `/%7Euser` and `/~user` are two rows
 * for one page.
 */
export function normalizePercentEncoding(value: string): string {
  return value.replace(PERCENT_ESCAPE, (sequence) => {
    const char = String.fromCharCode(Number.parseInt(sequence.slice(1), 16));
    return UNRESERVED_CHAR.test(char) ? char : sequence.toUpperCase();
  });
}

/**
 * Trailing-slash policy: a path whose last named segment is a FILE keeps
 * whatever it has, everything else loses the trailing slash.
 *
 * `/blog/` and `/blog` are one page on every server anyone ships, so collapsing
 * them is the win this policy exists for. `/logo.png/` is NOT the same request
 * as `/logo.png`: the first 404s on most origins while the second serves the
 * image: so the extension is looked for in the last NON-EMPTY segment, which
 * leaves a file path alone whether or not it carries a trailing slash. Reading
 * the last segment literally would make the empty segment after `logo.png/`
 * look extensionless and hand the image's verdict to a url that does not
 * resolve.
 */
export function applyTrailingSlashPolicy(pathname: string): string {
  const segments = pathname.split("/");
  let lastNamed = "";
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i];
    if (segment !== undefined && segment !== "") {
      lastNamed = segment;
      break;
    }
  }
  if (FILE_EXTENSION.test(lastNamed)) return pathname;
  if (!pathname.endsWith("/")) return pathname;
  // Trim trailing slashes with a scan rather than `/\/+$/`, which backtracks
  // polynomially on a long run of slashes that is not at the end.
  let end = pathname.length;
  while (end > 0 && pathname.charCodeAt(end - 1) === 47) end--;
  const stripped = pathname.slice(0, end);
  // "/" and "///" both collapse to "", which is not a path: the origin's root
  // is "/", and returning "" would key it as a bare `https://example.com`.
  return stripped === "" ? "/" : stripped;
}

/**
 * Sorted, tracking-free query string (without the leading `?`), or "".
 *
 * Works on the RAW bytes rather than round-tripping through `URLSearchParams`.
 * That class decodes to UTF-16 and re-encodes, so every percent escape that is
 * not valid UTF-8 becomes U+FFFD: `?q=%FE` and `?q=%FF` are two different
 * requests and would come back as one key, sharing one verdict. Normalising the
 * escapes textually is lossless.
 */
export function canonicalQuery(search: string): string {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  if (raw === "") return "";

  const kept: Array<{ name: string; pair: string }> = [];
  for (const part of raw.split("&")) {
    if (part === "") continue;
    const equals = part.indexOf("=");
    const name = normalizePercentEncoding(equals === -1 ? part : part.slice(0, equals));
    if (isTrackingParam(name)) continue;
    const value = normalizePercentEncoding(equals === -1 ? "" : part.slice(equals + 1));
    if (isCredentialParam(name, value)) continue;
    // A value the redactor replaced (a JWT or token under an ordinary name, #3384):
    // dropped like a credential parameter, so links that differ only by a secret
    // share a verdict, and a raw href and its redacted report copy key alike.
    if (value === REDACTED_VALUE) continue;
    // A valueless parameter is spelled `name=`, so `?flag` and `?flag=`: which
    // every server reads identically: are one key.
    kept.push({ name, pair: `${name}=${value}` });
  }

  // `sort` is stable by spec, so repeated names keep their relative order -
  // `?a=1&a=2` stays `a=1&a=2` rather than flipping between runs.
  kept.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return kept.map((entry) => entry.pair).join("&");
}

export interface CanonicalLink {
  /** The global cache key. Shared across orgs; never carries who asked. */
  key: string;
  /**
   * The url exactly as the page linked to it, credentials and fragment
   * included. LOCAL USE ONLY: never fetch it, never queue it, never store it.
   * Use {@link CanonicalLink.fetchUrl} for anything that leaves this process.
   */
  raw: string;
  /**
   * The url to fetch: `raw` with the userinfo and the fragment removed, and
   * never longer than {@link MAX_LINK_KEY_LENGTH}. It keeps credential query
   * parameters (a signed url needs its signature), so it is stored only through
   * {@link redactCredentialParams}; the store applies that itself.
   *
   * Both removals are load-bearing, for different reasons. The fragment is
   * never sent to a server, so dropping it costs nothing. The credentials are
   * the serious one: the cache key is credential-BLIND, so a verdict fetched
   * with `alice:secret@` would be stored under the credential-free key and
   * handed to every later requester: a cross-tenant secret disclosure through
   * a cache: and it would also be a verdict about a different response than
   * the key claims to describe.
   */
  fetchUrl: string;
}

/**
 * Strip the parts of a url that must never reach shared storage: the userinfo
 * and the fragment. Returns null for anything unparseable or not http(s).
 *
 * Applied to a redirect's final url as well as to the submitted one: a
 * `Location` header is attacker-controlled in exactly the same way, and it ends
 * up in the same shared column.
 */
export function sanitizeLinkUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== "http:" && scheme !== "https:") return null;
  if (parsed.hostname === "") return null;
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  return parsed.href;
}

/**
 * Canonical key for an external link, or `null` when the input is not a
 * checkable http(s) url (a `mailto:`/`tel:`/`javascript:` href, a relative
 * path with no base, a url past {@link MAX_LINK_KEY_LENGTH}).
 *
 * Normalisation, in order: lowercase scheme and host (WHATWG `URL` also
 * punycodes an IDN host and drops a default port), userinfo dropped, fragment
 * dropped, tracking and credential params dropped, remaining params sorted,
 * percent-encoding normalised, trailing-slash policy applied.
 *
 * Residual, by design (#3339): a link to a host the audited crawl reached is
 * the site's own there, so the report's copy of it loses session parameters this
 * key keeps; the key is for external links, whose off-site hosts both agree on.
 *
 * Pure, so both the Worker and the container can call it, and so the table
 * test is the whole specification.
 */
export function canonicalLinkKey(raw: string): CanonicalLink | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  // The redaction is linear, but its input is a page's href: bound it before
  // the 2 KB key check that runs after.
  if (trimmed.length > MAX_LINK_INPUT_LENGTH) return null;

  let parsed: URL;
  try {
    // Through the parser first, so a spelling the WHATWG parser accepts
    // (`https:/host/x`, a backslash) is redacted as the absolute URL it is.
    parsed = new URL(redactForLinkKey(new URL(trimmed).href));
  } catch {
    return null;
  }

  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== "http:" && scheme !== "https:") return null;
  // `new URL("https://")` throws, but `new URL("file://x")` does not: and a
  // hostless http url is not fetchable, so it is not keyable either.
  if (parsed.hostname === "") return null;

  // `host`, not `hostname`: it carries a NON-default port and already omits a
  // default one, which is exactly the epic's rule. Credentials are read off
  // `username`/`password` and deliberately not reassembled: a shared, global
  // cache key must never carry a secret a page happened to embed.
  const host = parsed.host.toLowerCase();
  const path = applyTrailingSlashPolicy(normalizePercentEncoding(parsed.pathname));
  const query = canonicalQuery(parsed.search);
  const key = `${scheme}//${host}${path}${query === "" ? "" : `?${query}`}`;

  if (key.length > MAX_LINK_KEY_LENGTH) return null;

  // The sanitised url can outrun the key even when the key fits: the key drops
  // tracking parameters and the fetch url keeps them: so it gets the same
  // ceiling, and falls back to the key rather than dropping the link. The key
  // is a real url for the same resource; it just spells it canonically.
  // A key that carries a redacted value is not the link's own URL (a path token
  // became `REDACTED`), so it is no fallback to fetch: such a link is unkeyable.
  const sanitized = sanitizeLinkUrl(trimmed);
  if ((!sanitized || sanitized.length > MAX_LINK_KEY_LENGTH) && carriesRedactedValue(key)) {
    return null;
  }
  const fetchUrl = sanitized && sanitized.length <= MAX_LINK_KEY_LENGTH ? sanitized : key;

  return { key, raw, fetchUrl };
}

/**
 * Canonicalise a batch, keeping the first SANITISED url seen per key (the one
 * the service will actually fetch and store) and the full submitted list per
 * key so a caller can fan one verdict back out to every url that shares it.
 *
 * The submitted urls stay in `rawUrls` and are the caller's own business; only
 * `fetchUrl` crosses into the shared cache.
 */
export function groupByLinkKey(rawUrls: readonly string[]): {
  byKey: Map<string, { fetchUrl: string; rawUrls: string[] }>;
  unkeyable: string[];
} {
  const byKey = new Map<string, { fetchUrl: string; rawUrls: string[] }>();
  const unkeyable: string[] = [];
  for (const rawUrl of rawUrls) {
    const canonical = canonicalLinkKey(rawUrl);
    if (!canonical) {
      unkeyable.push(rawUrl);
      continue;
    }
    const existing = byKey.get(canonical.key);
    if (existing) existing.rawUrls.push(rawUrl);
    else byKey.set(canonical.key, { fetchUrl: canonical.fetchUrl, rawUrls: [rawUrl] });
  }
  return { byKey, unkeyable };
}
