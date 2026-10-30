// #1332: a page over the parse cap is never parsed by buildSiteContext, whichever pass asks.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { generateSiteModel, writeCrawlToStorage } from "@squirrelscan/synthetic-site";

import { buildSiteContext } from "../src/adapter";

const run = <A>(eff: Effect.Effect<A, unknown, never>): Promise<A> => Effect.runPromise(eff as Effect.Effect<A, never, never>);

describe("buildSiteContext parse cap", () => {
  test("pages over the cap come back unparsed, the rest are parsed as before", async () => {
    const { storage, crawlId } = await writeCrawlToStorage(generateSiteModel({ seed: 4, pageCount: 6 }), ":memory:");
    const pages = await run(storage.getPages(crawlId));
    const html = pages.filter((p) => p.html && p.contentType?.includes("html"));
    expect(html.length).toBeGreaterThan(1);
    const sizes = html.map((p) => p.sizeBytes ?? p.html!.length).sort((a, b) => a - b);
    const cap = sizes[Math.floor(sizes.length / 2)]!;

    const capped = await run(buildSiteContext(pages, undefined, { maxParseBytes: cap }));
    const uncapped = await run(buildSiteContext(pages));
    for (const [i, entry] of capped.entries()) {
      const size = entry.page.sizeBytes ?? entry.page.html?.length ?? 0;
      if (size > cap) expect(entry.parsed).toBeNull();
      else expect(entry.parsed === null).toBe(uncapped[i]!.parsed === null);
    }
    expect(capped.filter((e) => e.parsed !== null).length).toBeLessThan(uncapped.filter((e) => e.parsed !== null).length);
    await run(storage.close());
  });
});
