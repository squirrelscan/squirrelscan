// WAF and bot-challenge evidence on a refused answer (#1920).
//
// A 403 from the app itself (a JSON error, a plain "Forbidden") means the
// resource is protected. A 403 a WAF or bot wall sent in the app's place says
// nothing about the resource: the request never reached it. These markers tell
// the two apart. One list, shared by the probing rules (security/exposed-files,
// security/unauthenticated-api, security/json-sensitive-fields) and mirrored by
// the cloud link checker's `WAF_403_MARKERS`.
//
// Read the markers on a refusal (401/403) only. Several are present on every
// answer from a protected site (a DataDome cookie, an Akamai header, Cloudflare's
// challenge-platform script), so on a 2xx they prove nothing.

export interface WafMarker {
  vendor: string;
  /** Header names whose presence is evidence. Lowercase. */
  headers?: readonly string[];
  /** Header name prefixes whose presence is evidence. Lowercase. */
  headerPrefixes?: readonly string[];
  /** Cookie names (from `set-cookie`) that are evidence. */
  cookies?: readonly RegExp[];
  /** Lowercase substrings of the body that are evidence. */
  bodyMarkers?: readonly string[];
  /** Header that must also be present and contain `contains` for body markers to count. */
  bodyNeeds?: { header: string; contains: string };
}

/** WAF and bot-challenge markers by vendor. */
export const WAF_CHALLENGE_MARKERS: readonly WafMarker[] = [
  {
    vendor: "cloudflare",
    headers: ["cf-mitigated"],
    bodyMarkers: ["challenge-platform", "cf-chl", "just a moment"],
    bodyNeeds: { header: "server", contains: "cloudflare" },
  },
  {
    vendor: "akamai",
    headerPrefixes: ["x-akamai-"],
    bodyMarkers: ["akamaighost", "reference #"],
  },
  { vendor: "datadome", headers: ["x-datadome"], cookies: [/^datadome$/i] },
  {
    vendor: "perimeterx",
    headerPrefixes: ["x-px"],
    cookies: [/^_px/i],
    bodyMarkers: ["_pxappid", "_pxhd", "px-captcha"],
  },
  { vendor: "imperva", headers: ["x-iinfo"], cookies: [/^incap_ses/i] },
  { vendor: "sucuri", headers: ["x-sucuri-id"] },
  { vendor: "aws-waf", headerPrefixes: ["x-amzn-waf-"] },
];

/** What a marker check reads from one answer. */
export interface WafSniff {
  headers?:
    | Headers
    | Readonly<Record<string, string | null | undefined>>
    | null;
  /** Cookie names. When omitted and `headers` is a `Headers`, read from its `set-cookie`. */
  cookieNames?: readonly string[] | null;
  body?: string | null;
}

/** Cookie names set by an answer's `set-cookie` headers. */
export function setCookieNames(headers: Headers): string[] {
  return headers
    .getSetCookie()
    .map((c) => c.split("=", 1)[0]?.trim() ?? "")
    .filter((name) => name.length > 0);
}

/** The vendor whose markers an answer carries, or null. See {@link WAF_CHALLENGE_MARKERS}. */
export function wafChallengeVendor(
  sniff: WafSniff | null | undefined
): string | null {
  if (!sniff) return null;
  const headers = new Map<string, string>();
  const raw = sniff.headers;
  if (raw instanceof Headers) {
    raw.forEach((value, name) =>
      headers.set(name.toLowerCase(), value.toLowerCase())
    );
  } else if (raw) {
    for (const [name, value] of Object.entries(raw)) {
      headers.set(name.toLowerCase(), (value ?? "").toLowerCase());
    }
  }
  const cookies =
    sniff.cookieNames ?? (raw instanceof Headers ? setCookieNames(raw) : []);
  const body = (sniff.body ?? "").toLowerCase();
  const names = [...headers.keys()];
  for (const m of WAF_CHALLENGE_MARKERS) {
    if (m.headers?.some((h) => headers.has(h))) return m.vendor;
    if (m.headerPrefixes?.some((p) => names.some((k) => k.startsWith(p))))
      return m.vendor;
    if (m.cookies?.some((re) => cookies.some((c) => re.test(c))))
      return m.vendor;
    if (m.bodyMarkers && body) {
      if (
        m.bodyNeeds &&
        !headers.get(m.bodyNeeds.header)?.includes(m.bodyNeeds.contains)
      )
        continue;
      if (m.bodyMarkers.some((marker) => body.includes(marker)))
        return m.vendor;
    }
  }
  return null;
}

/** True when an answer carries WAF or bot-challenge markers. */
export function hasWafChallengeEvidence(
  sniff: WafSniff | null | undefined
): boolean {
  return wafChallengeVendor(sniff) !== null;
}
