// perf/js-libraries — #1864 put a prefilter in front of the signature loop: one
// pass over each inline script builds a 4-gram index, and a signature whose
// mandatory literals the index does not contain is skipped instead of run.
//
// The failure mode is a library that stops being detected, and it only appears
// on content large enough for the index to be built at all (256 characters) —
// and the arrangement that broke the index in review only appeared past 32 KB,
// where its table reaches full width. So every case here embeds the signature in
// a bundle-sized script and asserts the padded answer still carries everything
// the unpadded answer had.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { jsLibrariesRule } from "../src/performance/js-libraries";
import type { RuleContext } from "../src/types";

// Minified-looking filler that matches no library signature on its own.
const PAD = "function q0(a,b){return a+b*2}var z9=[1,2,3].map(q0);".repeat(1400);

function detected(script: string): string[] {
  const url = "https://example.com/";
  const html = `<!DOCTYPE html><html><head><title>t</title></head><body><script>${script}</script></body></html>`;
  const ctx = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    site: { baseUrl: "https://example.com", pages: [], robotsTxt: null, sitemaps: null, scripts: [] },
    options: {},
  } as unknown as RuleContext;
  const check = jsLibrariesRule.run(ctx).checks.find((c) => c.name === "js-libraries-detected");
  return (check?.items ?? []).map((i) => i.id).sort();
}

// One inline signature per library, taken from the shipped `inlinePatterns`.
// Each token is written so the MATCH begins at its first character, because the
// character before the match is the one the tests below vary.
const SIGNATURES: Array<[string, string]> = [
  ["jQuery", "jQuery.fn.jquery"],
  ["React", "__REACT_DEVTOOLS_GLOBAL_HOOK__"],
  ["Angular", "getAllAngularRootElements"],
  ["Svelte", "SvelteComponent"],
  ["Next.js", "__NEXT_DATA__"],
  ["Nuxt", "__NUXT__"],
];

describe("perf/js-libraries: the inline prefilter never loses a detection", () => {
  test("the pad on its own detects nothing", () => {
    expect(detected(PAD)).toEqual([]);
  });

  // The character IMMEDIATELY BEFORE a signature's match is what the index's
  // window hash must not depend on, and a mis-masked hash leaks its low bit. One
  // lead-in character alone leaves that whole class of bug undetected.
  const LEAD_INS = [";", "(", "=", "!", "'", "-", "1", "a", " ", "\n"];
  // The rule ignores inline scripts of 50 characters or fewer.
  const SHORT_PAD = `var ${"z".repeat(60)}=1`;

  test("every signature detected in a short script is detected in a 70 KB one", () => {
    const lost: string[] = [];
    for (const [name, token] of SIGNATURES) {
      for (const lead of LEAD_INS) {
        const bare = detected(`${SHORT_PAD}${lead}${token}`);
        // A signature that does not detect unpadded proves nothing about padding.
        expect(bare).toContain(name);
        const padded = detected(`${PAD}${lead}${token}\n${PAD}`);
        for (const id of bare) {
          if (!padded.includes(id)) lost.push(`${name} after ${JSON.stringify(lead)}: lost ${id}`);
        }
      }
    }
    expect(lost).toEqual([]);
  });

  test("a signature in the HTML rather than a script is still found at page size", () => {
    // The HTML body gets its own index, and Angular's `ng-version` marker is
    // matched against the markup rather than against any script.
    const url = "https://example.com/";
    const html = `<!DOCTYPE html><html><head><title>t</title></head><body><app-root ng-version="17.1.0"></app-root><p>${"filler ".repeat(9000)}</p></body></html>`;
    const ctx = {
      page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
      parsed: parsePage(html, url),
      site: { baseUrl: "https://example.com", pages: [], robotsTxt: null, sitemaps: null, scripts: [] },
      options: {},
    } as unknown as RuleContext;
    const check = jsLibrariesRule.run(ctx).checks.find((c) => c.name === "js-libraries-detected");
    expect((check?.items ?? []).map((i) => i.id)).toContain("Angular v17.1.0");
  });
});
