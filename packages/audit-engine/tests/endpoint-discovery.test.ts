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

  test("a bare literal does not spend the retained cap once its URL has a method", () => {
    const c = createEndpointCollector({ headersOf: buildHeadersMap });
    collect(c, pageOf("/", `<html><body><script>fetch("/api/a"); var x = "/api/a";</script></body></html>`));
    collect(c, pageOf("/p", `<html><body><script>var y = "/api/a";</script></body></html>`));
    const kept = c.pages.flatMap((p) => p.refs.map((r) => `${r.method ?? "-"} ${r.url}`));
    expect(kept).toEqual(["GET https://example.com/api/a"]);
  });

  test("retained refs are capped across the crawl", () => {
    const c = createEndpointCollector({ headersOf: buildHeadersMap });
    for (let p = 0; p < 40; p++) {
      const calls = Array.from({ length: 90 }, (_, i) => `fetch("/api/p${p}/r${i}");`).join("");
      collect(c, pageOf(`/p${p}`, `<html><body><script>${calls}</script></body></html>`));
    }
    const retained = c.pages.reduce((n, p) => n + p.refs.length, 0);
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
