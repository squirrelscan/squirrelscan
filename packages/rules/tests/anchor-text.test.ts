// links/anchor-text — per-target grouping (#104): a card with an image link,
// a headline link, and a "Read more" link to the same target is one unit,
// not three findings.

import { describe, expect, test } from "bun:test";
import { parseHTML } from "@squirrelscan/parser/dom";

import { anchorTextRule } from "../src/links/anchor-text";
import type { ParsedPage, RuleContext } from "../src/types";

function ctx(html: string): RuleContext {
  const doc = parseHTML(html).document;
  return {
    page: { url: "https://example.com/", html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: { document: doc } as unknown as ParsedPage,
    options: {},
  } as unknown as RuleContext;
}

function run(html: string) {
  return anchorTextRule.run(ctx(html)).checks;
}

describe("links/anchor-text", () => {
  test("descriptive standalone link passes", () => {
    const checks = run('<a href="/repairs">Commercial freezer repairs</a>');
    expect(checks).toHaveLength(1);
    expect(checks[0].name).toBe("anchor-text");
    expect(checks[0].status).toBe("pass");
  });

  test("card pattern: image link + descriptive headline + read-more, all to the same target — no findings", () => {
    const checks = run(`
      <div class="card">
        <a href="/repairs"><img alt=""></a>
        <a href="/repairs">Commercial freezer repairs</a>
        <a href="/repairs">Read more</a>
      </div>
    `);
    expect(checks).toHaveLength(1);
    expect(checks[0].name).toBe("anchor-text");
    expect(checks[0].status).toBe("pass");
  });

  test("single empty-alt image link with no sibling to the same target — still reported", () => {
    const checks = run('<a href="/repairs"><img alt=""></a>');
    const empty = checks.find((c) => c.name === "empty-anchor");
    expect(empty).toBeDefined();
    expect(empty?.status).toBe("warn");
    expect(empty?.items).toHaveLength(1);
  });

  test("card where every link is empty or generic — reported once, not three times", () => {
    const checks = run(`
      <div class="card">
        <a href="/widgets"><img alt=""></a>
        <a href="/widgets">Read more</a>
        <a href="/widgets">Click here</a>
      </div>
    `);
    const generic = checks.find((c) => c.name === "generic-anchor");
    expect(generic).toBeDefined();
    expect(generic?.items).toHaveLength(1);
    expect(checks.find((c) => c.name === "empty-anchor")).toBeUndefined();
  });

  test("different targets are evaluated independently", () => {
    const checks = run(`
      <a href="/a"><img alt=""></a>
      <a href="/b">Read more</a>
    `);
    const empty = checks.find((c) => c.name === "empty-anchor");
    const generic = checks.find((c) => c.name === "generic-anchor");
    expect(empty?.items).toHaveLength(1);
    expect(generic?.items).toHaveLength(1);
  });

  test("accessible name via aria-label counts toward the group", () => {
    const checks = run(`
      <a href="/repairs" aria-label="Commercial freezer repairs"><img alt=""></a>
      <a href="/repairs">Read more</a>
    `);
    expect(checks).toHaveLength(1);
    expect(checks[0].name).toBe("anchor-text");
  });

  test("anchor-only links are ignored", () => {
    const checks = run('<a href="#section"></a>');
    expect(checks).toHaveLength(1);
    expect(checks[0].name).toBe("anchor-text");
  });
});
