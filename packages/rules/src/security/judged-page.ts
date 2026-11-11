// The page the site-scope header rules (security/csp, hsts, x-frame-options) read their headers from (#1778).
//
// `ctx.site.pages` is ordered by URL and holds every entry the crawl kept: a URL that redirected (#1762) with the
// headers of its 3xx answer, error pages and files. Reading the first entry blindly judged a listed `/about` that
// redirects to `/about/` by the redirect's headers, and a 404 by a 404's. The judged page is the first real page:
// not a redirect entry, answered 2xx, and HTML (or of unknown type). With none, the first entry, as before.

type JudgeablePage = {
  url: string;
  statusCode: number;
  redirectSource?: boolean;
  headers?: Record<string, string>;
};

export function judgedPage<T extends JudgeablePage>(pages: readonly T[] | undefined): T | undefined {
  if (!pages || pages.length === 0) return undefined;
  const real = pages.find((p) => {
    if (p.redirectSource === true) return false;
    if (p.statusCode < 200 || p.statusCode >= 300) return false;
    const type = p.headers?.["content-type"];
    return type === undefined || /html|xml/i.test(type);
  });
  return real ?? pages[0];
}

/**
 * `details.pageUrl` on a finding, so it says which page the header was read from (#1735, #1778). Only the
 * details, never `pages`: `pages` makes a finding page-addressable and changes its identity in a comparison, and
 * hsts and x-frame-options findings have always been whole-site ones.
 */
export function namingPage<C extends { status: string; details?: Record<string, unknown> }>(
  checks: C[],
  url: string
): C[] {
  return checks.map((c) =>
    c.status === "warn" || c.status === "fail"
      ? { ...c, details: { pageUrl: url, ...c.details } }
      : c
  );
}
