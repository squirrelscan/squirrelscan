// content/meta-in-body - Detects meta tags incorrectly placed in body

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const metaInBodyRule: Rule = {
  meta: {
    id: "content/meta-in-body",
    name: "Meta Tags in Body",
    description: "Detects meta tags incorrectly placed in document body",
    solution:
      "Move all meta tags from <body> to <head>. Meta tags in the body are ignored by browsers and search engines. Common offenders: meta description, viewport, robots, and Open Graph tags. This is often caused by incorrect HTML structure or dynamic rendering issues.",
    category: "content",
    scope: "page",
    severity: "error",
    weight: 8,
  },

  run(ctx: RuleContext): RuleResult {
    const { document } = ctx.parsed;
    const checks: CheckResult[] = [];
    if (!document) return { checks: [] };

    // Query all meta tags in body
    const bodyMetas = document.querySelectorAll("body meta");

    if (bodyMetas.length === 0) {
      checks.push({
        name: "meta-in-body",
        status: "pass",
        message: "All meta tags correctly placed in <head>",
      });
      return { checks };
    }

    // Collect meta tag details
    const metaItems: {
      id: string;
      label: string;
      meta: Record<string, unknown>;
    }[] = [];
    for (const meta of Array.from(bodyMetas)) {
      const name =
        meta.getAttribute("name") || meta.getAttribute("property") || "unknown";
      const content = meta.getAttribute("content") || "";
      const truncated =
        content.length > 50 ? `${content.slice(0, 50)}...` : content;
      metaItems.push({
        id: name,
        label: `${name}="${truncated}"`,
        meta: { content: truncated },
      });
    }

    checks.push({
      name: "meta-in-body",
      status: "fail",
      message: `Found ${bodyMetas.length} meta tag${bodyMetas.length > 1 ? "s" : ""} in <body>`,
      items: metaItems,
      expected: "All meta tags in <head>",
    });

    return { checks };
  },
};
