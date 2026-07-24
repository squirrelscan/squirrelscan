// images/svg-inline - Inline SVG size check

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const svgInlineRule: Rule = {
  meta: {
    id: "images/svg-inline",
    name: "Inline SVG Size",
    description: "Checks for large inline SVGs bloating HTML",
    solution:
      "Large inline SVGs increase HTML size and block rendering. Move SVGs >4KB to external files and reference with <img> or CSS background. Inline small, critical SVGs (icons, logos) only. Use SVGO to optimize. Consider SVG sprites for icon sets. Inline SVGs can't be cached separately from HTML.",
    category: "images",
    scope: "page",
    severity: "info",
    weight: 3,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const inlineSvgs = doc.querySelectorAll("svg");

    if (inlineSvgs.length === 0) {
      checks.push({
        name: "svg-inline",
        status: "info",
        message: "No inline SVGs found",
      });
      return { checks };
    }

    const SIZE_THRESHOLD = 4000; // 4KB threshold
    let largeCount = 0;
    let totalSize = 0;

    for (const svg of inlineSvgs) {
      const svgSize = svg.outerHTML.length;
      totalSize += svgSize;
      if (svgSize > SIZE_THRESHOLD) {
        largeCount++;
      }
    }

    const totalKB = (totalSize / 1024).toFixed(1);

    if (largeCount > 0) {
      checks.push({
        name: "svg-inline",
        status: "warn",
        message: `${largeCount} large inline SVG(s) (>${SIZE_THRESHOLD / 1000}KB each)`,
        value: `Total inline SVG size: ${totalKB}KB. Consider external files`,
      });
    } else if (totalSize > 10000) {
      // Total over 10KB even if individual SVGs are small
      checks.push({
        name: "svg-inline",
        status: "info",
        message: `${inlineSvgs.length} inline SVG(s) totaling ${totalKB}KB`,
        value: "Consider using SVG sprites or external files",
      });
    } else {
      checks.push({
        name: "svg-inline",
        status: "pass",
        message: `${inlineSvgs.length} inline SVG(s), ${totalKB}KB total`,
      });
    }

    return { checks };
  },
};
