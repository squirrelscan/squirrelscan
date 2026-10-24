// links/anchor-text — per-target grouping (#104): a card with an image link,
// a headline link, and a "Read more" link to the same target is one unit,
// not three findings.

import { describe, expect, test } from "bun:test";
import { parsePage } from "@squirrelscan/parser";
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

// #2307: where the flagged links sit.
describe("links/anchor-text — link sections", () => {
  const URL = "https://example.com/";

  /** A context whose parse carries the link sections, as every crawl since the classifier does. */
  function sectioned(html: string, strip = false): RuleContext {
    const parsed = parsePage(html, URL);
    if (strip) for (const link of parsed.links) delete link.section;
    return {
      page: { url: URL, html, statusCode: 200, loadTime: 0, headers: {} },
      parsed,
      options: {},
    } as unknown as RuleContext;
  }

  test("an empty anchor says where it sits and carries meta.sections", () => {
    const { checks } = anchorTextRule.run(
      sectioned('<footer><a href="/repairs"><img alt=""></a></footer>')
    );
    const empty = checks.find((c) => c.name === "empty-anchor");

    expect(empty?.items).toHaveLength(1);
    expect(empty?.items?.[0]).toMatchObject({
      id: "https://example.com/repairs",
      label: "https://example.com/repairs, linked in the footer",
      meta: { sections: { footer: 1 } },
    });
  });

  test("a generic anchor text names the sections of every link that uses it", () => {
    const { checks } = anchorTextRule.run(
      sectioned('<nav><a href="/a">Read more</a></nav><main><a href="/b">Read more</a></main>')
    );
    const generic = checks.find((c) => c.name === "generic-anchor");

    expect(generic?.items).toEqual([
      {
        id: '"Read more"',
        label: '"Read more", linked in the page content and the navigation',
        meta: { sections: { navigation: 1, content: 1 } },
        // pub#846: one page in each section it sits in, for the report's region scope.
        regions: { navigation: 1, content: 1 },
      },
    ]);
  });

  test("a schemeless host is found where the parse stored it", () => {
    // The DOM reads `www.example.org` as a relative path; the parse reads it as a host.
    const { checks } = anchorTextRule.run(
      sectioned('<footer><a href="www.example.org">click here</a></footer>')
    );

    expect(checks.find((c) => c.name === "generic-anchor")?.items).toEqual([
      {
        id: '"click here"',
        label: '"click here", linked in the footer',
        meta: { sections: { footer: 1 } },
        regions: { footer: 1 },
      },
    ]);
  });

  test("without section data the items are as they were", () => {
    const { checks } = anchorTextRule.run(
      sectioned('<footer><a href="/repairs"><img alt=""></a><a href="/x">here</a></footer>', true)
    );

    const empty = checks.find((c) => c.name === "empty-anchor");
    expect(empty?.items?.[0]).toEqual({
      id: "https://example.com/repairs",
      snippet: '<a href="/repairs"><img alt=""></a>',
    });
    expect(checks.find((c) => c.name === "generic-anchor")?.items).toEqual([
      { id: '"here"', label: '"here"' },
    ]);
  });
});
