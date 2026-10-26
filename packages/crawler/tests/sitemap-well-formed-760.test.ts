// #760: fast-xml-parser reads past a mismatched closing tag, an element left
// open and a raw `&`, so crawl/sitemap-valid passed a sitemap a strict
// consumer rejects. parseSitemap now reports the first well-formedness error,
// and still reads the URLs it can.

import { describe, expect, test } from "bun:test";

import { decodeSitemapBody, parseSitemap, SITEMAP_NOT_WELL_FORMED_ERROR } from "../src/sitemaps";

const URL = "https://example.com/sitemap.xml";
const HEAD =
  '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" ' +
  'xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">';

describe("sitemap well-formedness (#760)", () => {
  test("a mismatched closing tag is reported and the readable URLs are kept", () => {
    const data = parseSitemap(
      `${HEAD}<url><loc>https://example.com/a</loc></lox></url><url><loc>https://example.com/b</loc></url></urlset>`,
      URL,
    );
    expect(data.errors).toHaveLength(1);
    expect(data.errors[0]).toStartWith(`${SITEMAP_NOT_WELL_FORMED_ERROR}: Expected closing tag 'url'`);
    expect(data.errors[0]).toContain("instead of closing tag 'lox'");
    expect(data.urls.map((u) => u.loc)).toContain("https://example.com/a");
  });

  test("an unclosed element is reported", () => {
    const data = parseSitemap(`${HEAD}<url><loc>https://example.com/a</loc></urlset>`, URL);
    expect(data.errors).toEqual([
      expect.stringMatching(/^XML is not well formed: Expected closing tag 'url' .*\(line 1, column \d+\)$/),
    ]);
    expect(data.urls.map((u) => u.loc)).toEqual(["https://example.com/a"]);
  });

  test("a raw & in a <loc> is reported and the URL is still read", () => {
    const data = parseSitemap(`${HEAD}<url><loc>https://example.com/a?x=1&y=2</loc></url></urlset>`, URL);
    expect(data.errors).toEqual([expect.stringMatching(/^XML is not well formed: char '&' is not expected\./)]);
    expect(data.urls.map((u) => u.loc)).toEqual(["https://example.com/a?x=1&y=2"]);
  });

  test("an error's position is in the body as served, past leading whitespace", () => {
    const data = parseSitemap(`\n\n  ${HEAD}\n<url><loc>https://example.com/a</loc></lox></url></urlset>`, URL);
    expect(data.errors[0]).toMatch(/\(line 4, column \d+\)$/);
    // The position inside the validator's message moves with it.
    const opened = parseSitemap(`\r\n\r\n  ${HEAD}<url><loc>https://example.com/a</loc></urlset>`, URL);
    expect(opened.errors[0]).toMatch(/opened in line 3, col \d+/);
  });

  test("a file that declares its own entities is not checked", () => {
    // The validator misreads a quoted `>` in the subset and long entity names.
    for (const prolog of [
      '<!DOCTYPE urlset [<!ENTITY gtchar ">">]>',
      '<!-- e.g. <urlset> --><!DOCTYPE urlset [<!ENTITY gtchar ">">]>',
    ]) {
      const body =
        `<?xml version="1.0"?>${prolog}` +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/a</loc></url></urlset>';
      expect(parseSitemap(body, URL).errors).toEqual([]);
    }
    const withReference =
      '<?xml version="1.0"?><!DOCTYPE urlset [<!ENTITY averyveryverylongentityname "x">]>' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/&averyveryverylongentityname;</loc></url></urlset>';
    expect(parseSitemap(withReference, URL).errors.filter((e) => e.startsWith(SITEMAP_NOT_WELL_FORMED_ERROR))).toEqual([]);
  });

  test("a well-formedness error does not make a page-labelled body a page", () => {
    // Opens with another element, so the walk weighs its Content-Type; its URLs
    // were read and stay read.
    const decoded = decodeSitemapBody(
      new TextEncoder().encode(
        '<other></other><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/a</loc></url></urlset>',
      ),
      URL,
      "text/html",
    );
    expect(decoded.notASitemap).toBeFalsy();
    expect(decoded.data.urls.map((u) => u.loc)).toEqual(["https://example.com/a"]);
  });

  test("well-formed sitemaps get no new error: CDATA, comments, extensions, escapes, leading whitespace", () => {
    for (const body of [
      `${HEAD}<url><loc><![CDATA[https://example.com/a?x=1&y=2]]></loc></url></urlset>`,
      `${HEAD}<!-- generated --><url><loc>https://example.com/a</loc>` +
        '<xhtml:link rel="alternate" hreflang="de" href="https://example.com/de"/>' +
        "<image:image><image:loc>https://example.com/i.png</image:loc></image:image></url></urlset>",
      `${HEAD}<url><loc>https://example.com/a?x=1&amp;y=2&#38;z=3</loc></url></urlset>`,
      `\n  ${HEAD}<url><loc>https://example.com/a</loc></url></urlset>`,
      `﻿${HEAD}<url><loc>https://example.com/a</loc></url></urlset>`,
      '<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
        "<sitemap><loc>https://example.com/s1.xml</loc><lastmod>2024-09-10</lastmod></sitemap></sitemapindex>",
    ]) {
      expect(parseSitemap(body, URL).errors).toEqual([]);
    }
  });

  test("the check stays linear in the body size", () => {
    const entry = (i: number) =>
      `<url><loc>https://example.com/p/${i}?a=1&amp;b=2</loc><lastmod>2024-09-10T12:00:00+00:00</lastmod></url>\n`;
    const body = (bytes: number) => {
      const parts = [HEAD];
      for (let i = 0, size = 0; size < bytes; i++) {
        const e = entry(i);
        parts.push(e);
        size += e.length;
      }
      parts.push("</urlset>");
      return parts.join("");
    };
    const time = (text: string) => {
      let best = Number.POSITIVE_INFINITY;
      for (let run = 0; run < 2; run++) {
        const started = performance.now();
        parseSitemap(text, URL);
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };
    const small = time(body(1_000_000));
    const large = time(body(4_000_000));
    // Linear is about 4x; quadratic would be about 16x.
    expect(large).toBeLessThan(small * 8 + 50);
    // A body of repeated DOCTYPE openers is read once.
    const doctypes = (n: number) => `${HEAD}${"<!DOCTYPE x ".repeat(n)}</urlset>`;
    const fewDoctypes = time(doctypes(100_000));
    const manyDoctypes = time(doctypes(400_000));
    expect(manyDoctypes).toBeLessThan(fewDoctypes * 8 + 50);
  }, 60_000);
});
