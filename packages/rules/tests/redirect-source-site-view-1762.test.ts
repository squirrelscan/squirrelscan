// #1762: a URL that redirected stays in site.pages (flagged) for the redirect rules, and is
// invisible to everything that reads pages as content.

import { describe, expect, test } from "bun:test";

import { isSiteIndexable } from "../src/shared/noindex";
import { REDIRECT_AWARE_SITE_RULE_IDS, REDIRECT_SOURCE_RULE_IDS } from "../src/runner";

const parsed = (robots: string | null) => ({ meta: { robots }, document: null }) as never;

describe("redirect sources in site.pages (#1762)", () => {
  test("a redirecting homepage row does not stand in for the fetched homepage", () => {
    const pages = [
      { url: "https://example.com/", statusCode: 301, parsed: parsed(null), redirectSource: true },
      { url: "https://example.com/home", statusCode: 200, parsed: parsed("noindex") },
    ];
    // Without the flag the empty 301 row counts as the homepage and hides the noindex one.
    expect(isSiteIndexable(pages, "https://example.com/", [])).toBeUndefined();
    expect(isSiteIndexable([{ ...pages[0]!, redirectSource: undefined }], "https://example.com/", [])).toBe(true);
  });

  test("the rules that read a redirect's hops are the ones that keep seeing the source", () => {
    for (const id of ["crawl/redirect-chain", "links/redirect-chains"]) {
      expect(REDIRECT_AWARE_SITE_RULE_IDS.has(id)).toBe(true);
    }
    expect(REDIRECT_AWARE_SITE_RULE_IDS.has("performance/total-byte-weight")).toBe(false);
    expect(REDIRECT_SOURCE_RULE_IDS.has("crawl/canonical-chain")).toBe(true);
  });
});
