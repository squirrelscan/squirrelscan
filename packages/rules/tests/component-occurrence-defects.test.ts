// Review findings against the #2307 rule-side evidence code. Each test names
// the defect it pins rather than the function it calls.

import { describe, expect, test } from "bun:test";
import { parseHTML } from "@squirrelscan/parser/dom";

import { linkTextRule } from "../src/a11y/link-text";
import { staleCopyrightRule } from "../src/content/stale-copyright";
import type { Element } from "linkedom";
import { ComponentOccurrenceCache, componentOccurrence } from "../src/shared/component-occurrence";
import type { ParsedPage, RuleContext } from "../src/types";

function ctx(html: string, pageUrl = "https://example.test/p"): RuleContext {
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  return {
    page: { url: pageUrl, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: { document } as unknown as ParsedPage,
    options: { current_year: 2026 },
  };
}

describe("region evidence is linear in the number of faulty elements", () => {
  test("a 5,000-link nav does not re-walk the region per link", () => {
    const links = Array.from(
      { length: 5000 },
      (_, i) => `<a href="/t${i}">Read more</a>`,
    ).join("");
    const started = performance.now();
    const checks = linkTextRule.run(ctx(`<footer><nav>${links}</nav></footer>`)).checks;
    const elapsed = performance.now() - started;

    expect(checks[0]?.componentOccurrences).toHaveLength(5000);
    // Generous: the point is that it is not quadratic. Rebuilding the region's
    // direct-child sequence per link is ~25M child visits and blows this by
    // orders of magnitude.
    expect(elapsed).toBeLessThan(1000);
  });
});

describe("content nested BELOW a chrome region is not site chrome", () => {
  test("an article inside the footer keeps its links page-scoped", () => {
    const html =
      "<footer><article><a href='/related'>Read more</a></article><a href='/pricing'>Read more</a></footer>";
    const occurrences = linkTextRule.run(ctx(html)).checks[0]!.componentOccurrences!;
    const inArticle = occurrences.find((o) => o.element.locator.includes("article"))!;
    const siteChrome = occurrences.find((o) => !o.element.locator.includes("article"))!;

    // The region is the footer either way, so ancestry ABOVE the region cannot
    // tell these apart — the nesting BETWEEN element and region is what does.
    expect(inArticle).toMatchObject({
      groupable: false,
      confidence: "uncertain",
      uncertainReason: "content-nested",
    });
    expect(siteChrome.groupable).toBe(true);
  });

  // `<main>` IS itself a region role, so `findRegion` stops at the main rather
  // than the footer and the reason is `region-main`. Different label, same
  // conservative outcome; asserted as it actually behaves.
  test("a main nested inside a footer is likewise not groupable", () => {
    const { document } = parseHTML(
      "<html><body><footer><main><p>© 2019 Acme</p></main></footer></body></html>",
    );
    const target = document.querySelector("p") as unknown as Element;
    const occurrence = componentOccurrence(
      { pageUrl: "https://example.test/p", rendered: false, element: target, kind: "stale-copyright", values: {} },
      new ComponentOccurrenceCache(),
    );
    expect(occurrence.groupable).toBe(false);
    expect(occurrence.uncertainReason).toBe("region-main");
  });
});

describe("stale-copyright detection is byte-identical to the baseline", () => {
  // The baseline concatenates the matches of EVERY footer selector, so one
  // element matching both `footer` and `.footer` contributes its text twice.
  // That duplication is load-bearing: the pattern needs the © marker BEFORE a
  // year, and only the seam between the two copies supplies it.
  test("an element matching two selectors still warns", () => {
    const checks = staleCopyrightRule.run(ctx('<footer class="footer">2025 &copy;</footer>')).checks;
    expect(checks[0]).toMatchObject({
      name: "footer-copyright-year",
      status: "warn",
      value: 2025,
    });
  });

  test("that finding carries NO evidence, because no element asserts the year", () => {
    // The year is a concatenation artifact: it exists only at the seam between
    // the two copies, so no single element's text asserts it. The finding must
    // still stand (parity), and evidence must stay empty rather than blaming an
    // element that does not say what the finding claims.
    const check = staleCopyrightRule.run(ctx('<footer class="footer">2025 &copy;</footer>')).checks[0]!;
    expect(check.status).toBe("warn");
    expect(check.componentOccurrences ?? []).toHaveLength(0);
  });

  test("deep wrapper chains stay linear", () => {
    const depth = 400;
    const inner = `${"<div>".repeat(depth)}<p>&copy; 2019 Acme</p>${"</div>".repeat(depth)}`;
    const started = performance.now();
    const check = staleCopyrightRule.run(ctx(`<footer>${inner}</footer>`)).checks[0]!;
    const elapsed = performance.now() - started;
    expect(check.status).toBe("warn");
    // Evidence belongs to the innermost element asserting the year.
    expect(check.componentOccurrences).toHaveLength(1);
    expect(elapsed).toBeLessThan(1000);
  });
});
