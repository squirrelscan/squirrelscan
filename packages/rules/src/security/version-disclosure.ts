// security/version-disclosure - response headers that name a software version

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

// Headers that name the server or framework, and so tell a scanner which
// known vulnerabilities to try. Lowercase keys match the page header map.
const WATCHED: ReadonlyArray<{ key: string; label: string }> = [
  { key: "server", label: "Server" },
  { key: "x-powered-by", label: "X-Powered-By" },
  { key: "x-aspnet-version", label: "X-AspNet-Version" },
  { key: "x-aspnetmvc-version", label: "X-AspNetMvc-Version" },
  { key: "x-generator", label: "X-Generator" },
];

// A dotted version (at least major.minor) that stands alone or follows a product
// name and a separator, e.g. `nginx/1.18.0`, `PHP/8.1.2`, `4.0.30319`. A bare
// product name (`nginx`, `cloudflare`) and a single number (`Drupal 9`) do not match.
const VERSION = /(?:^|[\s/(,;])v?\d+(?:\.\d+)+(?!\w)/;

/**
 * Longest header value quoted in a message. The site sets the header, so it can
 * run to kilobytes; the full value stays in `value` for machine readers.
 */
const MAX_QUOTED_VALUE = 120;

/** Headers only recorded since #713: Server was always recorded. */
const RECENT_LABELS = WATCHED.filter((w) => w.key !== "server").map((w) => w.label);

interface Finding {
  label: string;
  value: string;
  /** Pages the value was seen on, in first-seen order; a Set, so a site-wide
   * header costs one insert per page rather than a scan of every page so far. */
  pages: Set<string>;
}

function quote(value: string): string {
  return value.length > MAX_QUOTED_VALUE ? `${value.slice(0, MAX_QUOTED_VALUE)}...` : value;
}

export const versionDisclosureRule: Rule = {
  meta: {
    id: "security/version-disclosure",
    name: "Version-Revealing Headers",
    description:
      "Checks Server, X-Powered-By, X-AspNet-Version, X-AspNetMvc-Version and X-Generator for software version numbers",
    solution:
      'Remove the version from these headers. Nginx: server_tokens off; Apache: ServerTokens Prod and ServerSignature Off; PHP: expose_php = Off in php.ini; ASP.NET: drop X-AspNet-Version and X-AspNetMvc-Version (httpRuntime enableVersionHeader="false", MvcHandler.DisableMvcResponseHeader = true); remove X-Powered-By and X-Generator at the framework or proxy. Product names without a version are harmless.',
    category: "security",
    scope: "site",
    severity: "warning",
    weight: 3,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const pages = ctx.site?.pages ?? [];

    if (pages.length === 0) {
      checks.push({
        name: "version-disclosure",
        status: "skipped",
        message: "No pages to check",
        skipReason: "No pages crawled",
      });
      return { checks };
    }

    // One finding per header value across the site, carrying every page it was seen on.
    const findings = new Map<string, Finding>();
    for (const page of pages) {
      const headers = page.headers ?? {};
      for (const { key, label } of WATCHED) {
        const value = headers[key]?.trim();
        if (!value || !VERSION.test(value)) continue;
        const id = `${key}\n${value}`;
        let finding = findings.get(id);
        if (!finding) {
          finding = { label, value, pages: new Set() };
          findings.set(id, finding);
        }
        finding.pages.add(page.url);
      }
    }

    for (const { label, value, pages: seenOn } of findings.values()) {
      checks.push({
        name: "version-disclosure",
        status: "warn",
        message: `${label} header reveals a software version: ${quote(value)}`,
        value,
        items: [
          {
            id: `${label}: ${value}`,
            label: `${label}: ${quote(value)}`,
            sourcePages: [...seenOn],
          },
        ],
        details: { header: label, pageCount: seenOn.size },
      });
    }

    // A crawl stored before these headers were recorded cannot say they were
    // not sent: only Server was checked on it.
    const recentRecorded = pages.some((page) => page.versionHeadersRecorded === true);
    if (!recentRecorded) {
      checks.push({
        name: "version-disclosure-unrecorded",
        status: "skipped",
        message: `${RECENT_LABELS.join(", ")} were not checked: this crawl's page records predate them. Re-run the audit with --refresh to check them`,
        skipReason: "Page records predate the version headers",
      });
    } else if (findings.size === 0) {
      checks.push({
        name: "version-disclosure",
        status: "pass",
        message:
          "No software version in Server, X-Powered-By, X-AspNet-Version, X-AspNetMvc-Version or X-Generator",
      });
    }

    return { checks };
  },
};
