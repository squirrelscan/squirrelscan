// core/canonical - Validates canonical URL presence and format

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { documentUrl } from "../shared/redirect-evidence";
import { parseLinkHeaderCanonical } from "./canonical-header";

/** The host without a leading `www.`, lower-cased: `www.example.com` and `example.com` are one site here. */
function hostFamily(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

/**
 * Ordinary second addresses of a home page: `/home`, `/home/`, `/index`, `/home.<ext>` (a CMS Home slug or a
 * router alias), and the directory index files `/index|default.(htm|html|php|asp|aspx)`. Case-insensitive.
 * `/homepage-design` and `/home/pricing` are not home pages.
 */
const HOME_FILE = /^\/(?:(?:index|default)\.(?:html?|php|aspx?)|home\/?|index|home\.[a-z0-9]{1,5})$/i;

/** A path the site serves its home page at: the root, or one of the home spellings above. */
function isRootPath(pathname: string): boolean {
  return pathname === "/" || HOME_FILE.test(pathname);
}

/** `/en/`, `/de`, `/pt-br/`: one locale segment, the usual shape of a localized home page. */
const LOCALE_HOME = /^\/[a-z]{2}(?:[-_][a-z0-9]{2,8})?\/?$/i;

/**
 * Whether `canonical` makes `pageUrl` claim it is a duplicate of the home page (#1685): a template that
 * hard-codes the canonical to the site root drops every page it renders from the index.
 *
 * - `error`: a page that is not the home page canonicals to the site root.
 * - `locale-home`: a locale home page (`/en/`) canonicals to `/`, which can be deliberate, so it is a warning.
 * - `none`: everything else. The home page itself, a canonical to any other URL, a canonical to another
 *   site's root, a root with a query string (`/?page_id=5` is a real WordPress page) and a page that
 *   redirected to the home page (the caller passes the URL the page ended on).
 *
 * Root variants are one thing: a trailing slash, `/index.html`, and the `www` and bare form of the host.
 */
export function homepageCanonicalVerdict(
  pageUrl: string,
  canonical: string,
): "error" | "locale-home" | "none" {
  let page: URL;
  let target: URL;
  try {
    page = new URL(pageUrl);
    target = new URL(canonical, page);
  } catch {
    return "none";
  }
  if (!/^https?:$/.test(target.protocol) || !/^https?:$/.test(page.protocol)) return "none";
  // Another site's home page is not this site's root.
  if (hostFamily(target.host) !== hostFamily(page.host)) return "none";
  if (!isRootPath(target.pathname) || target.search !== "") return "none";
  // The home page, however it is spelled, may name itself.
  if (isRootPath(page.pathname)) return "none";
  return LOCALE_HOME.test(page.pathname) ? "locale-home" : "error";
}

export const canonicalRule: Rule = {
  meta: {
    id: "core/canonical",
    name: "Canonical URL",
    description: "Validates canonical URL presence and format",
    solution:
      'Canonical URLs tell search engines which version of a page is the "master" copy, preventing duplicate content issues. Every page should specify a canonical URL, typically pointing to itself. Add a <link rel="canonical" href="..."> tag in the head section. Use absolute URLs and ensure consistency (with or without trailing slash, www vs non-www). For paginated content, point to the main page or use rel="prev/next".',
    category: "core",
    scope: "page",
    verdictScope: "page",
    // "error" because this rule emits `fail` (relative or invalid canonical, canonical to the home page):
    // the effective severity of a failing rule is its declared one (#1746). Missing and locale-home are `warn`.
    severity: "error",
    weight: 6,
  },

  run(ctx: RuleContext): RuleResult {
    const { checks } = canonicalChecks(ctx);
    // The page URL a redirect ended on: a page that redirects to the home page is the home page.
    const pageUrl = documentUrl(ctx.page);
    const sources: Array<{ source: "tag" | "header"; value: string | null | undefined }> = [
      { source: "tag", value: ctx.parsed.meta.canonical?.trim() },
      { source: "header", value: parseLinkHeaderCanonical(ctx.page.headers?.["link"]) },
    ];
    for (const { source, value } of sources) {
      if (!value) continue;
      const verdict = homepageCanonicalVerdict(pageUrl, value);
      if (verdict === "none") continue;
      checks.push({
        name: "canonical-to-homepage",
        status: verdict === "error" ? "fail" : "warn",
        message:
          verdict === "error"
            ? `${pageUrl} declares the homepage as its canonical (${value}): search engines read the page as a duplicate of the home page and may drop it from the index`
            : `${pageUrl} is a locale home page whose canonical is the site root (${value}): fine if the root is the one version you want indexed, otherwise point it at itself`,
        value,
        expected: "The page's own URL",
        details: { pageUrl, canonical: value, source },
      });
      break;
    }
    return { checks };
  },
};

function canonicalChecks(ctx: RuleContext): RuleResult {
  const { canonical } = ctx.parsed.meta;
  const checks: CheckResult[] = [];

  if (!canonical) {
    checks.push({
      name: "canonical",
      status: "warn",
      message: "Missing canonical URL",
      value: null,
    });
    return { checks };
  }

  if (!canonical.startsWith("http")) {
    checks.push({
      name: "canonical",
      status: "fail",
      message: "Canonical URL should be absolute",
      value: canonical,
      expected: "Absolute URL starting with https://",
    });
    return { checks };
  }

  // Check if canonical matches current URL (self-referential)
  try {
    const canonicalUrl = new URL(canonical);
    // The URL the page ended on: a redirect target's canonical names itself.
    const pageUrl = new URL(documentUrl(ctx.page));

    if (canonicalUrl.href !== pageUrl.href) {
      checks.push({
        name: "canonical",
        status: "info",
        message: "Canonical points to different URL",
        value: canonical,
      });
    } else {
      checks.push({
        name: "canonical",
        status: "pass",
        message: "Self-referential canonical present",
        value: canonical,
      });
    }
  } catch {
    checks.push({
      name: "canonical",
      status: "fail",
      message: "Invalid canonical URL format",
      value: canonical,
    });
  }

  return { checks };
}
