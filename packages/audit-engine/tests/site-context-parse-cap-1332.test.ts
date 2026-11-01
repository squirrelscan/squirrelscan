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

  test("a page whose recorded size is the small encoded size but whose body is over the cap is not parsed", async () => {
    const { storage, crawlId } = await writeCrawlToStorage(generateSiteModel({ seed: 4, pageCount: 3 }), ":memory:");
    const [first] = await run(storage.getPages(crawlId));
    const body = `<!doctype html><html><head><title>t</title></head><body>${"<p>x</p>".repeat(20_000)}</body></html>`;
    const inflated = { ...first!, contentType: "text/html", html: body, sizeBytes: 900 }; // Content-Length of the gzip body
    const [entry] = await run(buildSiteContext([inflated], undefined, { maxParseBytes: 64 * 1024 }));
    expect(entry!.parsed).toBeNull();
    // and under the cap the same shape is parsed
    const small = { ...inflated, html: "<!doctype html><html><head><title>t</title></head><body><p>x</p></body></html>", sizeBytes: 900 };
    const [parsed] = await run(buildSiteContext([small], undefined, { maxParseBytes: 64 * 1024 }));
    expect(parsed!.parsed).not.toBeNull();
    await run(storage.close());
  });

  test("the boundary and a multi-byte body: exactly the cap parses, one byte more does not, and bytes are counted not characters", async () => {
    const { storage, crawlId } = await writeCrawlToStorage(generateSiteModel({ seed: 4, pageCount: 3 }), ":memory:");
    const [first] = await run(storage.getPages(crawlId));
    const CAP = 64 * 1024;
    const page = (html: string) => ({ ...first!, contentType: "text/html", html, sizeBytes: 900 });
    const shell = "<!doctype html><html><head><title>t</title></head><body><p></p></body></html>";
    const exact = (bytes: number): string => shell.replace("<p></p>", `<p>${"x".repeat(bytes - Buffer.byteLength(shell))}</p>`);
    const [atCap, over] = await run(buildSiteContext([page(exact(CAP)), page(exact(CAP + 1))], undefined, { maxParseBytes: CAP }));
    expect(atCap!.parsed).not.toBeNull();
    expect(over!.parsed).toBeNull();
    // 30,000 three-byte characters are 30 K characters and 90 KB of bytes
    const wide = shell.replace("<p></p>", `<p>${"\u4e2d".repeat(30_000)}</p>`);
    expect(wide.length).toBeLessThan(CAP);
    const [multi] = await run(buildSiteContext([page(wide)], undefined, { maxParseBytes: CAP }));
    expect(multi!.parsed).toBeNull();
    await run(storage.close());
  });
});
