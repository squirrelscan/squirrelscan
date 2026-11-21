// The pages a response-header rule (security/csp, security/hsts, security/x-frame-options) reads its header from.

import type { CheckResult, RuleContext } from "../types";

type SitePage = NonNullable<RuleContext["site"]>["pages"][number];

/**
 * The pages to judge. A full audit reads the header off the first page, the entry page, and speaks for the
 * site. A targeted run (#1778) fetched only the URLs it was given, so the first of them is not the entry page
 * and stands for nothing but itself: every listed page that answered (status under 400) is judged on its own.
 */
export function headerPages(ctx: RuleContext): SitePage[] {
  const pages = ctx.site?.pages ?? [];
  if (ctx.site?.targetedRun !== true) return pages.slice(0, 1);
  return pages.filter((p) => p.statusCode > 0 && p.statusCode < 400);
}

/**
 * The checks of every judged page as one list. A full audit's single page is returned unchanged. On a targeted
 * run each check names its page, and checks that say the same thing on several pages are folded into one row
 * that lists them all in `pages`, so a list of 50 pages with the same header reads as one finding.
 */
export function judgeHeaderPages(
  ctx: RuleContext,
  pages: readonly SitePage[],
  judge: (page: SitePage) => CheckResult[],
): CheckResult[] {
  if (ctx.site?.targetedRun !== true) return pages.flatMap((p) => judge(p));
  const rows = new Map<string, { check: CheckResult; pages: string[] }>();
  for (const page of pages) {
    for (const check of judge(page)) {
      const key = sameFinding(check);
      const row = rows.get(key);
      if (row) {
        if (!row.pages.includes(page.url)) row.pages.push(page.url);
      } else {
        rows.set(key, { check, pages: [page.url] });
      }
    }
  }
  return [...rows.values()].map(({ check, pages: urls }) => {
    const { pageUrl: _pageUrl, pages: _pages, ...rest } = check;
    if (urls.length === 1) return { ...rest, pageUrl: urls[0], pages: urls };
    // `details.pageUrl` names one page; a row for several names them in `pages` instead.
    const details = rest.details ? withoutPageUrl(rest.details) : undefined;
    return { ...rest, ...(details ? { details } : {}), pages: urls };
  });
}

/** What makes two pages' checks one finding: everything but the page they were read from. */
function sameFinding(check: CheckResult): string {
  const { pageUrl: _pageUrl, pages: _pages, details, ...rest } = check;
  return JSON.stringify([rest, details ? withoutPageUrl(details) : null]);
}

function withoutPageUrl(details: Record<string, unknown>): Record<string, unknown> {
  const { pageUrl: _pageUrl, ...rest } = details;
  return rest;
}
