/**
 * What to offer when an audit's entry URL redirected to another site
 * (squirrelscan/repo#3480): audit the destination instead, or, when the
 * destination is a sign-in page, nothing to audit until the site can be
 * signed in to. The sign-in hosts are the ones the failed-audits guide lists
 * (guides/failed-audits#offsite-redirect), so a destination reads as a sign-in
 * page on every surface or on none.
 */

/**
 * Hosts whose whole job is signing people in. A leading dot is a tenant suffix
 * (`<team>.cloudflareaccess.com`); anything else is the exact host. vercel.com
 * is here because a protected preview deployment bounces every anonymous
 * request to its SSO.
 */
export const SIGN_IN_HOSTS: readonly string[] = [
  ".cloudflareaccess.com",
  "vercel.com",
  ".okta.com",
  ".oktapreview.com",
  ".auth0.com",
  ".onelogin.com",
  ".amazoncognito.com",
  ".b2clogin.com",
  ".clerk.accounts.dev",
  "login.microsoftonline.com",
  "login.live.com",
  "accounts.google.com",
  "accounts.shopify.com",
  "id.atlassian.com",
  "appleid.apple.com",
];

/** First labels that name a sign-in host on any domain: login.example.com. */
export const SIGN_IN_FIRST_LABELS: ReadonlySet<string> = new Set([
  "login",
  "signin",
  "sign-in",
  "sso",
  "auth",
  "accounts",
  "account",
]);

/** Where the guide says what to do about a sign-in page or access gateway. */
export const SIGN_IN_DOCS_URL = "https://docs.squirrelscan.com/guides/failed-audits#access-gateway";

/**
 * Is `host` (a URL `host`, port allowed) a sign-in host? One in
 * {@link SIGN_IN_HOSTS}, or a host of three labels or more whose first label
 * is in {@link SIGN_IN_FIRST_LABELS}.
 */
export function isSignInHost(host: string): boolean {
  const bare = host
    .toLowerCase()
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
  if (SIGN_IN_HOSTS.some((h) => (h.startsWith(".") ? bare.endsWith(h) : bare === h))) return true;
  const labels = bare.split(".");
  return labels.length > 2 && SIGN_IN_FIRST_LABELS.has(labels[0] ?? "");
}

export type OffSiteRedirectFollowUp =
  /** Audit the destination's origin instead, with the exact command. */
  | { kind: "audit"; origin: string; command: string }
  /** The destination is a sign-in page: nothing to audit there. */
  | { kind: "sign_in"; origin: string; docsUrl: string };

/**
 * The follow-up for an entry URL that redirected to `targetUrl`, or null for a
 * value that is not an http(s) URL. Only the origin is offered: the path and
 * query of a redirect are the site's to choose and can carry a session or a
 * return address, and an audit starts from a site, not a deep link.
 */
export function offSiteRedirectFollowUp(targetUrl: string): OffSiteRedirectFollowUp | null {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const origin = url.origin;
  if (isSignInHost(url.host)) return { kind: "sign_in", origin, docsUrl: SIGN_IN_DOCS_URL };
  return { kind: "audit", origin, command: `squirrel audit ${shellWord(origin)}` };
}

/**
 * `value` as one shell word: bare when it is only URL characters no shell
 * treats specially, single-quoted otherwise (an IPv6 origin's brackets are a
 * glob in zsh).
 */
function shellWord(value: string): string {
  return /^[A-Za-z0-9.:/_-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}
