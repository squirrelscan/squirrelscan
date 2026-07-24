// Shared privacy-policy page detection used by both eeat/privacy-policy and
// legal/privacy-policy so the two categories credit the same pages (issue #1098:
// a /privacy page titled "Privacy Policy" was warned by eeat while it clearly
// existed). Slug matching alone is brittle — redirects, unusual slugs and
// localized paths slip past it — so title/h1 acts as a slug-independent fallback.

import { EEAT_PAGE_PATTERNS } from "@squirrelscan/utils/constants";
import { getPathname, resolveUrl } from "@squirrelscan/utils";

import type { ParsedPage } from "../types";

// Known privacy-page slugs (bare /privacy, /privacy-policy, /legal/privacy plus
// localized variants). Single source of truth for both rules.
export const PRIVACY_PATH_PATTERNS = EEAT_PAGE_PATTERNS.privacy;

// A title/h1 segment that IS a privacy policy heading: after splitting on
// separators ("Privacy Policy — Site", "Site | Privacy Policy") a segment is the
// exact phrase "privacy policy"/"privacy notice" OPTIONALLY followed by a
// bounded qualifier — a parenthesized fragment "(Updated July 2026)", a
// recognized keyword (updated|last updated|effective|revised|rev.) + rest, or a
// bare year. An ARBITRARY continuation is still rejected ("Privacy Policy
// Changes in 2026"), so real policy pages with dated headings are credited while
// blog posts that merely lead with the phrase are not.
const PRIVACY_HEADING_RE =
  /^privacy\s*(?:policy|notice)(?:\s*\([^)]*\)|\s+(?:updated|last\s+updated|effective|revised|rev\.)(?=\s|$).*|\s+\d{4}(?:-\d{2}(?:-\d{2})?)?\s*$)?$/i;
const TITLE_SEPARATORS = /[|–—\-:·•]+/;

function isPrivacyHeading(text: string): boolean {
  return text.split(TITLE_SEPARATORS).some((seg) => PRIVACY_HEADING_RE.test(seg.trim()));
}

// Anchor-text tokens that identify a link as pointing at a privacy policy.
const PRIVACY_LINK_TEXT = ["privacy", "datenschutz", "privacidad"];

// Minimal page shape the helpers read — matches both SiteData.pages entries and
// ad-hoc test fixtures.
export interface PrivacyCandidatePage {
  url: string;
  parsed: ParsedPage;
}

// Decode percent-encoding and strip diacritics so accented localized slugs
// (e.g. `/politique-de-confidentialité`) match their unaccented patterns.
function normalizePath(path: string): string {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // Malformed percent-encoding — fall back to the raw path.
  }
  return decoded.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// True when a path/URL matches a known privacy slug (any language).
export function isPrivacyPath(pathOrUrl: string): boolean {
  const path = normalizePath(getPathname(pathOrUrl) || pathOrUrl);
  return PRIVACY_PATH_PATTERNS.some((p) => p.test(path));
}

// A crawled page counts as the privacy policy when its slug matches OR its
// <title>/<h1> reads "privacy policy" — the slug-independent fallback.
export function isPrivacyPage(page: PrivacyCandidatePage): boolean {
  if (isPrivacyPath(page.url)) return true;
  const title = page.parsed?.meta?.title ?? "";
  if (isPrivacyHeading(title)) return true;
  const h1s = page.parsed?.h1?.texts ?? [];
  return h1s.some((t) => isPrivacyHeading(t));
}

// URL of the first crawled page that is the privacy policy, or null.
export function findPrivacyPage(pages: PrivacyCandidatePage[]): string | null {
  for (const page of pages) {
    if (isPrivacyPage(page)) return page.url;
  }
  return null;
}

// Does any link on this page resolve to a privacy slug? This is the strict
// href-only signal (no anchor text) — matches eeat's original link-percentage
// metric so adopting the shared helper doesn't widen what eeat counts.
export function pageLinksToPrivacyHref(page: PrivacyCandidatePage): boolean {
  const links = page.parsed?.links ?? [];
  return links.some((l) => {
    const resolved = resolveUrl(l.url, page.url);
    return resolved ? isPrivacyPath(resolved) : false;
  });
}

// Resolved href of the link that points at a privacy policy, or null. Two
// passes: a real href-slug match ANYWHERE on the page wins over a weak
// text-only match, so a cookie-consent "Manage Privacy Preferences" link earlier
// in the DOM never beats the actual /privacy link later. Anchor-text matching is
// the legal rule's historical behavior; kept here, not in eeat's href metric.
export function privacyLinkHref(page: PrivacyCandidatePage): string | null {
  const links = page.parsed?.links ?? [];
  for (const l of links) {
    const resolved = resolveUrl(l.url, page.url);
    if (resolved && isPrivacyPath(resolved)) return resolved;
  }
  for (const l of links) {
    const text = (l.text || "").toLowerCase();
    if (PRIVACY_LINK_TEXT.some((t) => text.includes(t))) {
      return resolveUrl(l.url, page.url) ?? l.url;
    }
  }
  return null;
}
