// reliability/js-errors - JavaScript errors and failed runtime requests on rendered pages (#704)
//
// Reads what the cloud render recorded while each page ran (uncaught exceptions,
// console.error, requests that failed after load), with no extra page load. The rule
// is site-wide: one finding per distinct error, grouped across pages by normalised
// message and source file. A local or --http audit has no render, so the rule is
// declared cloud and lands on the "cloud checks that didn't run" list there.

import type {
  CheckItem,
  CheckResult,
  RenderFailedRequest,
  RenderResultItem,
  RenderRuntimeError,
} from "@squirrelscan/core-contracts";

import {
  humanizeCloudSkip,
  readCloudResult,
  type CloudSkipReason,
} from "../cloud";
import { registrableDomain } from "../content/dev-leakage";
import type { Rule, RuleContext, RuleResult } from "../types";

/** Sample pages listed per finding; the total rides on `pageCount`. */
const MAX_SAMPLE_PAGES = 10;
/** Longest normalised message kept in a group key. */
const MAX_MESSAGE_LENGTH = 200;

type Category =
  | "uncaught"
  | "hydration"
  | "console"
  | "third-party"
  | "request";

interface Group {
  category: Category;
  label: string;
  key: string;
  pages: Set<string>;
}

const HYDRATION_PATTERNS: RegExp[] = [
  /hydration (failed|error)/i,
  /text content does not match server-rendered html/i,
  /did not match\.? (server|expected)/i,
  /minified react error #(418|423|425)\b/i,
  /react\.dev\/errors\/(418|423|425)\b/i,
  /hydrat\w* .*mismatch/i,
  /mismatch.* hydrat/i,
];

export function isHydrationMessage(message: string): boolean {
  return HYDRATION_PATTERNS.some((re) => re.test(message));
}

/** Noise that is never the site's fault, or is owned by another rule. */
function isIgnoredMessage(message: string): boolean {
  if (/ResizeObserver loop/i.test(message)) return true;
  // CSP violations are security/csp-violations (#425).
  if (/content security policy/i.test(message)) return true;
  if (
    /refused to (load|execute|connect|apply|frame|run)\b.*(violates|directive)/i.test(
      message
    )
  ) {
    return true;
  }
  // Chrome's console echo of a failed request: the request itself is reported from failedRequests.
  if (/^failed to load resource:/i.test(message)) return true;
  return false;
}

function normaliseMessage(message: string): string {
  return message
    .replace(/https?:\/\/[^\s'")]+/g, (u) => stripQuery(u))
    .replace(/\d+/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MESSAGE_LENGTH);
}

function stripQuery(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split(/[?#]/)[0] ?? url;
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

function firstPartyChecker(baseUrl: string): (url: string) => boolean {
  const siteHost = hostOf(baseUrl);
  const siteDomain = siteHost ? registrableDomain(siteHost) : null;
  return (url) => {
    const host = hostOf(url);
    if (!host || !siteHost) return false;
    if (host === siteHost || host.endsWith(`.${siteHost}`)) return true;
    return siteDomain !== null && registrableDomain(host) === siteDomain;
  };
}

/** The renderer saw a bot or WAF challenge in place of the page: its errors are the challenge's. */
function isChallengePage(item: RenderResultItem): boolean {
  if (item.headers?.["cf-mitigated"]?.toLowerCase() === "challenge")
    return true;
  return item.status === 403 || item.status === 429 || item.status === 503;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function sourceLabel(error: RenderRuntimeError, pageUrl: string): string {
  const src =
    error.sourceUrl && error.sourceUrl !== "" ? error.sourceUrl : pageUrl;
  const where = pathOf(src);
  return error.line !== undefined ? `${where}:${error.line}` : where;
}

function isAbort(error: string | null | undefined): boolean {
  return typeof error === "string" && /ERR_ABORTED|aborted/i.test(error);
}

export const jsErrorsRule: Rule = {
  meta: {
    id: "reliability/js-errors",
    name: "JavaScript Errors and Failed Runtime Requests",
    description:
      "Reports uncaught JavaScript exceptions, hydration mismatches, console errors and failed runtime requests seen while rendering pages, grouped across the site",
    solution:
      "A page can answer 200 with clean HTML and still be broken in the browser: an uncaught exception stops a menu or checkout, a hydration mismatch makes the framework discard the server HTML, a lazy chunk deleted by a deploy never loads, or an API call made after load answers 500 and leaves a section empty. Fix the error at the reported source file and line. For a hydration mismatch, make the server and client render the same markup (no Date.now(), random values, or browser-only checks during render). For ChunkLoadError after a deploy, keep the previous release's hashed chunks online for a while. For a failing API call, fix the endpoint or handle the failure in the UI. Third-party failures are warnings: check the provider or remove the tag.",
    category: "reliability",
    scope: "site",
    severity: "error",
    weight: 6,
    // The render runs inside the audit and is billed as the page's own audit charge (#2290).
    cloud: { service: "render", unit: "page", creditFeature: "audit_page" },
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const site = ctx.site;
    const renders = ctx.cloudResults?.get("render");

    const skip = (message: string, skipReason: string): RuleResult => ({
      checks: [{ name: "js-errors", status: "skipped", message, skipReason }],
    });

    if (!site)
      return skip("Site data not available", "Site data not available");
    if (!renders || renders.size === 0) {
      return skip(
        "JavaScript errors were not checked",
        humanizeCloudSkip("not-prefetched")
      );
    }

    const isFirstParty = firstPartyChecker(site.baseUrl);
    const groups = new Map<string, Group>();
    const add = (
      category: Category,
      key: string,
      label: string,
      page: string
    ): void => {
      const groupKey = `${category}\n${key}`;
      let group = groups.get(groupKey);
      if (!group) {
        group = { category, label, key: groupKey, pages: new Set() };
        groups.set(groupKey, group);
      }
      group.pages.add(page);
    };

    let measured = 0;
    let unmeasured = 0;
    let challenged = 0;
    let firstSkip: CloudSkipReason | string | undefined;

    for (const pageUrl of renders.keys()) {
      const envelope = readCloudResult<RenderResultItem>(
        ctx.cloudResults,
        "render",
        pageUrl
      );
      if (!envelope || envelope.status === "skipped" || !envelope.data) {
        firstSkip ??= envelope?.skipReason ?? "not-prefetched";
        continue;
      }
      const data = envelope.data;
      if (isChallengePage(data)) {
        challenged++;
        continue;
      }
      if (!data.runtime) {
        unmeasured++;
        continue;
      }
      measured++;
      const {
        pageErrors = [],
        consoleErrors = [],
        failedRequests = [],
      } = data.runtime;

      for (const err of pageErrors) {
        if (!err.message || isIgnoredMessage(err.message)) continue;
        const src =
          err.sourceUrl && err.sourceUrl !== "" ? err.sourceUrl : pageUrl;
        const first = isFirstParty(src);
        const norm = normaliseMessage(err.message);
        const file = stripQuery(src);
        const label = `${err.message.split("\n")[0]?.slice(0, 160)} at ${sourceLabel(err, pageUrl)}`;
        if (isHydrationMessage(err.message))
          add("hydration", `${norm}\n${file}`, label, pageUrl);
        else if (first) add("uncaught", `${norm}\n${file}`, label, pageUrl);
        else add("third-party", `${norm}\n${file}`, label, pageUrl);
      }

      for (const err of consoleErrors) {
        if (!err.message || isIgnoredMessage(err.message)) continue;
        const src =
          err.sourceUrl && err.sourceUrl !== "" ? err.sourceUrl : pageUrl;
        const norm = normaliseMessage(err.message);
        const file = stripQuery(src);
        const label = `console.error: ${err.message.split("\n")[0]?.slice(0, 160)} at ${sourceLabel(err, pageUrl)}`;
        if (isHydrationMessage(err.message))
          add("hydration", `${norm}\n${file}`, label, pageUrl);
        else if (isFirstParty(src))
          add("console", `${norm}\n${file}`, label, pageUrl);
        else add("third-party", `console\n${norm}\n${file}`, label, pageUrl);
      }

      for (const req of failedRequests as RenderFailedRequest[]) {
        if (req.blockedByRenderer || isAbort(req.error)) continue;
        const hasStatus = typeof req.status === "number";
        const first = isFirstParty(req.url);
        const status = req.status as number;
        let reportable: boolean;
        if (hasStatus) {
          if (status < 400) continue;
          // 401/403 from the site's own API is a signed-out visitor, not a fault.
          reportable = first ? status >= 500 || status === 404 : true;
        } else {
          reportable = Boolean(req.error);
        }
        if (!reportable) continue;
        const detail = hasStatus ? `HTTP ${status}` : `error: ${req.error}`;
        const file = stripQuery(req.url);
        add(
          first ? "request" : "third-party",
          `request\n${file}\n${detail}`,
          `${req.resourceType ? `${req.resourceType} ` : ""}${file} (${detail})`,
          pageUrl
        );
      }
    }

    if (measured === 0) {
      if (unmeasured > 0) {
        return skip(
          "JavaScript errors were not checked",
          "The renderer did not record runtime errors for these pages"
        );
      }
      if (challenged > 0 && !firstSkip) {
        return skip(
          "JavaScript errors were not checked",
          "Every rendered page was a WAF or bot challenge, so its errors say nothing about the site"
        );
      }
      return skip(
        "JavaScript errors were not checked",
        humanizeCloudSkip((firstSkip as CloudSkipReason) ?? "not-prefetched")
      );
    }

    const toItem = (group: Group): CheckItem => {
      const pages = [...group.pages];
      return {
        id: group.key,
        label: `${group.label}, ${pages.length} page${pages.length === 1 ? "" : "s"}`,
        sourcePages: pages.slice(0, MAX_SAMPLE_PAGES),
        pageCount: pages.length,
        meta: { category: group.category },
      };
    };
    const byCount = (a: Group, b: Group): number => b.pages.size - a.pages.size;
    const of = (category: Category): Group[] =>
      [...groups.values()].filter((g) => g.category === category).sort(byCount);

    const emit = (
      category: Category,
      name: string,
      status: "fail" | "warn",
      message: (n: number) => string
    ): void => {
      const list = of(category);
      if (list.length === 0) return;
      checks.push({
        name,
        status,
        message: message(list.length),
        items: list.map(toItem),
        details: { count: list.length },
      });
    };

    emit(
      "uncaught",
      "js-errors",
      "fail",
      (n) => `${n} uncaught JavaScript error(s) thrown from first-party scripts`
    );
    emit(
      "hydration",
      "hydration-errors",
      "warn",
      (n) => `${n} framework hydration mismatch(es)`
    );
    emit(
      "request",
      "failed-runtime-requests",
      "warn",
      (n) => `${n} first-party request(s) made after load answered 5xx or 404`
    );
    emit(
      "console",
      "console-errors",
      "warn",
      (n) => `${n} console.error message(s) from first-party code`
    );
    emit(
      "third-party",
      "third-party-js-errors",
      "warn",
      (n) => `${n} third-party JavaScript error(s) or failed request(s)`
    );

    const notes: string[] = [];
    if (unmeasured > 0)
      notes.push(`${unmeasured} page(s) had no runtime data from the renderer`);
    if (challenged > 0)
      notes.push(
        `${challenged} page(s) were a WAF or bot challenge and were left out`
      );
    if (notes.length > 0) {
      checks.push({
        name: "unchecked-pages",
        status: "info",
        message: `Partial check: ${notes.join("; ")}`,
        details: { unmeasured, challenged },
      });
    }

    if (groups.size === 0) {
      checks.push({
        name: "js-errors",
        status: "pass",
        message: `No JavaScript errors or failed runtime requests on the ${measured} rendered page(s) checked`,
        value: measured,
      });
    }

    return { checks };
  },
};
