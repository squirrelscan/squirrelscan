// social/social-match - cross-check detected social accounts vs on-page links.
//
// The Stage-0 site profile may know social accounts (LinkedIn, X, …) that the
// crawled page does not actually link. These helpers compare the metadata's
// `socials` against a set of on-page URLs (from <a href> or schema `sameAs`) and
// report which detected accounts are MISSING from the page. Pure — no I/O.

import type { SiteMetadata, SocialAccount, SocialPlatform } from "@squirrelscan/core-contracts";

/** Host fragments that identify each platform in an arbitrary URL. */
const PLATFORM_HOSTS: Record<SocialPlatform, string[]> = {
  x: ["x.com", "twitter.com"],
  facebook: ["facebook.com", "fb.com"],
  instagram: ["instagram.com"],
  linkedin: ["linkedin.com"],
  youtube: ["youtube.com", "youtu.be"],
  tiktok: ["tiktok.com"],
  github: ["github.com"],
  pinterest: ["pinterest.com"],
  threads: ["threads.net"],
  // Only the flagship instance is matched by host; self-hosted Mastodon on an
  // arbitrary domain falls through to `platform: "other"`.
  mastodon: ["mastodon.social"],
  bluesky: ["bsky.app"],
  other: [],
};

/** Human label for a platform (used in messages). */
export function socialPlatformLabel(platform: SocialPlatform): string {
  switch (platform) {
    case "x":
      return "X (Twitter)";
    case "linkedin":
      return "LinkedIn";
    case "youtube":
      return "YouTube";
    case "tiktok":
      return "TikTok";
    case "github":
      return "GitHub";
    default:
      return platform.charAt(0).toUpperCase() + platform.slice(1);
  }
}

interface UrlKey {
  /** Lower-cased host with a leading `www.` stripped (e.g. "x.com"). */
  host: string;
  /** Lower-cased path with the leading slash dropped and trailing slash trimmed. */
  path: string;
}

/**
 * Canonicalize a URL for comparison: strip protocol, `www.`, query, hash, and a
 * trailing slash; lower-case host + path. Protocol-relative (`//x.com/…`) and
 * bare-host (`x.com/…`) inputs are tolerated. Returns null on unparseable input.
 */
function canonicalizeUrl(raw: string): UrlKey | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Give the URL parser a scheme so protocol-relative / bare-host links parse.
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : trimmed.startsWith("//")
      ? `https:${trimmed}`
      : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const path = parsed.pathname.toLowerCase().replace(/\/+$/, "").replace(/^\//, "");
  return { host, path };
}

/** Lower-cased handle without a leading "@" / "/", or "" when absent. */
function normalizeHandle(handle: string | null | undefined): string {
  return (handle ?? "").trim().replace(/^[@/]+/, "").toLowerCase();
}

/**
 * True when `pageKeys` contains a link that matches the detected account. Matching
 * is exact on (platform host, path) — NOT substring — so `x.com/acme` does not
 * match `x.com/acme-support` (prefix collision) nor a bare `x.com` link. As a
 * fallback, a same-platform link whose first path segment equals the account
 * handle counts (covers a sameAs that lists the handle URL in a different form).
 */
function accountIsLinked(account: SocialAccount, pageKeys: UrlKey[]): boolean {
  const acct = canonicalizeUrl(account.url);
  const hosts = PLATFORM_HOSTS[account.platform] ?? [];
  const handle = normalizeHandle(account.handle);
  for (const key of pageKeys) {
    // Exact account reference (best signal): same host AND same path.
    if (acct && key.host === acct.host && key.path === acct.path && acct.path !== "") {
      return true;
    }
    // Same-platform link whose first path segment IS the handle.
    if (handle && hosts.some((h) => key.host === h || key.host.endsWith(`.${h}`))) {
      const firstSegment = key.path.split("/")[0] ?? "";
      if (firstSegment === handle) return true;
    }
  }
  return false;
}

export interface SocialCrossCheck {
  /** Detected accounts the page never links. */
  missing: SocialAccount[];
  /** Detected accounts that ARE linked on the page. */
  linked: SocialAccount[];
}

/**
 * Compare the profile's detected `socials` against a set of on-page URLs.
 * Returns the missing / linked split. When the profile has no socials the result
 * is empty (caller should treat that as "nothing to cross-check").
 */
export function crossCheckSocials(
  meta: SiteMetadata | undefined,
  pageUrls: Iterable<string>,
): SocialCrossCheck {
  const socials = meta?.socials ?? [];
  if (socials.length === 0) return { missing: [], linked: [] };

  // Canonicalize the page URLs once (dropping unparseable / empty entries).
  const pageKeys: UrlKey[] = [];
  for (const u of pageUrls) {
    const key = canonicalizeUrl(u);
    if (key) pageKeys.push(key);
  }

  const missing: SocialAccount[] = [];
  const linked: SocialAccount[] = [];
  for (const account of socials) {
    if (accountIsLinked(account, pageKeys)) linked.push(account);
    else missing.push(account);
  }
  return { missing, linked };
}
