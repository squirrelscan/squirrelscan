// a11y/landmark-regions - Check for landmark regions

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const landmarkRegionsRule: Rule = {
  meta: {
    id: "a11y/landmark-regions",
    name: "Landmark Regions",
    description: "Checks for proper landmark regions (main, nav, footer)",
    solution:
      "Landmark regions help screen reader users navigate page structure. Use semantic HTML5 elements: <main> for primary content, <nav> for navigation, <header> for page header, <footer> for footer, <aside> for sidebars, and <section>/<article> for content sections. Alternatively, use ARIA roles: role='main', role='navigation', etc. Each page should have exactly one <main> element.",
    category: "a11y",
    scope: "page",
    severity: "info",
    weight: 3,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    // Check for main landmark
    const mainElements = doc.querySelectorAll("main, [role='main']");
    if (mainElements.length === 0) {
      checks.push({
        name: "landmark-main",
        status: "warn",
        message: "No <main> landmark found",
        value: "Add <main> element around primary content",
      });
    } else if (mainElements.length > 1) {
      checks.push({
        name: "landmark-main",
        status: "warn",
        message: `Multiple main landmarks (${mainElements.length})`,
        value: "Pages should have exactly one <main> element",
      });
    } else {
      checks.push({
        name: "landmark-main",
        status: "pass",
        message: "Main landmark present",
      });
    }

    // Check for nav landmark
    const navElements = doc.querySelectorAll("nav, [role='navigation']");
    if (navElements.length === 0) {
      checks.push({
        name: "landmark-nav",
        status: "info",
        message: "No <nav> landmark found",
      });
    } else {
      checks.push({
        name: "landmark-nav",
        status: "pass",
        message: `${navElements.length} navigation landmark(s) found`,
      });
    }

    // Check for footer landmark
    const footerElements = doc.querySelectorAll("footer, [role='contentinfo']");
    if (footerElements.length === 0) {
      checks.push({
        name: "landmark-footer",
        status: "info",
        message: "No <footer> landmark found",
      });
    } else {
      checks.push({
        name: "landmark-footer",
        status: "pass",
        message: "Footer landmark present",
      });
    }

    return { checks };
  },
};
