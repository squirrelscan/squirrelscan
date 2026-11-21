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
//
// "No failure recorded" is not "the home page loaded": a partial re-audit or stored data
// without crawl stats never fetched it this time. The rule passes only when a page record
// for the entry URL (or where it redirected) loaded with a non-error status; with neither a
// load nor a known outage, or an outage of unknown kind, it skips with `entry-not-fetched`,
// a gap that never resolves a stored finding.

import type { AuditFailureReasonCode } from "@squirrelscan/core-contracts";

import { ENTRY_NOT_FETCHED_SKIP_REASON } from "@squirrelscan/core-contracts/resolution";
import { normalizeUrl } from "@squirrelscan/utils";

import type { Rule, RuleContext, RuleResult } from "../types";

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
    description:
      "Reports when the home page (the audited URL) fails to load: DNS, connection, TLS, timeout or a 5xx",
    solution:
      "Visitors, search engines and AI agents all fail at the same point: the home page does not load. Check the cause named in the finding. For DNS, confirm the domain's records and nameservers. For TLS, check the certificate (expiry, chain, hostname). For a connection or timeout failure, check the server, firewall and CDN origin. For a 5xx, read the origin's error logs. Then run the audit again.",
    category: "crawl",
    scope: "site",
    findingScope: "page",
    severity: "error",
    weight: 10,
    checks: [
      { name: "home-page-unreachable", outcome: "problem" },
      {
        name: "home-page-unreachable",
        outcome: "clean",
        clears: ["home-page-unreachable"],
      },
      { name: "home-page-unreachable", outcome: "skipped" },
    ],
  },

  run(ctx: RuleContext): RuleResult {
    const site = ctx.site;
    if (!site) return NOT_APPLICABLE;
    const entryUrl = site.entryUrls?.[0] ?? site.baseUrl;
    const failure = site.entryFailure;
    if (failure && (failure.source ?? "entry") !== "entry")
      return NOT_APPLICABLE;

    if (failure && failure.code !== "unknown") {
      const cause = REPORTED[failure.code];
      // A 4xx, a robots.txt refusal or a redirect is an answer, handled elsewhere.
      if (!cause) return NOT_APPLICABLE;
      const host = failure.host ?? site.baseUrl;
      const status =
        failure.code === "http_5xx" && failure.status
          ? ` (${failure.status})`
          : "";
      return {
        checks: [
          {
            name: "home-page-unreachable",
            status: "fail",
            message: `The home page of ${host} failed to load: ${cause}${status}`,
            pageUrl: entryUrl,
            details: {
              reason: failure.code,
              ...(failure.status ? { status: failure.status } : {}),
              ...(failure.detail ? { detail: failure.detail } : {}),
            },
          },
        ],
      };
    }

    // Clean only on evidence: this audit holds a page record for the entry URL (the URL it
    // was given, where that redirected, or the base URL) that loaded with a non-error status.
    if (!failure && entryPageLoaded(site)) {
      return {
        checks: [
          {
            name: "home-page-unreachable",
            status: "pass",
            message: "The home page loaded",
            pageUrl: entryUrl,
          },
        ],
      };
    }
    return {
      checks: [
        {
          name: "home-page-unreachable",
          status: "skipped",
          skipReason: ENTRY_NOT_FETCHED_SKIP_REASON,
          message: failure
            ? "Not checked: the home page failed to load for a reason squirrel could not classify"
            : "Not checked: this audit did not fetch the home page",
          pageUrl: entryUrl,
        },
      ],
    };
  },
};

/** A page record for the entry URL, its redirect target or the base URL, that loaded (2xx or 3xx). */
function entryPageLoaded(site: NonNullable<RuleContext["site"]>): boolean {
  const entries = new Set(
    [...(site.entryUrls ?? []), site.baseUrl].map((url) => normalizeUrl(url))
  );
  return site.pages.some(
    (page) =>
      !page.redirectSource &&
      page.statusCode >= 200 &&
      page.statusCode < 400 &&
      (entries.has(normalizeUrl(page.url)) ||
        (!!page.finalUrl && entries.has(normalizeUrl(page.finalUrl))))
  );
}
