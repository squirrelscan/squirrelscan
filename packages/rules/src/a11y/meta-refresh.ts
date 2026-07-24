// a11y/meta-refresh - No meta refresh redirect

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { getAttrCI } from "@squirrelscan/utils";

export const metaRefreshRule: Rule = {
  meta: {
    id: "a11y/meta-refresh",
    name: "Meta Refresh",
    description: "Checks for meta refresh redirects that can disorient users",
    solution:
      "Avoid using <meta http-equiv='refresh'> for redirects or auto-refresh. They can disorient users, especially those using screen readers. Use server-side redirects (301/302) instead. If content must refresh, provide a user control and warn users beforehand.",
    category: "a11y",
    scope: "page",
    severity: "error",
    weight: 7,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    // http-equiv value varies in case across sites ("refresh", "Refresh", etc.)
    const metas = doc.querySelectorAll("meta");
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
    } else {
      checks.push({
        name: "meta-refresh",
        status: "pass",
        message: "No meta refresh found",
      });
    }

    return { checks };
  },
};
