// crawl/server-errors - report crawled pages whose final response is 5xx (#2036).
//
// The crawler retries a failing fetch before it gives up, so a page that errors once and then
// answers is stored as the healthy page it became and never reaches this rule (it is not
// reported as intermittent). A page that is still 5xx after those retries is stored as an error
// page, and each one becomes its own finding (pageUrl) with its status code (#2130).
//
// The clean result is a claim about every page of the site, so it is made only when the crawl
// reached every page it knew of. A crawl that stopped at its page cap or left URLs queued skips
// with the crawl-capped gap instead: a page it never fetched may still answer 5xx, and a pass
// there would mark a stored finding for that page fixed. A crawl that gave up on any page (a
// timeout, a refused connection, an undecodable body: `failedFetches`) skips with
// `pages-not-fetched` for the same reason: the page it failed to fetch is the one that may still
// answer 5xx. A targeted run never gets here (the runner skips site rules with `targeted-run`).

import {
  CRAWL_CAPPED_SKIP_REASON,
  PAGES_NOT_FETCHED_SKIP_REASON,
} from "@squirrelscan/core-contracts";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const serverErrorsRule: Rule = {
  meta: {
    id: "crawl/server-errors",
    name: "Server Errors",
    description:
      "Reports crawled pages whose final response is a 5xx server error",
    solution:
      "A page that answers 5xx is broken for visitors and for search engines, which drop it from the index if the error persists. Check the server or application logs for the failing URL, fix the underlying fault (an unhandled exception, an exhausted database or upstream, a bad deploy), then re-run the audit to confirm the page returns 200.",
    category: "crawl",
    scope: "site",
    findingScope: "page",
    severity: "error",
    weight: 8,
    checks: [
      { name: "server-errors", outcome: "problem" },
      { name: "server-errors", outcome: "clean", clears: ["server-errors"] },
      { name: "server-errors", outcome: "skipped" },
    ],
  },

  run(ctx: RuleContext): RuleResult {
    const pages = ctx.site?.pages;
    if (!pages || pages.length === 0) {
      return {
        checks: [
          {
            name: "server-errors",
            status: "skipped",
            message: "No pages crawled",
            skipReason: "No pages available",
          },
        ],
      };
    }

    const failing = new Map<string, number>();
    const healthy = new Set<string>();
    for (const page of pages) {
      if (page.redirectSource) continue;
      if (page.statusCode >= 500 && page.statusCode <= 599) {
        if (!failing.has(page.url)) failing.set(page.url, page.statusCode);
      } else {
        healthy.add(page.url);
      }
    }
    // A URL that answered both ways is failing, not healthy.
    for (const url of failing.keys()) healthy.delete(url);

    const checks: CheckResult[] = [];

    // One finding per failing page (#2130): each stores, carries and resolves on its own.
    for (const [url, statusCode] of failing) {
      checks.push({
        name: "server-errors",
        status: "fail",
        pageUrl: url,
        message: `${url} answers with a ${statusCode} server error`,
        items: [
          { id: url, label: `${url} (${statusCode})`, meta: { statusCode } },
        ],
        details: { statusCode },
      });
    }

    // A fetched page that is not 5xx is evaluated clean, so a prior finding on it resolves while
    // other pages still fail. A page not fetched this audit has no check and carries.
    for (const url of healthy) {
      checks.push({
        name: "server-errors",
        status: "pass",
        pageUrl: url,
        message: "The page did not answer with a 5xx status",
      });
    }

    // The site-level verdict is a claim about every page, so it is made only when the crawl
    // reached every page it knew of.
    const limits = ctx.site?.crawlLimits;
    const capped =
      limits !== undefined && limits.pagesCrawled >= limits.maxPages;
    const queued = ctx.site?.unfetchedPages ?? 0;
    const failed = ctx.site?.failedFetches ?? 0;
    if (capped || queued > 0) {
      checks.push({
        name: "server-errors",
        status: "skipped",
        message: capped
          ? `Not checked: the crawl stopped at its ${limits.maxPages}-page cap, so a page not crawled may still answer 5xx`
          : `Not checked: the crawl stopped with ${queued} URL(s) still queued, so a page not crawled may still answer 5xx`,
        skipReason: CRAWL_CAPPED_SKIP_REASON,
      });
    } else if (failed > 0) {
      checks.push({
        name: "server-errors",
        status: "skipped",
        message: `Not checked: the crawl could not fetch ${failed} page(s), and any of them may still answer 5xx`,
        skipReason: PAGES_NOT_FETCHED_SKIP_REASON,
      });
    } else if (failing.size === 0) {
      checks.push({
        name: "server-errors",
        status: "pass",
        message: "No crawled page answered with a 5xx status",
      });
    }
    return { checks };
  },
};
