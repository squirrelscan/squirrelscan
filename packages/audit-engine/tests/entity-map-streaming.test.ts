// The builder accumulates incrementally (#2091): pages are folded in as they
// stream and their raw JSON-LD is dropped, because buffering every page's
// markup until the crawl ends is ~100MB on a 10,000-page site.
//
// Buffering was also what bought determinism: the old builder SORTED the pages
// before walking, so "first occurrence" meant "lowest page URL". Streaming
// cannot pre-sort, so these pin the property that replaced it — arrival order
// must not change a single byte of the output.

import { describe, expect, test } from "bun:test";

import { buildEntityMap, createEntityMapBuilder } from "../src/entity-map";
import { createEntityMapCollector } from "../src/entity-map/collect";

const SITE = "https://example.com/";
const AT = "2026-01-01T00:00:00.000Z";

const organization = (logo: string) => ({
  "@context": "https://schema.org",
  "@type": "Organization",
  "@id": "https://example.com/#org",
  name: "Acme",
  logo,
  author: { "@type": "Person", name: "Ada Lovelace" },
});

const PAGES = [
  { url: "https://example.com/c", raw: JSON.stringify(organization("https://example.com/c.png")) },
  { url: "https://example.com/a", raw: JSON.stringify(organization("https://example.com/a.png")) },
  { url: "https://example.com/b", raw: JSON.stringify(organization("https://example.com/b.png")) },
  { url: "https://example.com/empty", raw: null },
];

function streamed(order: typeof PAGES): string {
  const builder = createEntityMapBuilder();
  for (const page of order) builder.addPage(page.url, page.raw);
  return JSON.stringify(builder.finish(SITE, { generatedAt: AT }));
}

describe("incremental builder", () => {
  test("arrival order cannot change the output", () => {
    const forward = streamed(PAGES);
    const reversed = streamed([...PAGES].reverse());
    const shuffled = streamed([PAGES[3]!, PAGES[1]!, PAGES[0]!, PAGES[2]!]);

    expect(reversed).toBe(forward);
    expect(shuffled).toBe(forward);
  });

  test("the canonical value is the lowest page URL, not the first to arrive", () => {
    const builder = createEntityMapBuilder();
    // /c streams first; /a must still win the logo.
    for (const page of PAGES) builder.addPage(page.url, page.raw);
    const map = builder.finish(SITE, { generatedAt: AT });

    const org = map.nodes.find((n) => n.id === "https://example.com/#org")!;
    expect(org.properties.logo).toBe("https://example.com/a.png");
    expect(org.conflicts[0]!.values.map((v) => v.value)).toEqual([
      "https://example.com/a.png",
      "https://example.com/b.png",
      "https://example.com/c.png",
    ]);
  });

  test("the list wrapper and the streaming API agree byte for byte", () => {
    const wrapped = JSON.stringify(buildEntityMap(PAGES, SITE, { generatedAt: AT }));
    expect(streamed(PAGES)).toBe(wrapped);
  });

  test("a repeated URL is counted once, and JSON-LD beats an earlier empty record", () => {
    // A redirect chain can land two crawl records on one final URL, and which
    // one arrives first is not something the site controls.
    const emptyFirst = createEntityMapBuilder();
    emptyFirst.addPage("https://example.com/a", null);
    emptyFirst.addPage("https://example.com/a", PAGES[1]!.raw);
    const a = emptyFirst.finish(SITE, { generatedAt: AT });

    const rawFirst = createEntityMapBuilder();
    rawFirst.addPage("https://example.com/a", PAGES[1]!.raw);
    rawFirst.addPage("https://example.com/a", null);
    const b = rawFirst.finish(SITE, { generatedAt: AT });

    expect(a.summary.pagesTotal).toBe(1);
    expect(b.summary.pagesTotal).toBe(1);
    expect(a.summary.pagesWithoutEntities).toBe(0);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("collector", () => {
  const record = (url: string, raw: string | null, status = 200) => ({
    page: { url, finalUrl: url, status },
    parsed: { schemas: { raw } },
  });

  test("folds batches in and needs no page content afterwards", () => {
    const collector = createEntityMapCollector();
    collector.absorb([record(PAGES[0]!.url, PAGES[0]!.raw)]);
    collector.absorb([record(PAGES[1]!.url, PAGES[1]!.raw)]);
    collector.absorb([record(PAGES[2]!.url, PAGES[2]!.raw)]);
    collector.absorb([record(PAGES[3]!.url, null)]);

    const map = collector.build(SITE, { generatedAt: AT });
    expect(JSON.stringify(map)).toBe(streamed(PAGES));
  });

  test("skips non-2xx pages entirely", () => {
    const collector = createEntityMapCollector();
    collector.absorb([record("https://example.com/gone", PAGES[0]!.raw, 404)]);
    const map = collector.build(SITE, { generatedAt: AT });

    expect(map.summary.pagesTotal).toBe(0);
    expect(map.nodes).toHaveLength(0);
  });

  test("a page with no parsed record still counts as a page", () => {
    const collector = createEntityMapCollector();
    collector.absorb([{ page: { url: SITE, finalUrl: SITE, status: 200 }, parsed: null }]);
    const map = collector.build(SITE, { generatedAt: AT });

    expect(map.summary.pagesTotal).toBe(1);
    expect(map.summary.pagesWithoutEntities).toBe(1);
  });
});
