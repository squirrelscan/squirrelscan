import { describe, expect, test } from "bun:test";
import { parseHTML } from "@squirrelscan/parser/dom";

import { domSizeRule } from "../src/performance/dom-size";
import type { ParsedPage, RuleContext } from "../src/types";

function makeCtx(html: string): RuleContext {
  return {
    page: { url: "https://example.com/", html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: { document: parseHTML(html).document } as unknown as ParsedPage,
    options: {},
  };
}

function maxChildren(html: string) {
  const result = domSizeRule.run(makeCtx(html));
  if (result instanceof Promise) throw new Error("unexpected async rule");
  return result.checks.find((c) => c.name === "dom-max-children");
}

const page = (head: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title>${head}</head><body>${body}</body></html>`;

describe("perf/dom-size dom-max-children", () => {
  test("70 hreflang links in head with a small body: no finding", () => {
    const head = Array.from(
      { length: 70 },
      (_, i) => `<link rel="alternate" hreflang="l${i}" href="http://127.0.0.1:8766/l${i}/">`,
    ).join("\n");
    const check = maxChildren(page(head, "<h1>Hello</h1><p>Small body.</p>"));
    expect(check?.status).toBe("pass");
    expect(check?.value).toBe(2);
  });

  test("70 preload links in head with a small body: no finding", () => {
    const head = Array.from(
      { length: 70 },
      (_, i) => `<link rel="preload" as="image" href="/img/${i}.webp">`,
    ).join("\n");
    const check = maxChildren(page(head, "<h1>Hello</h1><p>Small body.</p>"));
    expect(check?.status).toBe("pass");
    expect(check?.value).toBe(2);
  });

  test("a body ul with 61 li is reported with value 61", () => {
    const items = Array.from({ length: 61 }, (_, i) => `<li>${i}</li>`).join("");
    const check = maxChildren(page("", `<ul>${items}</ul>`));
    expect(check?.status).toBe("warn");
    expect(check?.value).toBe(61);
  });

  test("a document with no body element is skipped, not measured", () => {
    const doc = { documentElement: parseHTML("<html></html>").document.documentElement, body: null };
    const ctx = {
      ...makeCtx("<html></html>"),
      parsed: { document: doc } as unknown as ParsedPage,
    };
    const result = domSizeRule.run(ctx);
    if (result instanceof Promise) throw new Error("unexpected async rule");
    expect(result.checks).toEqual([
      {
        name: "dom-total-nodes",
        status: "skipped",
        message: "No body element found",
        skipReason: "Invalid document structure",
      },
    ]);
  });
});

// #1270: a page with no markup parses to an empty shell, so it measures as an
// empty body instead of being skipped or throwing.
describe("perf/dom-size on a document with no markup", () => {
  test.each(["", "just text", "<!-- only a comment -->"])("%j measures an empty body", (html) => {
    const result = domSizeRule.run(makeCtx(html));
    if (result instanceof Promise) throw new Error("unexpected async rule");
    const total = result.checks.find((c) => c.name === "dom-total-nodes");
    expect(total).toMatchObject({ status: "pass", value: 0 });
    expect(result.checks.some((c) => c.message?.startsWith("Rule error"))).toBe(false);
  });
});

// pub#548: total nodes and depth are measured from <body> too, so the three
// checks agree on what they measure, as Lighthouse's DOM size audit does.
describe("perf/dom-size total nodes and depth", () => {
  const check = (html: string, name: string, options: Record<string, unknown> = {}) => {
    const result = domSizeRule.run({ ...makeCtx(html), options });
    if (result instanceof Promise) throw new Error("unexpected async rule");
    return result.checks.find((c) => c.name === name);
  };

  test("a 70-link head with a small body reports the body's numbers", () => {
    const head = Array.from(
      { length: 70 },
      (_, i) => `<link rel="alternate" hreflang="l${i}" href="http://127.0.0.1:8766/l${i}/">`,
    ).join("");
    const html = page(head, "<h1>Hello</h1><p>Small <b>body</b>.</p>");
    // <h1>, <p>, <b>: the body's descendants, not the 72 head nodes.
    expect(check(html, "dom-total-nodes")).toMatchObject({ status: "pass", value: 3 });
    // <body> 1, <p> 2, <b> 3.
    expect(check(html, "dom-depth")).toMatchObject({ status: "pass", value: 3 });
    // A head that would cross the line on its own does not.
    expect(check(html, "dom-total-nodes", { warn_threshold: 50 })?.status).toBe("pass");
  });

  test("a deep body is still reported at the threshold", () => {
    const nest = (n: number) => `${"<div>".repeat(n)}x${"</div>".repeat(n)}`;
    // body (1) + 31 divs = 32 levels: at the limit, passes; one more warns.
    expect(check(page("", nest(31)), "dom-depth")).toMatchObject({ status: "pass", value: 32 });
    expect(check(page("", nest(32)), "dom-depth")).toMatchObject({ status: "warn", value: 33 });
  });

  test("the node thresholds read the body count", () => {
    const items = (n: number) => `<ul>${"<li>x</li>".repeat(n - 1)}</ul>`;
    expect(check(page("", items(1499)), "dom-total-nodes")).toMatchObject({ status: "pass", value: 1499 });
    expect(check(page("", items(1500)), "dom-total-nodes")).toMatchObject({ status: "warn", value: 1500 });
    expect(check(page("", items(3000)), "dom-total-nodes")).toMatchObject({ status: "fail", value: 3000 });
  });
});
