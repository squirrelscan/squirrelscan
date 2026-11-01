// security/csp-violations - what the browser itself blocked while rendering the page (#425).
//
// A Content-Security-Policy that leaves out a host the site depends on breaks a widget or a tracker without
// any sign in the HTML or the response: the page returns 200 and looks normal. The static companion
// (security/csp-blocks-own-resources) predicts it from the policy and the markup; this rule reports the
// browser's own verdict, from the `securitypolicyviolation` events a rendered crawl collected.
//
// It needs a browser render. A page fetched over plain HTTP, or a render whose service did not report browser
// events, is skipped with its reason, never passed. A report-only policy raises events too, but blocks nothing,
// so those are left out of the finding.

import type { CheckItem } from "@squirrelscan/core-contracts";

import { hostCategory, type VendorCategory } from "./csp-vendors";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

const MAX_ITEMS = 25;
/** Schemes of browser extensions: their injected scripts are blocked by the page's CSP, but nothing on the site can fix that. */
const EXTENSION_PROTOCOLS = new Set(["chrome-extension:", "moz-extension:", "safari-extension:", "safari-web-extension:", "ms-browser-extension:"]);
const SAMPLE_URLS = 5;

const CATEGORY_LABEL: Record<VendorCategory, string> = {
  analytics: "analytics",
  ads: "ads",
  payments: "payments",
  captcha: "captcha",
  form: "form",
  booking: "booking",
};

interface Blocked {
  directive: string;
  host: string;
  category?: VendorCategory;
  urls: string[];
  count: number;
  sourceFile?: string;
}

/** The host of a blocked URI, or a keyword for one that is not a URL (`inline`, `eval`, `data:`). */
function blockedHost(blockedUri: string): string {
  try {
    const url = new URL(blockedUri);
    if (url.hostname) return url.hostname.toLowerCase();
    return `(${url.protocol.replace(":", "")})`;
  } catch {
    return `(${blockedUri})`;
  }
}

function isExtensionUri(uri: string | undefined): boolean {
  if (!uri) return false;
  try {
    return EXTENSION_PROTOCOLS.has(new URL(uri).protocol);
  } catch {
    return false;
  }
}

export const cspViolationsRule: Rule = {
  meta: {
    id: "security/csp-violations",
    name: "CSP violations seen by the browser",
    description:
      "Reports the Content-Security-Policy violations the browser raised while rendering the page: scripts, frames, styles, images and endpoints it blocked",
    solution:
      "Each finding names a directive the browser enforced and a host it blocked. Add the host to that directive (scripts to script-src or script-src-elem, beacons and API calls to connect-src, embeds to frame-src, images to img-src), reload the page with the browser console open and confirm no violation remains. A blocked analytics, ads, payments, captcha, form or booking endpoint fails the check because the feature silently stops working; any other blocked host warns. Inline script and eval blocks need a nonce or hash, or the code moved to a file.",
    category: "security",
    scope: "page",
    // Reads the render's own events, which differ per page inside one template.
    verdictScope: "page",
    severity: "warning",
    weight: 6,
  },

  run(ctx: RuleContext): RuleResult {
    if (ctx.page.rendered !== true) {
      return {
        checks: [
          {
            name: "csp-violations",
            status: "skipped",
            message: "Not checked: the browser only reports CSP violations on a rendered crawl (this page was fetched without a browser)",
            skipReason: "not-rendered",
          },
        ],
      };
    }
    const events = ctx.page.browserEvents;
    if (!events) {
      return {
        checks: [
          {
            name: "csp-violations",
            status: "skipped",
            message: "Not checked: the render service did not report the browser's events for this page",
            skipReason: "no-browser-events",
          },
        ],
      };
    }

    const blocked = new Map<string, Blocked>();
    let reportOnly = 0;
    let extensions = 0;
    for (const violation of events.cspViolations) {
      if (violation.disposition === "report") {
        reportOnly++;
        continue;
      }
      // A browser extension's own script is not the site's to allow.
      if (isExtensionUri(violation.blockedUri) || isExtensionUri(violation.sourceFile)) {
        extensions++;
        continue;
      }
      const host = blockedHost(violation.blockedUri);
      const key = `${violation.violatedDirective}\u0000${host}`;
      const seen = blocked.get(key);
      if (seen) {
        seen.count++;
        if (seen.urls.length < SAMPLE_URLS && !seen.urls.includes(violation.blockedUri)) seen.urls.push(violation.blockedUri);
        continue;
      }
      blocked.set(key, {
        directive: violation.violatedDirective,
        host,
        category: host.startsWith("(") ? undefined : hostCategory(host),
        urls: [violation.blockedUri],
        count: 1,
        sourceFile: violation.sourceFile,
      });
    }

    const dropped = events.droppedViolations ?? 0;
    const details = {
      violations: events.cspViolations.length,
      failedRequests: events.failedRequests.length,
      listenedAfterLoad: events.listenedAfterLoad === true,
      ...(reportOnly > 0 ? { reportOnly } : {}),
      ...(extensions > 0 ? { extensionViolations: extensions } : {}),
      ...(dropped > 0 ? { droppedViolations: dropped } : {}),
    };
    const droppedNote = dropped > 0 ? ` (${dropped} more not recorded)` : "";

    if (blocked.size === 0 && reportOnly > 0) {
      return {
        checks: [
          {
            name: "csp-violations",
            status: "info",
            message: `Only a report-only policy raised violations (${reportOnly}); nothing was blocked, but enforcing that policy would block them${droppedNote}`,
            details,
          },
        ],
      };
    }

    if (blocked.size === 0) {
      return {
        checks: [
          {
            name: "csp-violations",
            status: "pass",
            message:
              events.listenedAfterLoad === true
                ? `The browser reported no enforced CSP violation from the site while rendering the page${droppedNote}`
                : `The browser reported no enforced CSP violation from the site up to the page's load (it was not watched after load, so a late embed or hit could be missed)${droppedNote}`,
            details,
          },
        ],
      };
    }

    const all = [...blocked.values()];
    const known = all.filter((b) => b.category !== undefined);
    const hostCount = all.filter((b) => !b.host.startsWith("(")).length;
    const keywordCount = all.length - hostCount;
    const what = [
      hostCount > 0 ? `${hostCount} host${hostCount === 1 ? "" : "s"}` : "",
      keywordCount > 0 ? `${keywordCount} inline, eval or data source${keywordCount === 1 ? "" : "s"}` : "",
    ]
      .filter(Boolean)
      .join(" and ");
    const summary = [...new Set(all.map((b) => b.directive))]
      .map((directive) => {
        const hosts = all.filter((b) => b.directive === directive).map((b) => b.host);
        return `${directive}: ${hosts.slice(0, 5).join(", ")}${hosts.length > 5 ? ` and ${hosts.length - 5} more` : ""}`;
      })
      .join("; ");
    const items: CheckItem[] = all.slice(0, MAX_ITEMS).map((b) => ({
      id: `${b.directive} ${b.host}`,
      label: `${b.directive}: ${b.host.startsWith("(") ? `blocked ${b.host.slice(1, -1)} code` : `add ${b.host}`}${b.category ? ` (${CATEGORY_LABEL[b.category]})` : ""}`,
      snippet: b.urls.join(", ").slice(0, 400),
      meta: {
        directive: b.directive,
        host: b.host,
        blocked: b.count,
        ...(b.category ? { category: b.category } : {}),
        ...(b.sourceFile ? { sourceFile: b.sourceFile } : {}),
      },
    }));
    const check: CheckResult = {
      name: "csp-violations",
      status: known.length > 0 ? "fail" : "warn",
      message: `The browser blocked ${what} under the page's CSP${known.length > 0 ? `, including ${known.length} from a known ${[...new Set(known.map((b) => CATEGORY_LABEL[b.category!]))].join("/")} vendor` : ""} (${summary})${droppedNote}`,
      items,
      details: { ...details, ...(all.length > MAX_ITEMS ? { additional: all.length - MAX_ITEMS } : {}) },
    };
    return { checks: [check] };
  },
};
