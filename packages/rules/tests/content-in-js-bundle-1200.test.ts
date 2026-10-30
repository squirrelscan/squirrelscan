// perf/content-in-js-bundle (#1200): page content compiled into a client chunk.
// Fixtures are synthetic sites shaped like the report that motivated the rule: a
// server-rendered docs site whose entry chunk holds every page's MDX body.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { buildCollectedPageSignal } from "../src/collected-signals";
import { contentInJsBundleRule } from "../src/performance/content-in-js-bundle";
import {
  MAX_CHUNK_CHARS,
  estimateProseShare,
  extractContentSentences,
  normalizeScriptText,
} from "../src/shared/content-in-script";
import type { RuleContext } from "../src/types";

const BASE = "https://example.com";
const KB = 1024;
const pageUrl = (i: number) => `${BASE}/docs/p${i}`;

/** Five distinct, long sentences for page `i`: each a single paragraph of 12+ words. */
const sentencesOf = (i: number): string[] =>
  Array.from(
    { length: 5 },
    (_, j) =>
      `Page ${i} paragraph ${j} explains how the quarterly alpha${i}x${j} pipeline retries failed deliveries with exponential backoff and jitter.`,
  );

const pageHtml = (i: number, opts: { nav?: string[]; footer?: string[]; extra?: string } = {}) =>
  `<!doctype html><html lang="en"><head><title>Page ${i}</title></head><body>
   <nav>${(opts.nav ?? []).map((s) => `<p>${s}</p>`).join("")}</nav>
   <main><h1>Page ${i}</h1>${sentencesOf(i).map((s) => `<p>${s}</p>`).join("")}</main>
   <footer>${(opts.footer ?? []).map((s) => `<p>${s}</p>`).join("")}</footer>${opts.extra ?? ""}</body></html>`;

/** Compiled-MDX-shaped code for the given sentences, padded with minified code to `bytes`. */
const chunkOf = (sentences: string[], bytes: number, encode: (s: string) => string = JSON.stringify): string => {
  const body = sentences.map((s) => `r.jsx("p",{children:${encode(s)}})`).join(",");
  const base = `var a=[${body}];`;
  const filler = "function f(e,t){return e.map(function(n){return n+t})}var q=window.__x;";
  return base + filler.repeat(Math.max(0, Math.ceil((bytes - base.length) / filler.length)));
};

interface Chunk {
  url: string;
  content: string | null;
  pages: string[];
  size?: number;
}

function ctxOf(pages: string[], chunks: Chunk[], engine: "resident" | "streaming", options = {}): RuleContext {
  const parsed = pages.map((html, i) => parsePage(html, pageUrl(i)));
  const base = {
    page: { url: BASE, html: "", statusCode: 200, loadTime: 0, headers: {} },
    options,
    parsed: parsed[0],
    site: {
      baseUrl: BASE,
      pages:
        engine === "resident"
          ? pages.map((_, i) => ({ url: pageUrl(i), statusCode: 200, parsed: parsed[i], sizeBytes: 1000 }))
          : [],
      robotsTxt: null,
      sitemaps: null,
      scripts: chunks.map((c) => ({
        url: c.url,
        status: 200,
        error: null,
        contentType: "application/javascript",
        sizeBytes: c.size ?? (c.content?.length ?? 0),
        content: c.content,
        sourcePages: c.pages,
      })),
    },
  } as unknown as RuleContext;
  if (engine === "resident") return base;
  return {
    ...base,
    collectedSignals: {
      pages: pages.map((_, i) => buildCollectedPageSignal({ url: pageUrl(i), parsed: parsed[i]!, htmlBytes: 1000 })),
    },
  };
}

const engines = ["resident", "streaming"] as const;
const run = async (ctx: RuleContext) => (await contentInJsBundleRule.run(ctx)).checks;
const allPages = (n: number) => Array.from({ length: n }, (_, i) => pageUrl(i));

describe("extractContentSentences", () => {
  test("takes up to five long single-text-node sentences of the main content", () => {
    const doc = parsePage(pageHtml(1), pageUrl(1)).document!;
    expect(extractContentSentences(doc)).toEqual(sentencesOf(1));
  });

  test("leaves out nav, header, footer, aside and form text, and short text", () => {
    const chrome = ["Chrome text that is long enough to count as a sentence of ten words or more here ok."];
    const html = `<html><body><header><p>${chrome[0]}</p></header><nav><p>${chrome[0]}x</p></nav>
      <div><p>${sentencesOf(2)[0]}</p><p>Too short to count.</p></div>
      <aside><p>${chrome[0]}y</p></aside><form><p>${chrome[0]}z</p></form><footer><p>${chrome[0]}w</p></footer></body></html>`;
    expect(extractContentSentences(parsePage(html, pageUrl(2)).document!)).toEqual([sentencesOf(2)[0]]);
  });

  test("text split by inline elements is not one sentence; code blocks are skipped", () => {
    const html = `<html><body><main><p>This sentence has <a href="/x">a link</a> in the middle of it so it splits.</p>
      <pre>${sentencesOf(3)[0]}</pre><code>${sentencesOf(3)[1]}</code></main></body></html>`;
    expect(extractContentSentences(parsePage(html, pageUrl(3)).document!)).toEqual([]);
  });

  test("an empty document (no root element) yields no sentences instead of throwing", () => {
    for (const html of ["", "   ", "just text", "<!-- only a comment -->"]) {
      expect(extractContentSentences(parsePage(html, pageUrl(5)).document!)).toEqual([]);
    }
  });

  test("a page of tens of thousands of nodes is bounded", () => {
    const rows = Array.from({ length: 60_000 }, () => "<i>a</i>").join("");
    const started = performance.now();
    extractContentSentences(parsePage(`<html><body><main>${rows}<p>${sentencesOf(4)[0]}</p></main></body></html>`, pageUrl(4)).document!);
    expect(performance.now() - started).toBeLessThan(3000);
  });
});

describe("normalizeScriptText", () => {
  const sentence = `It's a "quoted" sentence with an ampersand & a snowman \u2603 and the end.`;

  test("JSX and JS escaped quotes", () => {
    expect(normalizeScriptText(String.raw`children:"It\'s a \"quoted\" sentence"`)).toContain(`It's a "quoted" sentence`);
  });

  test("\\n and \\t escapes and line continuations collapse to spaces", () => {
    expect(normalizeScriptText(String.raw`"first line\n\tsecond line\
third"`)).toContain("first line second linethird");
  });

  test("\\u, \\u{} and \\x escapes", () => {
    expect(normalizeScriptText(String.raw`"snow \u2603 man \u{1F600} caf\xe9"`)).toContain("snow \u2603 man \u{1F600} caf\u00e9");
  });

  test("HTML entities, named and numeric", () => {
    expect(normalizeScriptText("a &amp; b &lt;c&gt; &quot;d&quot; it&#39;s &#x2603; &nbsp;x &rsquo;")).toContain(
      `a & b <c> "d" it's \u2603 x \u2019`,
    );
  });

  test("unknown or runaway sequences are left alone", () => {
    expect(normalizeScriptText("&notanentity; a & b \\q")).toBe("&notanentity; a & b q");
  });

  test("a chunk over the cap is not decoded", () => {
    expect(normalizeScriptText("a".repeat(MAX_CHUNK_CHARS + 1))).toBeNull();
    expect(sentence.length).toBeGreaterThan(0);
  });
});

describe("estimateProseShare", () => {
  test("compiled copy scores high and application code scores near zero", () => {
    const prose = normalizeScriptText(chunkOf(Array.from({ length: 40 }, (_, i) => sentencesOf(i).join(" ")), 0))!;
    const code = "function f(e,t){return e.map(function(n){return n+t})}".repeat(2000);
    expect(estimateProseShare(prose)).toBeGreaterThan(0.5);
    expect(estimateProseShare(code)).toBeLessThan(0.02);
  });
});

describe.each(engines)("perf/content-in-js-bundle (%s engine)", (engine) => {
  const pages = (n: number) => Array.from({ length: n }, (_, i) => pageHtml(i));

  test("the page's own content in a 60 KB chunk is flagged with the chunk, sizes and prose share", async () => {
    const chunk = { url: `${BASE}/assets/entry.js`, content: chunkOf(sentencesOf(0), 60 * KB), pages: [pageUrl(0)] };
    const checks = await run(ctxOf(pages(3), [chunk], engine));
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe("warn");
    const item = checks[0]!.items![0]!;
    expect(item.id).toBe(chunk.url);
    expect(item.sourcePages).toEqual([pageUrl(0)]);
    expect(item.meta).toMatchObject({ sizeBytes: chunk.content.length, otherPagesWithContent: 0 });
    expect(typeof (item.meta as { size: string }).size).toBe("string");
    expect((item.meta as { gzipBytes?: number }).gzipBytes).toBeGreaterThan(0);
    expect((item.meta as { gzipBytes: number }).gzipBytes).toBeLessThan(chunk.content.length);
    expect((item.meta as { proseShareEstimate: string }).proseShareEstimate).toMatch(/^\d+%$/);
  });

  test("the whole site's content in the entry chunk escalates and counts the other pages", async () => {
    const all = Array.from({ length: 12 }, (_, i) => sentencesOf(i)).flat();
    const chunk = { url: `${BASE}/assets/entry.js`, content: chunkOf(all, 200 * KB), pages: allPages(12) };
    const checks = await run(ctxOf(pages(12), [chunk], engine));
    expect(checks[0]!.name).toBe("content-in-js-bundle-sitewide");
    expect(checks[0]!.status).toBe("fail");
    expect(checks[0]!.items![0]!.meta).toMatchObject({ pagesWithContent: 12, otherPagesWithContent: 11 });
    expect(checks[0]!.message).toContain("12 pages");
  });

  // The page text holds quotes, an apostrophe and an ampersand; the chunk holds the same text in each form.
  const quoted = (s: string) => s.replace("explains", `explains "it's" Tom & Jerry`);
  test.each([
    ["JSX/JS escaped quotes", (s: string) => JSON.stringify(s).replace(/'/g, "\\'")],
    ["\\n and \\t escapes for spaces", (s: string) => JSON.stringify(s.replace(/ /g, "\n\t"))],
    ["\\u escapes", (s: string) => JSON.stringify(s).replace(/ /g, "\\u0020").replace(/e/g, "\\u0065")],
    ["HTML entities", (s: string) => JSON.stringify(s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/ and /g, " &#x61;nd "))],
  ])("matches through %s", async (_name, encode) => {
    const text = sentencesOf(0).map(quoted);
    const html = pageHtml(0).replace(
      /<main>[\s\S]*<\/main>/,
      `<main><h1>Page 0</h1>${text.map((s) => `<p>${s}</p>`).join("")}</main>`,
    );
    const encoded = text.map((s) => encode(s));
    const content = `var a=[${encoded.map((e) => `r.jsx("p",{children:${e}})`).join(",")}];` + "var z=1;".repeat(8000);
    const checks = await run(
      ctxOf([html, pageHtml(1), pageHtml(2)], [{ url: `${BASE}/e.js`, content, pages: [pageUrl(0)] }], engine),
    );
    expect(checks[0]!.status).toBe("warn");
  });

  test("no finding when the content is only in the HTML and the chunk is hydration state", async () => {
    const hydration = `window.__NEXT_DATA__={"props":{"locale":"en","flags":[1,2,3]}};` + "var z=1;".repeat(9000);
    const checks = await run(
      ctxOf(pages(3), [{ url: `${BASE}/e.js`, content: hydration, pages: allPages(3) }], engine),
    );
    expect(checks[0]!.status).toBe("pass");
  });

  test("no finding for a chunk under 50 KB, however full of content", async () => {
    const checks = await run(
      ctxOf(pages(3), [{ url: `${BASE}/e.js`, content: chunkOf(sentencesOf(0), 40 * KB), pages: [pageUrl(0)] }], engine),
    );
    expect(checks[0]!.status).toBe("pass");
    expect(checks[0]!.message).toContain("No JavaScript chunk large enough");
  });

  test("text that is only in nav or footer (site chrome) is not content", async () => {
    const chrome = [
      "Subscribe to the quarterly newsletter for product updates, release notes and the occasional long essay.",
      "Our offices are open Monday through Friday and the support team answers within one business day or less.",
      "Read the full terms of service and the privacy policy before you create an account on this website today.",
    ];
    const withChrome = Array.from({ length: 3 }, (_, i) => pageHtml(i, { nav: chrome, footer: chrome }));
    const checks = await run(
      ctxOf(withChrome, [{ url: `${BASE}/e.js`, content: chunkOf(chrome, 60 * KB), pages: allPages(3) }], engine),
    );
    expect(checks[0]!.status).toBe("pass");
  });

  test("template text that opens many pages' main content does not count", async () => {
    const shared = Array.from(
      { length: 3 },
      (_, j) => `Shared banner paragraph ${j} that every page repeats in its main area with exactly the same words in order.`,
    );
    const html = (i: number) =>
      `<html><body><main>${shared.map((s) => `<p>${s}</p>`).join("")}<p>${sentencesOf(i)[0]}</p></main></body></html>`;
    const checks = await run(
      ctxOf(
        Array.from({ length: 5 }, (_, i) => html(i)),
        [{ url: `${BASE}/e.js`, content: chunkOf(shared, 60 * KB), pages: allPages(5) }],
        engine,
      ),
    );
    expect(checks[0]!.status).toBe("pass");
  });

  test("a chunk that was not fetched (no content) is skipped", async () => {
    const checks = await run(ctxOf(pages(3), [{ url: `${BASE}/e.js`, content: null, pages: allPages(3), size: 900 * KB }], engine));
    expect(checks[0]!.status).toBe("pass");
  });

  test("a huge chunk is bounded: over the cap it is reported as not searched, quickly", async () => {
    const huge = "a".repeat(MAX_CHUNK_CHARS + 10);
    const started = performance.now();
    const checks = await run(ctxOf(pages(3), [{ url: `${BASE}/huge.js`, content: huge, pages: allPages(3) }], engine));
    expect(performance.now() - started).toBeLessThan(2000);
    expect(checks.find((c) => c.name === "content-in-js-bundle-skipped")?.status).toBe("info");
  });

  test("a large chunk against many pages stays within the page cap", async () => {
    const many = 400;
    const html = Array.from({ length: many }, (_, i) => pageHtml(i));
    const content = chunkOf(sentencesOf(0), 1500 * KB);
    const started = performance.now();
    const checks = await run(
      ctxOf(html, [{ url: `${BASE}/big.js`, content, pages: [pageUrl(0)] }], engine, { max_pages_checked: 50 }),
    );
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(checks[0]!.status).toBe("warn");
  });

  test("no scripts at all passes", async () => {
    const checks = await run(ctxOf(pages(2), [], engine));
    expect(checks[0]!.status).toBe("pass");
  });
});

describe("streaming records from before the field existed", () => {
  test("are reported as not checked, not as clean", async () => {
    const ctx = ctxOf([pageHtml(0), pageHtml(1)], [{ url: `${BASE}/e.js`, content: "x".repeat(60 * KB), pages: [] }], "streaming");
    for (const rec of ctx.collectedSignals!.pages) delete rec.contentSentences;
    const checks = await run(ctx);
    expect(checks[0]!.status).toBe("skipped");
  });
});
