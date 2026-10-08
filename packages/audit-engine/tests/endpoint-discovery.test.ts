// Engine side of the endpoint discovery pass: the page-time collector, technology
// detection for convention paths, rule-cache replay, the retained cap, and the
// guarantee that the pass sends no request. The no-request test is a tripwire on
// the collector and the fold (including technology detection); the pass has no
// other code path, so it is the whole pass.

import { afterEach, describe, expect, test } from "bun:test";

import type { PageRecord } from "@squirrelscan/core-contracts";

import { buildHeadersMap, parseHtmlForRules } from "../src/adapter";
import {
  createEndpointCollector,
  MAX_RETAINED_CROSS_ORIGIN_REFS,
  MAX_RETAINED_REFS,
} from "../src/endpoint-discovery";

const ORIGIN = "https://example.com";

function pageOf(path: string, html: string, headers: Record<string, string> = {}): PageRecord {
  const url = `${ORIGIN}${path}`;
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    status: 200,
    html,
    headers: { contentType: "text/html", ...headers },
    securityHeaders: {},
  } as unknown as PageRecord;
}

function collect(collector: ReturnType<typeof createEndpointCollector>, page: PageRecord) {
  return collector.collect(page, parseHtmlForRules(page.html ?? "", page.finalUrl));
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("endpoint discovery collector", () => {
  test("detects the stack on the entry page and adds its convention paths", () => {
    const c = createEndpointCollector({ headersOf: buildHeadersMap });
    collect(
      c,
      pageOf(
        "/",
        `<html><head><script id="__NEXT_DATA__" type="application/json">{}</script></head><body>hi</body></html>`
      )
    );
    const surface = c.finish({ baseUrl: `${ORIGIN}/`, scripts: [] });
    const conventions = surface.candidates.filter((x) => x.source === "convention");
    expect(conventions.map((x) => x.discoveredVia)).toEqual([
      "convention:nextjs",
      "convention:nextjs",
    ]);
    expect(conventions.map((x) => new URL(x.url).pathname).sort()).toEqual([
      "/api/graphql",
      "/api/health",
    ]);
  });

  test("a site with no recognised stack gets no convention paths", () => {
    const c = createEndpointCollector({ headersOf: buildHeadersMap });
    collect(c, pageOf("/", "<html><body>plain</body></html>"));
    expect(c.finish({ baseUrl: `${ORIGIN}/`, scripts: [] }).candidates).toEqual([]);
  });

  test("extracts from page HTML and from served scripts into one deduped list", () => {
    const c = createEndpointCollector({ headersOf: buildHeadersMap });
    collect(
      c,
      pageOf(
        "/",
        `<html><body><form action="/api/contact" method="post"></form>
         <script>fetch("/api/inline")</script></body></html>`
      )
    );
    const surface = c.finish({
      baseUrl: `${ORIGIN}/`,
      scripts: [
        {
          url: `${ORIGIN}/app.js`,
          content: `axios.get("/api/inline"); fetch("https://api.vendor.io/v1/x")`,
        },
      ] as never,
    });
    expect(surface.candidates.map((x) => `${x.method ?? "-"} ${x.url} ${x.source} ${x.probeEligible}`).sort()).toEqual(
      [
        "GET https://example.com/api/inline static-js true",
        "GET https://api.vendor.io/v1/x static-js false",
        "POST https://example.com/api/contact static-html true",
      ].sort()
    );
  });

  test("a replayed page contributes what a fresh page did, including the stack", () => {
    const html = `<html><head><script id="__NEXT_DATA__" type="application/json">{}</script></head><body><script>fetch("/api/a")</script></body></html>`;
    const fresh = createEndpointCollector({ headersOf: buildHeadersMap });
    const snapshot = collect(fresh, pageOf("/", html));

    const replayed = createEndpointCollector({ headersOf: buildHeadersMap });
    // The cache stores snapshots as JSON.
    replayed.replay!(pageOf("/", html), JSON.parse(JSON.stringify(snapshot)));
    const site = { baseUrl: `${ORIGIN}/`, scripts: [] };
    expect(replayed.finish(site)).toEqual(fresh.finish(site));
  });

  test("convention paths survive when a non-entry page is seen first or a replayed snapshot has no stack", () => {
    const next = `<html><head><script id="__NEXT_DATA__" type="application/json">{}</script></head><body></body></html>`;
    const c = createEndpointCollector({ headersOf: buildHeadersMap });
    // The first page seen is not the entry page and shows no stack.
    c.replay!(pageOf("/deep", "<html></html>"), { pageUrl: `${ORIGIN}/deep`, refs: [] });
    c.replay!(pageOf("/", next), {
      pageUrl: `${ORIGIN}/`,
      refs: [],
      techIds: ["nextjs"],
    });
    const site = { baseUrl: `${ORIGIN}/`, scripts: [] };
    expect(c.finish(site).candidates.map((x) => x.discoveredVia)).toContain("convention:nextjs");
  });

  test("when the entry page replays without a stack result, the next fresh page runs detection", () => {
    const next = `<html><head><script id="__NEXT_DATA__" type="application/json">{}</script></head><body></body></html>`;
    const c = createEndpointCollector({ headersOf: buildHeadersMap });
    // A snapshot from an older run: it never ran detection, so techIds is absent.
    c.replay!(pageOf("/", next), { pageUrl: `${ORIGIN}/`, refs: [] });
    collect(c, pageOf("/blog", next));
    const site = { baseUrl: `${ORIGIN}/`, scripts: [] };
    expect(c.finish(site).candidates.map((x) => x.discoveredVia)).toContain("convention:nextjs");
  });

  test("a detection that found nothing is recorded as empty and is not run again", () => {
    const c = createEndpointCollector({ headersOf: buildHeadersMap });
    expect(collect(c, pageOf("/", "<html></html>")).techIds).toEqual([]);
    expect(collect(c, pageOf("/b", "<html></html>")).techIds).toBeUndefined();
  });

  test("a method-carrying ref is kept ahead of bare literals once the retained cap is spent", () => {
    const c = createEndpointCollector({ headersOf: buildHeadersMap });
    // 2,500 bare literals first (25 pages at the 100-per-page extractor cap), then
    // one fetch call site with a lexically late URL.
    for (let p = 0; p < 25; p++) {
      const bare = Array.from({ length: 100 }, (_, i) => `var a${i} = "/api/a${String(p * 100 + i).padStart(4, "0")}";`).join("");
      collect(c, pageOf(p === 0 ? "/" : `/b${p}`, `<html><body><script>${bare}</script></body></html>`));
    }
    collect(c, pageOf("/late", `<html><body><script>fetch("/api/zzz")</script></body></html>`));
    const kept = c.retained();
    expect(kept.length).toBe(MAX_RETAINED_REFS);
    expect(kept.some((r) => r.method === "GET" && r.url === "https://example.com/api/zzz")).toBe(true);
  });

  test("the retained set and the surface do not depend on crawl order or cache replay split", () => {
    // 60 pages, 3,000 distinct same-origin refs (past the 2,000 cap) and 500
    // cross-origin refs (past the 300 cap), each page carrying a slice of both.
    const pagesHtml = Array.from({ length: 60 }, (_, p) => {
      const same = Array.from({ length: 50 }, (_, i) => `fetch("/api/s${String(p * 50 + i).padStart(4, "0")}");`);
      const other = Array.from({ length: 9 }, (_, i) => `fetch("https://api.vendor.io/v1/c${String(p * 9 + i).padStart(4, "0")}");`);
      return { path: p === 0 ? "/" : `/p${p}`, html: `<html><body><script>${[...same, ...other].join("")}</script></body></html>` };
    });
    const run = (order: number[], replayFrom?: Map<string, unknown>) => {
      const c = createEndpointCollector({ headersOf: buildHeadersMap });
      for (const idx of order) {
        const pg = pagesHtml[idx];
        const page = pageOf(pg.path, pg.html);
        const snap = replayFrom?.get(pg.path);
        if (snap) c.replay!(page, snap);
        else collect(c, page);
      }
      return c;
    };
    const forward = pagesHtml.map((_, i) => i);
    const reversed = [...forward].reverse();
    // A seeded shuffle, so the test is reproducible.
    let seed = 12345;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const shuffled = [...forward].sort(() => rand() - 0.5);

    const base = run(forward);
    const site = { baseUrl: `${ORIGIN}/`, scripts: [] };
    const baseRefs = base.retained();
    const baseSurface = base.finish(site);
    expect(baseRefs.filter((r) => new URL(r.url).hostname === "api.vendor.io").length).toBe(MAX_RETAINED_CROSS_ORIGIN_REFS);
    expect(baseRefs.length).toBe(MAX_RETAINED_REFS + MAX_RETAINED_CROSS_ORIGIN_REFS);

    for (const order of [reversed, shuffled]) {
      const other = run(order);
      expect(other.retained()).toEqual(baseRefs);
      expect(other.finish(site)).toEqual(baseSurface);
    }

    // Half the pages replay from cached snapshots, the rest run fresh.
    const snaps = new Map<string, unknown>();
    for (const [i, pg] of pagesHtml.entries()) {
      if (i % 2 === 0) snaps.set(pg.path, collect(createEndpointCollector({ headersOf: buildHeadersMap }), pageOf(pg.path, pg.html)));
    }
    const mixed = run(shuffled, snaps);
    expect(mixed.retained()).toEqual(baseRefs);
    expect(mixed.finish(site)).toEqual(baseSurface);
  });

  test("retained refs are capped across the crawl", () => {
    const c = createEndpointCollector({ headersOf: buildHeadersMap });
    for (let p = 0; p < 40; p++) {
      const calls = Array.from({ length: 90 }, (_, i) => `fetch("/api/p${p}/r${i}");`).join("");
      collect(c, pageOf(`/p${p}`, `<html><body><script>${calls}</script></body></html>`));
    }
    const retained = c.retained().length;
    expect(retained).toBeLessThanOrEqual(MAX_RETAINED_REFS);
    expect(c.finish({ baseUrl: `${ORIGIN}/`, scripts: [] }).candidates.length).toBeLessThanOrEqual(200);
  });

  test("the pass makes no network request", () => {
    let calls = 0;
    globalThis.fetch = (() => {
      calls++;
      throw new Error("endpoint discovery must not fetch");
    }) as unknown as typeof fetch;

    const c = createEndpointCollector({ headersOf: buildHeadersMap });
    for (let p = 0; p < 50; p++) {
      collect(
        c,
        pageOf(
          p === 0 ? "/" : `/p${p}`,
          `<html><head><script id="__NEXT_DATA__" type="application/json">{}</script></head>
           <body><form action="/api/f${p}"></form><script>fetch("/api/${p}")</script></body></html>`
        )
      );
    }
    c.finish({
      baseUrl: `${ORIGIN}/`,
      scripts: [{ url: `${ORIGIN}/a.js`, content: `fetch("/graphql")` }] as never,
    });
    expect(calls).toBe(0);
  });
});
