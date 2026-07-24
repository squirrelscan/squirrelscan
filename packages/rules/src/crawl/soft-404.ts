// crawl/soft-404 - flag pages that serve 404/error content with a 2xx status.
//
// The `isSoft404` signal is computed by the runner (see `detectSoft404` in
// @squirrelscan/parser) from the page status code plus parsed content. This rule
// surfaces it as a finding: search engines treat soft-404s specially (they waste
// crawl budget and can be indexed as thin/duplicate content), and the same
// signal gates content/legal rules so they don't misfire on a broken template.
//
// Confirm-before-warn (#1177): some sites intermittently serve the error shell
// (HTTP 200 + noindex) for real pages via transient ISR/CDN behaviour. So the
// audit-engine re-fetches each flagged page once (end-of-crawl) and records a
// `soft404Confirmation` verdict, which selects the finding variant below:
//   - `confirmed`    → the standard soft-404 warn.
//   - `intermittent` → a DISTINCT finding (real content on re-fetch; the owner's
//                      browser may show the page but crawlers can hit the shell).
//   - `unconfirmed` / absent → warn, annotated as a single-observation result so
//                      the owner isn't confused when their browser shows content.

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

// The signal reads the server's raw HTML response, which can differ from what a
// browser renders — surfaced in every variant so an owner seeing live content
// understands the finding rather than dismissing it as a false positive.
const SERVER_HTML_CAVEAT =
  "This check reads the server's HTML response and can differ from what a browser shows.";

export const soft404Rule: Rule = {
  meta: {
    id: "crawl/soft-404",
    name: "Soft 404",
    description: "Detects pages that serve 404/error content with an HTTP 200 status",
    solution:
      "A soft 404 is a page that shows 'not found' / error content but returns a success (2xx) status instead of a real 404 or 410. Search engines waste crawl budget on these and may index them as thin or duplicate content. Return a proper 404 (or 410 for permanently removed URLs) for missing pages, or restore the real content if the URL should resolve. If the URL is valid, remove the error-shell markup and the 'page not found' title/heading.",
    category: "crawl",
    scope: "page",
    severity: "warning",
    weight: 5,
    // MUST NOT set skipOnSoft404 — this rule exists to report soft-404 pages.
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];

    if (!ctx.parsed.isSoft404) {
      checks.push({
        name: "soft-404",
        status: "pass",
        message: "Page does not serve 404 content with a success status",
      });
      return { checks };
    }

    const signals = ctx.parsed.soft404Signals ?? [];
    // Verdict from the end-of-crawl confirmation re-fetch; absent (runner-only
    // paths / no confirm pass) is treated as `unconfirmed` — warn, never drop.
    const confirmation = ctx.parsed.soft404Confirmation ?? "unconfirmed";

    const message =
      confirmation === "intermittent"
        ? "Page intermittently serves 404 error content with HTTP 200"
        : confirmation === "unconfirmed-rendered"
          ? "Page serves 404 content with HTTP 200 (based on the rendered crawl observation; cannot verify without JS rendering)"
          : confirmation === "unconfirmed"
            ? "Page serves 404 content with HTTP 200 (based on a single crawl observation)"
            : "Page serves 404 content with HTTP 200";

    checks.push({
      name: "soft-404",
      status: "warn",
      message: `${message}. ${SERVER_HTML_CAVEAT}`,
      value: `HTTP ${ctx.page.statusCode}`,
      details: {
        confirmation,
        signals: signals.map((s) => s.detail),
      },
      items: signals.map((s) => ({
        id: s.name,
        label: s.detail,
      })),
    });

    return { checks };
  },
};
