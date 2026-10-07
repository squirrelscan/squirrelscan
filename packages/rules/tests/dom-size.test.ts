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

  test("a document with no body element does not throw", () => {
    const doc = { documentElement: parseHTML("<html></html>").document.documentElement, body: null };
    const ctx = {
      ...makeCtx("<html></html>"),
      parsed: { document: doc } as unknown as ParsedPage,
    };
    expect(() => domSizeRule.run(ctx)).not.toThrow();
  });
});
