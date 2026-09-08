// a11y/skip-link — the "early heading" bypass asks whether a heading's markup
// appears in the first 2000 characters of `body.innerHTML`.
//
// #1864 stopped serialising the whole body once per heading, and stopped
// searching the whole megabyte for a heading that can only count if it is in the
// first 2000 characters. The searched prefix has to run to 2000 PLUS the
// heading's own length: a heading that starts at 1999 and ends at 2012 counts,
// and slicing at a flat 2000 truncates it and silently loses the bypass.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { skipLinkRule } from "../src/a11y/skip-link";
import type { RuleContext } from "../src/types";

const HEADING = "<h2>Section</h2>";

/** A body whose only h1/h2 starts at exactly `at` characters into innerHTML. */
function bodyWithHeadingAt(at: number, trailing = 0): string {
  const wrapper = "<div></div>".length; // the filler div's own markup
  const filler = "x".repeat(at - wrapper);
  const tail = trailing > 0 ? `<p>${"y".repeat(trailing)}</p>` : "";
  return `<div>${filler}</div>${HEADING}${tail}`;
}

function methods(bodyHtml: string): string[] {
  const url = "https://example.com/";
  const html = `<!DOCTYPE html><html><head><title>t</title></head><body>${bodyHtml}</body></html>`;
  const ctx = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    site: { baseUrl: "https://example.com", pages: [], robotsTxt: null, sitemaps: null, scripts: [] },
    options: {},
  } as unknown as RuleContext;
  const check = skipLinkRule.run(ctx).checks[0];
  // The passing branch reports the bypasses under `methods`, the warning branch
  // under `found`; this rule is about which bypasses were seen either way.
  const details = check?.details as { methods?: string[]; found?: string[] } | undefined;
  return [...(details?.methods ?? details?.found ?? [])];
}

describe("a11y/skip-link: the early-heading window", () => {
  test("the fixture puts the heading where it claims to", () => {
    // If linkedom reserialises the filler differently the offsets below are
    // meaningless, so pin the offset itself before asserting on it.
    const url = "https://example.com/";
    const html = `<!DOCTYPE html><html><head><title>t</title></head><body>${bodyWithHeadingAt(1999)}</body></html>`;
    const body = parsePage(html, url).document!.querySelector("body")!;
    expect(body.innerHTML.indexOf(HEADING)).toBe(1999);
  });

  test("a heading starting at 1999 counts, and it straddles the 2000 boundary", () => {
    expect(methods(bodyWithHeadingAt(1999))).toContain("early heading");
  });

  test("a heading starting at exactly 2000 does not count", () => {
    expect(methods(bodyWithHeadingAt(2000))).not.toContain("early heading");
  });

  test("a heading far past the window does not count, whatever follows it", () => {
    expect(methods(bodyWithHeadingAt(40_000))).not.toContain("early heading");
  });

  test("content after the heading does not change the answer", () => {
    // The searched prefix is shorter than the document; a rule that only looked
    // at the prefix would still have to agree with one that looked at all of it.
    expect(methods(bodyWithHeadingAt(1999, 50_000))).toContain("early heading");
    expect(methods(bodyWithHeadingAt(2000, 50_000))).not.toContain("early heading");
  });
});
