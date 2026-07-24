// content/broken-html - Malformed HTML detection
import { parseHTML } from "linkedom";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const brokenHtmlRule: Rule = {
  meta: {
    id: "content/broken-html",
    name: "Broken HTML",
    description: "Checks for malformed HTML structure",
    solution:
      "Valid HTML helps search engines parse and understand your content. Common issues: unclosed tags, nested elements incorrectly, invalid attributes. Use an HTML validator to find issues. Modern browsers are forgiving, but search engine parsers may not be. Clean HTML also improves accessibility and maintainability.",
    category: "content",
    scope: "page",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const html = ctx.page.html;

    // Each issue carries a slug `id` (a stable, angle-bracket-free identifier)
    // and a human-readable `label`. The label is what holds the literal tag
    // text (e.g. "Missing <html> tag") — keeping it out of `id` matters because
    // the publish payload scanner flags `<html>`-style strings as HTML injection
    // in scanned fields, but skips `.label` (CLI-authored copy). Renderers show
    // `label ?? id`.
    const issues: Array<{ id: string; label: string }> = [];

    // Check for DOCTYPE
    if (!html.trim().toLowerCase().startsWith("<!doctype")) {
      issues.push({ id: "missing-doctype", label: "Missing DOCTYPE" });
    }

    // Check for basic structure. Reuse the page's already-parsed DOM
    // (buildSiteContext parsed it once); only re-parse for error pages whose
    // parsed document is null (#262).
    const doc = ctx.parsed.document ?? parseHTML(html).document;

    if (!doc.querySelector("html")) {
      issues.push({ id: "missing-html", label: "Missing <html> tag" });
    }

    if (!doc.querySelector("head")) {
      issues.push({ id: "missing-head", label: "Missing <head> tag" });
    }

    if (!doc.querySelector("body")) {
      issues.push({ id: "missing-body", label: "Missing <body> tag" });
    }

    // Check for common nesting issues
    // Links inside links
    const nestedLinks = doc.querySelectorAll("a a");
    if (nestedLinks.length > 0) {
      issues.push({ id: "nested-links", label: `${nestedLinks.length} nested <a> tag(s)` });
    }

    // Buttons inside links or vice versa
    const buttonInLink = doc.querySelectorAll("a button, button a");
    if (buttonInLink.length > 0) {
      issues.push({ id: "button-in-link", label: "Button inside link or vice versa" });
    }

    // Forms inside forms
    const nestedForms = doc.querySelectorAll("form form");
    if (nestedForms.length > 0) {
      issues.push({ id: "nested-forms", label: "Nested <form> tags" });
    }

    // Check for deprecated elements
    const deprecated = ["center", "font", "marquee", "blink", "strike"];
    for (const tag of deprecated) {
      const elements = doc.querySelectorAll(tag);
      if (elements.length > 0) {
        issues.push({ id: `deprecated-${tag}`, label: `Deprecated <${tag}> element` });
        break; // Only report one deprecated element
      }
    }

    if (issues.length > 0) {
      checks.push({
        name: "broken-html",
        status: issues.some((i) => i.id.startsWith("missing-")) ? "warn" : "info",
        message: `${issues.length} HTML issue(s) found`,
        items: issues.map((issue) => ({ id: issue.id, label: issue.label })),
      });
    } else {
      checks.push({
        name: "broken-html",
        status: "pass",
        message: "HTML structure appears valid",
      });
    }

    return { checks };
  },
};
