// perf/dom-size - Detects excessive DOM complexity

import { z } from "zod";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const optionsSchema = z.object({
  warn_threshold: z
    .number()
    .default(1500)
    .describe("Warning threshold for total nodes"),
  error_threshold: z
    .number()
    .default(3000)
    .describe("Error threshold for total nodes"),
  max_depth: z.number().default(32).describe("Maximum DOM depth"),
  max_children: z.number().default(60).describe("Maximum children per element"),
});

// Helper: Count all element nodes recursively
function countNodes(element: Element): number {
  let count = 1; // Count self
  for (const child of Array.from(element.children)) {
    count += countNodes(child);
  }
  return count;
}

// Helper: Calculate maximum depth
function calculateMaxDepth(element: Element, currentDepth = 1): number {
  if (element.children.length === 0) {
    return currentDepth;
  }

  let maxChildDepth = currentDepth;
  for (const child of Array.from(element.children)) {
    const childDepth = calculateMaxDepth(child, currentDepth + 1);
    maxChildDepth = Math.max(maxChildDepth, childDepth);
  }

  return maxChildDepth;
}

// Helper: Find element with most children
function findMaxChildren(element: Element): number {
  let max = element.children.length;

  for (const child of Array.from(element.children)) {
    const childMax = findMaxChildren(child);
    max = Math.max(max, childMax);
  }

  return max;
}

export const domSizeRule: Rule = {
  meta: {
    id: "perf/dom-size",
    name: "DOM Size",
    description: "Detects excessive DOM complexity that impacts performance",
    solution: `Large DOMs slow page rendering, increase memory usage, and harm mobile performance. Google recommends keeping total nodes under 1500.

Fixes for large DOMs:
- Use virtualization for long lists (e.g., react-window)
- Lazy-load off-screen content
- Reduce unnecessary wrapper elements
- Use CSS instead of DOM for visual effects
- Paginate large content sections`,
    category: "perf",
    scope: "page",
    severity: "warning",
    weight: 6,
    optionsSchema,
  },

  run(ctx: RuleContext): RuleResult {
    const opts = optionsSchema.parse(ctx.options);
    const { document } = ctx.parsed;
    const checks: CheckResult[] = [];
    if (!document) return { checks: [] };

    const root = document.documentElement;
    if (!root) {
      checks.push({
        name: "dom-total-nodes",
        status: "skipped",
        message: "No document root found",
        skipReason: "Invalid document structure",
      });
      return { checks };
    }

    // Count total nodes
    const totalNodes = countNodes(root);

    // Calculate max depth
    const maxDepth = calculateMaxDepth(root);

    // Find elements with too many children
    const maxChildrenCount = findMaxChildren(root);

    // Check total nodes
    if (totalNodes < opts.warn_threshold) {
      checks.push({
        name: "dom-total-nodes",
        status: "pass",
        message: `DOM size OK (${totalNodes} nodes)`,
        value: totalNodes,
        expected: `< ${opts.warn_threshold} nodes`,
      });
    } else if (totalNodes < opts.error_threshold) {
      checks.push({
        name: "dom-total-nodes",
        status: "warn",
        message: `Large DOM (${totalNodes} nodes)`,
        value: totalNodes,
        expected: `< ${opts.warn_threshold} nodes`,
      });
    } else {
      checks.push({
        name: "dom-total-nodes",
        status: "fail",
        message: `Excessive DOM size (${totalNodes} nodes)`,
        value: totalNodes,
        expected: `< ${opts.error_threshold} nodes`,
      });
    }

    // Check depth
    if (maxDepth > opts.max_depth) {
      checks.push({
        name: "dom-depth",
        status: "warn",
        message: `DOM depth excessive (${maxDepth} levels)`,
        value: maxDepth,
        expected: `≤ ${opts.max_depth} levels`,
      });
    } else {
      checks.push({
        name: "dom-depth",
        status: "pass",
        message: `DOM depth OK (${maxDepth} levels)`,
        value: maxDepth,
      });
    }

    // Check max children
    if (maxChildrenCount > opts.max_children) {
      checks.push({
        name: "dom-max-children",
        status: "warn",
        message: `Element with ${maxChildrenCount} children found`,
        value: maxChildrenCount,
        expected: `≤ ${opts.max_children} children per element`,
      });
    } else {
      checks.push({
        name: "dom-max-children",
        status: "pass",
        message: `Max children per element OK (${maxChildrenCount})`,
        value: maxChildrenCount,
      });
    }

    return { checks };
  },
};
