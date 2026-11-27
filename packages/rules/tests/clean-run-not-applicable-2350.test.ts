// #2350: a11y/aria-labels and schema/website-search used to return an empty list when the page had nothing
// in their scope, which reads the same as a rule that never ran. Each now emits one neutral not-applicable
// skipped row there, and only there: a page with something in scope keeps its pass, warn or info rows.

import type { CheckResult } from "@squirrelscan/core-contracts";

import { CHECK_NOT_APPLICABLE_SKIP_REASON } from "@squirrelscan/core-contracts/resolution";
import { parsePage } from "@squirrelscan/parser";
import { describe, expect, test } from "bun:test";

import type { ParsedPage, Rule } from "../src/types";

import { ariaLabelsRule } from "../src/a11y/aria-labels";
import { websiteSearchSchemaRule } from "../src/schema/website-search";

function run(rule: Rule, url: string, body: string, head = ""): CheckResult[] {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture</title>${head}</head><body><main><h1>Fixture</h1>${body}</main></body></html>`;
  const out = rule.run({
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url) as ParsedPage,
    options: {},
  });
  if (out instanceof Promise) throw new Error("expected a synchronous rule");
  return out.checks;
}

const notApplicable = (name: string, message: string): CheckResult[] => [
  {
    name,
    status: "skipped",
    skipReason: CHECK_NOT_APPLICABLE_SKIP_REASON,
    details: { foldKey: CHECK_NOT_APPLICABLE_SKIP_REASON },
    message,
  },
];

const skipped = (checks: CheckResult[]) =>
  checks.filter((c) => c.status === "skipped");

const website = (extra: Record<string, unknown> = {}) =>
  `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebSite",
    url: "https://example.com/",
    ...extra,
  })}</script>`;

describe("a11y/aria-labels", () => {
  const page = "https://example.com/about";

  test("a page with no button and no interactive svg emits one not-applicable row", () => {
    expect(run(ariaLabelsRule, page, "<p>Plain text.</p>")).toEqual(
      notApplicable("aria-buttons", "No button in scope on this page")
    );
  });

  test("a named button passes, with no skipped row", () => {
    const checks = run(ariaLabelsRule, page, "<button>Save</button>");
    expect(checks.map((c) => [c.name, c.status])).toEqual([
      ["aria-buttons", "pass"],
    ]);
  });

  test("an unnamed button fails, with no skipped row", () => {
    const checks = run(ariaLabelsRule, page, "<button></button>");
    expect(checks.map((c) => [c.name, c.status])).toEqual([
      ["aria-buttons", "fail"],
    ]);
  });

  test("a hidden unnamed button still counts as a button in scope: a pass, not a skip", () => {
    const checks = run(ariaLabelsRule, page, "<button hidden></button>");
    expect(checks.map((c) => c.status)).toEqual(["pass"]);
  });

  test("an unnamed interactive svg warns, with no skipped row", () => {
    const checks = run(
      ariaLabelsRule,
      page,
      '<svg onclick="go()"><path d="M0 0"/></svg>'
    );
    expect(checks.map((c) => [c.name, c.status])).toEqual([
      ["aria-svg", "warn"],
    ]);
  });
});

describe("schema/website-search", () => {
  test("a page off the home page with no WebSite schema emits one not-applicable row", () => {
    expect(
      run(websiteSearchSchemaRule, "https://example.com/about", "<p>x</p>")
    ).toEqual(
      notApplicable("website-schema", "No WebSite schema in scope on this page")
    );
  });

  test("the home page with no WebSite schema keeps its info row and is never skipped", () => {
    const checks = run(websiteSearchSchemaRule, "https://example.com/", "");
    expect(checks.map((c) => [c.name, c.status])).toEqual([
      ["website-schema", "info"],
    ]);
  });

  test("a page off the home page with WebSite schema is judged, not skipped", () => {
    const checks = run(
      websiteSearchSchemaRule,
      "https://example.com/about",
      "",
      website()
    );
    expect(skipped(checks)).toEqual([]);
    expect(checks.map((c) => [c.name, c.status])).toEqual([
      ["website-schema", "pass"],
      ["website-search", "info"],
    ]);
  });
});
