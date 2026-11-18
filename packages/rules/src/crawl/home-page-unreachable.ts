// crawl/home-page-unreachable - the audited entry URL (the home page) failed to load.
//
// A run that cannot fetch the site used to end as a failed run with a status reason and
// nothing in the findings, so anything that works from findings (alerts, diffs, the
// issue list) never saw "the site is down". The crawler records why the entry URL failed
// (`CrawlStats.rootFailure`, #1822); this rule turns that record into one finding.
//
// It reports only failures that mean the site did not answer: DNS, TLS, connection,
// timeout and a 5xx. A 4xx, a robots.txt refusal or a bot wall is an answer (often a
// policy), handled by the blocked and refused paths, so it is not reported here. A
// failure recorded for a sitemap fetch, not the entry URL, is also left alone.

import type { AuditFailureReasonCode } from "@squirrelscan/core-contracts";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

const NOT_APPLICABLE: RuleResult = { checks: [] };

const REPORTED: Partial<Record<AuditFailureReasonCode, string>> = {
  dns: "its domain name did not resolve (DNS)",
  tls: "the TLS connection failed",
  connection: "the connection was refused or dropped",
  timeout: "the server did not answer in time",
  http_5xx: "the server answered with a 5xx error",
};

export const homePageUnreachableRule: Rule = {
  meta: {
    id: "crawl/home-page-unreachable",
    name: "Home Page Unreachable",
    description: "Reports when the home page (the audited URL) fails to load: DNS, connection, TLS, timeout or a 5xx",
    solution:
      "Visitors, search engines and AI agents all fail at the same point: the home page does not load. Check the cause named in the finding. For DNS, confirm the domain's records and nameservers. For TLS, check the certificate (expiry, chain, hostname). For a connection or timeout failure, check the server, firewall and CDN origin. For a 5xx, read the origin's error logs. Then run the audit again.",
    category: "crawl",
    scope: "site",
    severity: "error",
    weight: 10,
    checks: [
      { name: "home-page-unreachable", outcome: "problem" },
      { name: "home-page-unreachable", outcome: "clean", clears: ["home-page-unreachable"] },
    ],
  },

  run(ctx: RuleContext): RuleResult {
    const failure = ctx.site?.entryFailure;
    if (!failure) {
      // The entry URL loaded: clean, so a stored finding from an earlier audit resolves.
      if (!ctx.site) return NOT_APPLICABLE;
      return {
        checks: [
          {
            name: "home-page-unreachable",
            status: "pass",
            message: "The home page loaded",
            pageUrl: ctx.site.entryUrls?.[0] ?? ctx.site.baseUrl,
          },
        ],
      };
    }
    if ((failure.source ?? "entry") !== "entry") return NOT_APPLICABLE;
    const cause = REPORTED[failure.code];
    if (!cause) return NOT_APPLICABLE;

    const host = failure.host ?? ctx.site?.baseUrl ?? "the site";
    const status = failure.code === "http_5xx" && failure.status ? ` (${failure.status})` : "";
    const check: CheckResult = {
      name: "home-page-unreachable",
      status: "fail",
      message: `The home page of ${host} failed to load: ${cause}${status}`,
      pageUrl: ctx.site?.entryUrls?.[0] ?? ctx.site?.baseUrl,
      details: {
        reason: failure.code,
        ...(failure.status ? { status: failure.status } : {}),
        ...(failure.detail ? { detail: failure.detail } : {}),
      },
    };
    return { checks: [check] };
  },
};
