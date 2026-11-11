// a11y/meta-refresh - No meta refresh redirect

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { getAttrCI, querySelectorAllOutsideNoscript } from "@squirrelscan/utils";

/** A refresh sent in the `Refresh` response header, read like the browser reads it. */
export interface RefreshHeader {
  raw: string;
  /** Seconds until the browser acts. */
  delay: number;
  /** The target, or null for a timed reload of the same page. */
  target: string | null;
}

const MAX_TARGET_CHARS = 200;

/**
 * Parse a `Refresh` header value: a delay, then optionally a separator (`;`,
 * `,` or whitespace) and a URL that may be prefixed `url=` and quoted. A value
 * with no leading number is ignored by browsers, so it returns null.
 */
export function parseRefreshHeader(raw: string): RefreshHeader | null {
  const match = /^\s*(\d+(?:\.\d*)?|\.\d+)\s*(?:[;,\s]\s*(.*))?$/s.exec(raw);
  if (!match) return null;
  const delay = Number.parseFloat(match[1]!);
  let rest = (match[2] ?? "").trim();
  rest = rest.replace(/^url\s*=\s*/i, "").trim();
  if (/^["']/.test(rest)) rest = rest.slice(1).replace(/["'].*$/s, "");
  const target = rest.trim();
  return {
    raw: raw.slice(0, MAX_TARGET_CHARS),
    delay,
    target: target === "" ? null : target.slice(0, MAX_TARGET_CHARS),
  };
}

/** The `Refresh` header, whatever its letter case. Null when absent or unparseable. */
export function readRefreshHeader(headers: Record<string, string> | undefined): RefreshHeader | null {
  if (!headers) return null;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "refresh" && typeof value === "string") return parseRefreshHeader(value);
  }
  return null;
}

type Severity = "warn" | "fail";

/** The status and message for a header refresh, graded like the meta tag. */
export function gradeRefreshHeader(h: RefreshHeader): {
  name: string;
  status: Severity;
  message: string;
  issue: string;
} {
  if (h.target !== null) {
    return h.delay === 0
      ? {
          name: "refresh-header-redirect",
          status: "warn",
          message: `Immediate Refresh header redirect to ${h.target}`,
          issue: "Use a server-side 301 or 308 redirect instead",
        }
      : {
          name: "refresh-header-redirect",
          status: "fail",
          message: `Refresh header redirect to ${h.target} after ${h.delay} seconds`,
          issue: "Timed redirects disorient users",
        };
  }
  if (h.delay === 0) {
    return {
      name: "refresh-header-reload",
      status: "fail",
      message: "Refresh header reloads the page immediately",
      issue: "A zero-second reload repeats forever",
    };
  }
  return {
    name: "refresh-header-reload",
    status: h.delay < 20 ? "fail" : "warn",
    message: `Page reloads every ${h.delay} seconds (Refresh header)`,
    issue: h.delay < 20 ? "Frequent refresh disrupts screen reader users" : "Provide user control over refresh",
  };
}

export const metaRefreshRule: Rule = {
  meta: {
    id: "a11y/meta-refresh",
    name: "Meta Refresh",
    description: "Checks for meta refresh tags and Refresh headers that can disorient users",
    solution:
      "Avoid using <meta http-equiv='refresh'> or a Refresh response header for redirects or auto-refresh. They can disorient users, especially those using screen readers, and search engines treat them as a weaker signal than a real redirect. Use a server-side redirect instead: 301 or 308 for a permanent move, 302 or 307 for a temporary one. If content must refresh, provide a user control and warn users beforehand.",
    category: "a11y",
    scope: "page",
    // The Refresh header is a response header, which the template cluster key
    // does not constrain, so the verdict is per page.
    verdictScope: "page",
    severity: "error",
    weight: 7,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    const header = readRefreshHeader(ctx.page.headers);
    if (!doc && !header) return { checks: [] };
    const checks: CheckResult[] = [];

    // http-equiv value varies in case across sites ("refresh", "Refresh", etc.)
    const metas = doc ? querySelectorAllOutsideNoscript(doc, "meta") : [];
    let metaRefresh: Element | null = null;
    for (const meta of metas) {
      if (getAttrCI(meta, "http-equiv")?.toLowerCase() === "refresh") {
        metaRefresh = meta;
        break;
      }
    }

    if (metaRefresh) {
      const content = metaRefresh.getAttribute("content") || "";

      // Parse the content value
      // Format: "seconds" or "seconds;url=..." or "seconds; url=..."
      const parts = content.split(";");
      const seconds = Number.parseInt(parts[0].trim(), 10);
      const hasUrl = content.toLowerCase().includes("url=");

      if (hasUrl) {
        // This is a redirect
        if (seconds === 0) {
          checks.push({
            name: "meta-refresh-redirect",
            status: "warn",
            message: "Immediate meta refresh redirect found",
            value: content,
            details: {
              issue: "Use server-side 301/302 redirect instead",
            },
          });
        } else {
          checks.push({
            name: "meta-refresh-redirect",
            status: "fail",
            message: `Meta refresh redirect after ${seconds} seconds`,
            value: content,
            details: {
              issue: "Timed redirects disorient users",
            },
          });
        }
      } else if (!Number.isNaN(seconds) && seconds > 0) {
        // This is an auto-refresh
        if (seconds < 20) {
          checks.push({
            name: "meta-refresh-auto",
            status: "fail",
            message: `Page auto-refreshes every ${seconds} seconds`,
            value: content,
            details: {
              issue: "Frequent refresh disrupts screen reader users",
            },
          });
        } else {
          checks.push({
            name: "meta-refresh-auto",
            status: "warn",
            message: `Page auto-refreshes every ${seconds} seconds`,
            value: content,
            details: {
              suggestion: "Provide user control over refresh",
            },
          });
        }
      }
    } else if (!header) {
      checks.push({
        name: "meta-refresh",
        status: "pass",
        message: "No meta refresh found",
      });
    }

    if (header) {
      const graded = gradeRefreshHeader(header);
      const metaCheck = checks.pop();
      checks.push(
        metaCheck
          ? {
              // One finding for a page that sends both, naming both sources.
              name: "refresh-header-and-meta",
              status: metaCheck.status === "fail" || graded.status === "fail" ? "fail" : "warn",
              message: `Refresh header (${graded.message}) and meta refresh (${metaCheck.message})`,
              value: `Refresh: ${header.raw}; meta: ${metaCheck.value ?? ""}`,
              details: { sources: ["header", "meta"], issue: graded.issue },
            }
          : {
              name: graded.name,
              status: graded.status,
              message: graded.message,
              value: `Refresh: ${header.raw}`,
              details: { source: "header", issue: graded.issue },
            },
      );
    }

    return { checks };
  },
};
