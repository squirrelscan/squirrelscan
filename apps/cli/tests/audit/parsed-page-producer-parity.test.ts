// All THREE ParsedPage producers must agree.
//
// A `ParsedPage` is built in three separate places:
//   1. `parsePage`          — @squirrelscan/parser (the canonical one)
//   2. `parseHtmlForRules`  — @squirrelscan/audit-engine (cloud + page-rule workers)
//   3. `parsePageRecord`    — apps/cli/src/audit/adapter.ts (this CLI's own copy)
//
// Every ParsedPage field is optional or independently defaulted, so adding one to
// a subset of them COMPILES, and each producer's own tests keep passing. The field
// is simply `undefined` wherever the un-updated producer ran, which for a rule
// reading it means silently seeing nothing. That is exactly how `contactLinks`
// shipped invisible to the CLI audit path.
//
// So this asserts parity across producers rather than testing any one of them:
// this file is the thing that fails when the next field lands in only two of three.

import type { ContactLinkData } from "@squirrelscan/core-contracts";

import { parseHtmlForRules } from "@squirrelscan/audit-engine";
import { parsePage } from "@squirrelscan/parser";
import { describe, expect, test } from "bun:test";

import type { PageRecord } from "../../src/crawler/storage/types";

import { parsePageRecord } from "../../src/audit/adapter";

const URL = "https://example.com/contact";

const HTML = `<!DOCTYPE html><html><head><title>Contact</title>
<script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org",
  "@type": "LocalBusiness",
  name: "Acorn Hardware",
  telephone: "+1 (555) 123-4567",
  address: {
    "@type": "PostalAddress",
    streetAddress: "123 Main St",
    addressLocality: "Sydney",
    postalCode: "2000",
  },
})}</script></head><body>
<a href="tel:+1 (555) 123-4567">+1 (555) 123-4567</a>
<a href="mailto:hi@example.com">Email us</a>
<a href="/about">About</a>
</body></html>`;

function pageRecord(): PageRecord {
  return {
    url: URL,
    normalizedUrl: URL,
    finalUrl: URL,
    depth: 1,
    status: 200,
    contentType: "text/html",
    sizeBytes: HTML.length,
    loadTimeMs: 5,
    fetchedAt: 1,
    etag: null,
    lastModified: null,
    contentHash: "h",
    html: HTML,
    parsedData: null,
    headers: { contentType: "text/html" },
    securityHeaders: {},
  } as unknown as PageRecord;
}

const EXPECTED_CONTACT_LINKS: ContactLinkData[] = [
  { scheme: "tel", value: "+1 (555) 123-4567", text: "+1 (555) 123-4567" },
  { scheme: "mailto", value: "hi@example.com", text: "Email us" },
];

describe("ParsedPage producer parity — contactLinks", () => {
  test("the canonical parser carries tel:/mailto: anchors", () => {
    expect(parsePage(HTML, URL).contactLinks).toEqual(EXPECTED_CONTACT_LINKS);
  });

  test("the audit-engine producer agrees with the canonical parser", () => {
    expect(parseHtmlForRules(HTML, URL).contactLinks).toEqual(
      EXPECTED_CONTACT_LINKS
    );
  });

  test("the CLI producer agrees with the canonical parser", () => {
    expect(parsePageRecord(pageRecord())?.contactLinks).toEqual(
      EXPECTED_CONTACT_LINKS
    );
  });

  test("all three agree with each other, and none leak contacts into the link graph", () => {
    const produced = [
      parsePage(HTML, URL),
      parseHtmlForRules(HTML, URL),
      parsePageRecord(pageRecord())!,
    ];

    for (const parsed of produced) {
      expect(parsed.contactLinks).toEqual(produced[0]!.contactLinks);
      // tel:/mailto: are not crawlable and must stay out of `links`.
      expect(parsed.links.map((l) => l.url)).toEqual([
        "https://example.com/about",
      ]);
    }
  });
});

// #109 — `links/no-contextual-inbound` reads `LinkData.isChrome`, and which
// producer ran depends on whether the crawl stored `parsedData`. A flag set in
// only some of them would make the rule silently pass on half the audit paths.
const CHROME_HTML = `<!DOCTYPE html><html><head><title>t</title></head><body>
<nav><a href="/nav">nav</a></nav>
<main><p><a href="/body">body</a></p></main>
<footer><a href="/legal">legal</a></footer>
</body></html>`;

function chromeRecord(): PageRecord {
  return { ...pageRecord(), html: CHROME_HTML } as PageRecord;
}

describe("ParsedPage producer parity — isChrome", () => {
  test("all three producers classify nav/footer as chrome and body copy as not", () => {
    const produced = [
      parsePage(CHROME_HTML, URL),
      parseHtmlForRules(CHROME_HTML, URL),
      parsePageRecord(chromeRecord())!,
    ];

    for (const parsed of produced) {
      expect(parsed.links.map((l) => [l.url, l.isChrome])).toEqual([
        ["https://example.com/nav", true],
        ["https://example.com/body", false],
        ["https://example.com/legal", true],
      ]);
    }
  });
});
