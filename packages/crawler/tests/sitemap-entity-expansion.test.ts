// The entity-expansion mitigation for sitemap parsing is a single line —
// `processEntities: false` in the XMLParser options — with nothing pinning it.
// Deleting it is a small, innocuous-looking change, so these tests make it loud.
//
// Sitemaps are fully attacker-controlled: any audited site can serve one, and
// the cloud workers parse them for user-supplied URLs.
//
// VERIFIED BY A/B: flipping the flag to `true` fails exactly the first test
// below. The two "parser does not do this" tests pass either way, because
// fast-xml-parser never resolves external entities or nested chains at all —
// they are NOT guards on our flag, and are labelled accordingly. They earn their
// place by catching a PARSER SWAP to something that does resolve them, which is
// the more likely way this protection would be lost.

import { describe, expect, test } from "bun:test";

import { parseSitemap } from "../src/sitemaps";

const SITEMAP_URL = "https://example.com/sitemap.xml";

describe("sitemap entity expansion", () => {
  // THE guard on `processEntities: false`. This one fails if the flag flips.
  test("a declared entity is not substituted into the parsed loc", () => {
    const xml = `<?xml version="1.0"?>
<!DOCTYPE urlset [<!ENTITY inject "injected-value">]>
<urlset>
  <url><loc>https://example.com/&inject;</loc></url>
</urlset>`;

    const result = parseSitemap(xml, SITEMAP_URL);

    expect(JSON.stringify(result)).not.toContain("injected-value");
  });

  // Not a flag guard — fast-xml-parser does not expand nested entities even with
  // entities enabled. Guards against swapping in a parser that does.
  test("parser-level: a nested entity chain does not expand", () => {
    const xml = `<?xml version="1.0"?>
<!DOCTYPE urlset [
  <!ENTITY a "aaaaaaaaaa">
  <!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">
  <!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">
]>
<urlset>
  <url><loc>https://example.com/&c;</loc></url>
</urlset>`;

    const result = parseSitemap(xml, SITEMAP_URL);

    // 100 consecutive 'a' would mean &c; expanded at least two levels deep.
    expect(JSON.stringify(result)).not.toMatch(/a{100}/);
  });

  // Not a flag guard either — same rationale as above.
  test("parser-level: an external entity naming a local file is not resolved", () => {
    const xml = `<?xml version="1.0"?>
<!DOCTYPE urlset [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<urlset>
  <url><loc>https://example.com/&xxe;</loc></url>
</urlset>`;

    const result = parseSitemap(xml, SITEMAP_URL);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("root:");
    expect(serialized).not.toContain("/bin/");
  });

  test("ordinary sitemaps still parse", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/a</loc></url>
  <url><loc>https://example.com/b</loc></url>
</urlset>`;

    const result = parseSitemap(xml, SITEMAP_URL);

    expect(result.urls.map((u) => u.loc)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });

  // The other half of the guard above: `processEntities: false` also suppresses
  // the five XML predefined escapes, so they are decoded after parsing. Declared
  // entities stay unexpanded (first test) while a legitimate `&amp;` in a query
  // string reaches the crawler as `&`. Escape coverage: sitemap-xml-escapes.test.ts.
  test("predefined XML escapes are decoded", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset>
  <url><loc>https://example.com/search?q=1&amp;page=2</loc></url>
</urlset>`;

    const result = parseSitemap(xml, SITEMAP_URL);

    expect(result.urls[0]?.loc).toBe("https://example.com/search?q=1&page=2");
  });
});
