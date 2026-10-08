// Endpoint discovery pass: extraction from served JS and HTML, convention paths,
// dedup, same-origin flagging and the cap. Pure functions, no network.

import { describe, expect, test } from "bun:test";

import { parseHTML } from "@squirrelscan/parser/dom";

import {
  buildEndpointSurface,
  CONVENTION_PATHS,
  extractEndpointRefsFromDocument,
  extractEndpointRefsFromScript,
  MAX_CROSS_ORIGIN_CANDIDATES,
  MAX_ENDPOINT_CANDIDATES,
  MAX_SCRIPT_SCAN_CHARS,
  MAX_SCRIPTS_SCANNED,
  type PageEndpointRefs,
} from "../src/endpoint-surface";
import { RuleRunner } from "../src/runner";
import type { Rule, RuleContext } from "../src/types";

const BASE = "https://example.com/";

function docOf(html: string): Document {
  return parseHTML(html).document as unknown as Document;
}

function viaOf(refs: { url: string; method?: string; discoveredVia: string }[]) {
  return refs.map((r) => `${r.method ?? "-"} ${r.url} ${r.discoveredVia}`).sort();
}

describe("endpoint extraction from served JS", () => {
  test("extracts candidates from fetch, axios, XHR and $.ajax call sites with their methods", () => {
    const js = `
      fetch("/api/users");
      fetch('/api/orders', { headers: {}, method: 'POST' });
      axios.get("/api/v2/items");
      axios.delete('/api/v2/items/1');
      const x = new XMLHttpRequest(); x.open("PUT", "/rest/v1/profiles");
      $.ajax({ headers: { a: 1 }, url: "/legacy/search", data: {}, type: "POST" });
      $.post("/api/login");
      jQuery.getJSON("/api/feed.json");
    `;
    const refs = extractEndpointRefsFromScript(js, "https://example.com/app.js");
    expect(viaOf(refs)).toEqual(
      [
        "GET https://example.com/api/users fetch",
        "POST https://example.com/api/orders fetch",
        "GET https://example.com/api/v2/items axios.get",
        "DELETE https://example.com/api/v2/items/1 axios.delete",
        "PUT https://example.com/rest/v1/profiles xhr.open",
        "POST https://example.com/legacy/search $.ajax",
        "POST https://example.com/api/login $.post",
        "GET https://example.com/api/feed.json $.getJSON",
        // The same URLs also appear as bare literals; those are kept here, folded later.
        "- https://example.com/api/users string-literal",
        "- https://example.com/api/orders string-literal",
        "- https://example.com/api/v2/items string-literal",
        "- https://example.com/api/v2/items/1 string-literal",
        "- https://example.com/rest/v1/profiles string-literal",
        "- https://example.com/api/login string-literal",
        "- https://example.com/api/feed.json string-literal",
      ].sort()
    );
  });

  test("extracts endpoint-looking string literals: /api, /graphql, supabase, next data, trpc, API hosts", () => {
    const js = `
      const a = "/api/health", b = '/graphql', c = "/rest/v1/todos?select=*".replace("*", "id");
      const d = "/_next/data/abc123/en/index.json", e = "/api/trpc/post.list";
      const f = "https://api.example.org/v3/things", g = "https://proj.supabase.co/rest/v1/";
      const notApi = "/about", asset = "/api/logo.png", tpl = "/api/\${id}", prose = "see /api docs";
    `;
    const urls = extractEndpointRefsFromScript(js, "https://example.com/app.js").map((r) => r.url);
    expect(urls.sort()).toEqual(
      [
        "https://example.com/api/health",
        "https://example.com/graphql",
        "https://example.com/_next/data/abc123/en/index.json",
        "https://example.com/api/trpc/post.list",
        "https://api.example.org/v3/things",
        "https://proj.supabase.co/rest/v1/",
      ].sort()
    );
  });

  test("a relative URL without a leading slash is not a candidate (its base depends on the page path)", () => {
    const refs = extractEndpointRefsFromScript(`fetch("api/users"); axios.get("v1/items")`, "https://example.com/app.js");
    expect(refs).toEqual([]);
  });

  test("a literal inside a runaway script is bounded: quote-dense input stays linear", () => {
    const hostiles = [
      `'a`.repeat(300_000) + `fetch("/api/ok")`,
      `fetch("/a",{{{x}}}`.repeat(25_000),
      `$.ajax({url:"/a",` + "{a}".repeat(150_000),
      "$.ajax({".repeat(60_000),
      `$.ajax({url:"/a",{x}{x}`.repeat(20_000),
    ];
    for (const hostile of hostiles) {
      const t0 = performance.now();
      extractEndpointRefsFromScript(hostile, "https://example.com/app.js");
      expect(performance.now() - t0).toBeLessThan(1500);
    }
  });
});

describe("endpoint extraction from HTML", () => {
  test("reads inline scripts, form actions, and link and script URLs that point at an API", () => {
    const doc = docOf(`<html><head>
      <link rel="preconnect" href="https://api.example.org/">
      <link rel="stylesheet" href="/style.css">
      <script src="https://gql.example.net/client.js"></script>
      <script src="/static/app.js"></script>
      <script>fetch("/api/inline")</script>
      <script type="application/ld+json">{"url":"/api/not-code"}</script>
    </head><body>
      <form action="/api/subscribe" method="post"></form>
      <form action="/search"></form>
    </body></html>`);
    expect(viaOf(extractEndpointRefsFromDocument(doc, "https://example.com/page"))).toEqual(
      [
        "POST https://example.com/api/subscribe form-action",
        "- https://api.example.org/ link-href",
        "- https://gql.example.net/client.js script-src",
        "GET https://example.com/api/inline fetch",
        "- https://example.com/api/inline string-literal",
      ].sort()
    );
  });
});

describe("endpoint surface fold", () => {
  const pages = (refs: PageEndpointRefs["refs"]): PageEndpointRefs[] => [{ pageUrl: BASE, refs }];

  test("adds convention paths per detected stack, and none for an unknown stack", () => {
    const next = buildEndpointSurface({ baseUrl: BASE, pages: [], techIds: ["nextjs", "react"] });
    expect(next.candidates.map((c) => c.url).sort()).toEqual(
      CONVENTION_PATHS.nextjs.map((p) => `https://example.com${p}`).sort()
    );
    expect(next.candidates.every((c) => c.source === "convention" && c.method === "GET")).toBe(true);
    expect(next.candidates[0].discoveredVia).toBe("convention:nextjs");

    const none = buildEndpointSurface({ baseUrl: BASE, pages: [], techIds: ["react"] });
    expect(none.candidates).toEqual([]);
  });

  test("dedupes across sources, drops a method-less record when the URL has a method, and keeps shape", () => {
    const surface = buildEndpointSurface({
      baseUrl: BASE,
      pages: pages([
        { url: "https://example.com/api/users", discoveredVia: "string-literal" },
        { url: "https://example.com/api/users#frag", method: "GET", discoveredVia: "fetch" },
        { url: "https://example.com/api/users", method: "GET", discoveredVia: "form-action" },
      ]),
      scripts: [
        {
          url: "https://example.com/app.js",
          content: `fetch("/api/users"); axios.post("/api/users")`,
        },
      ],
    });
    expect(surface.candidates.map((c) => [c.method, c.url, c.source, c.discoveredVia])).toEqual([
      ["GET", "https://example.com/api/users", "static-js", "fetch"],
      ["POST", "https://example.com/api/users", "static-js", "axios.post"],
    ]);
    expect(Object.keys(surface.candidates[0]).sort()).toEqual(
      ["discoveredVia", "method", "probeEligible", "sameOrigin", "source", "url"].sort()
    );
  });

  test("records cross-origin endpoints but marks them not probe-eligible", () => {
    const surface = buildEndpointSurface({
      baseUrl: BASE,
      pages: pages([
        { url: "https://api.vendor.io/v1/data", method: "GET", discoveredVia: "fetch" },
        { url: "https://example.com/api/mine", method: "GET", discoveredVia: "fetch" },
        { url: "http://example.com/api/other-scheme", method: "GET", discoveredVia: "fetch" },
      ]),
    });
    const byUrl = new Map(surface.candidates.map((c) => [c.url, c]));
    expect(byUrl.get("https://api.vendor.io/v1/data")).toMatchObject({
      sameOrigin: false,
      probeEligible: false,
    });
    expect(byUrl.get("https://example.com/api/mine")).toMatchObject({
      sameOrigin: true,
      probeEligible: true,
    });
    // A different scheme is a different origin.
    expect(byUrl.get("http://example.com/api/other-scheme")?.probeEligible).toBe(false);
  });

  test("an origin that differs by www, port or scheme is never probe-eligible, and the cross-origin cap holds with same-origin entries present", () => {
    const refs = [
      "https://www.example.com/api/a",
      "https://example.com:8443/api/b",
      "http://example.com/api/c",
      ...Array.from({ length: 80 }, (_, i) => `https://api.vendor.io/v1/r${i}`),
      "https://example.com/api/mine",
    ].map((url) => ({ url, method: "GET", discoveredVia: "fetch" }));
    const surface = buildEndpointSurface({ baseUrl: BASE, pages: pages(refs) });
    const eligible = surface.candidates.filter((c) => c.probeEligible).map((c) => c.url);
    expect(eligible).toEqual(["https://example.com/api/mine"]);
    expect(surface.candidates.filter((c) => !c.sameOrigin).length).toBe(MAX_CROSS_ORIGIN_CANDIDATES);
    expect(surface.truncated).toBe(true);
  });

  test("skips third-party scripts: their root-relative literals are not this website's endpoints", () => {
    const surface = buildEndpointSurface({
      baseUrl: BASE,
      pages: [],
      scripts: [{ url: "https://cdn.vendor.io/sdk.js", content: `fetch("/api/track")` }],
    });
    expect(surface.candidates).toEqual([]);
  });

  test("caps the list, keeps cross-origin to its own cap, and is stable under input order", () => {
    const same = Array.from({ length: 400 }, (_, i) => ({
      url: `https://example.com/api/r${String(i).padStart(3, "0")}`,
      method: "GET",
      discoveredVia: "fetch",
    }));
    const cross = Array.from({ length: 120 }, (_, i) => ({
      url: `https://api.vendor.io/v1/r${i}`,
      method: "GET",
      discoveredVia: "fetch",
    }));
    const a = buildEndpointSurface({ baseUrl: BASE, pages: pages([...cross, ...same]) });
    const b = buildEndpointSurface({ baseUrl: BASE, pages: pages([...same, ...cross].reverse()) });

    expect(a.candidates.length).toBe(MAX_ENDPOINT_CANDIDATES);
    expect(a.total).toBe(520);
    expect(a.truncated).toBe(true);
    expect(a.candidates.filter((c) => !c.sameOrigin).length).toBeLessThanOrEqual(
      MAX_CROSS_ORIGIN_CANDIDATES
    );
    expect(b.candidates).toEqual(a.candidates);
  });

  test("render-time requests are folded in when a caller supplies them", () => {
    const surface = buildEndpointSurface({
      baseUrl: BASE,
      pages: [],
      renderedRequests: [{ url: "https://example.com/api/live", method: "post" }],
    });
    expect(surface.candidates).toMatchObject([
      { url: "https://example.com/api/live", method: "POST", source: "render" },
    ]);
  });
});

describe("script scan budget", () => {
  const filler = "var x=1;".repeat(Math.ceil((512 * 1024) / 8));
  const bundle = (i: number) => ({
    url: `https://example.com/static/b${String(i).padStart(3, "0")}.js`,
    content: `fetch("/api/b${String(i).padStart(3, "0")}");${filler}`.slice(0, 512 * 1024),
  });

  test("many large bundles are bounded by the total-bytes budget, in URL order, and the skip is reported", () => {
    const scripts = Array.from({ length: 300 }, (_, i) => bundle(i)); // 150 MiB offered
    const t0 = performance.now();
    const surface = buildEndpointSurface({ baseUrl: BASE, pages: [], scripts });
    const elapsed = performance.now() - t0;

    const scanned = Math.floor(MAX_SCRIPT_SCAN_CHARS / (512 * 1024));
    expect(surface.candidates.length).toBe(scanned);
    expect(surface.candidates.map((c) => c.url)).toEqual(
      Array.from({ length: scanned }, (_, i) => `https://example.com/api/b${String(i).padStart(3, "0")}`)
    );
    expect(surface.scriptsSkipped).toBe(300 - scanned);
    expect(surface.truncated).toBe(true);
    // 4 MiB scanned, not 150: the bound shows up as time, not just as a count.
    expect(elapsed).toBeLessThan(2000);
  });

  test("many small scripts are bounded by the scripts-scanned cap", () => {
    const scripts = Array.from({ length: 500 }, (_, i) => ({
      url: `https://example.com/s/${String(i).padStart(3, "0")}.js`,
      content: `fetch("/api/t${String(i).padStart(3, "0")}")`,
    }));
    const surface = buildEndpointSurface({ baseUrl: BASE, pages: [], scripts });
    expect(surface.candidates.length).toBe(MAX_SCRIPTS_SCANNED);
    expect(surface.scriptsSkipped).toBe(500 - MAX_SCRIPTS_SCANNED);
    expect(surface.truncated).toBe(true);
  });

  test("which scripts are read does not depend on the order they arrive in, and a small site is not truncated", () => {
    const scripts = Array.from({ length: 300 }, (_, i) => bundle(i));
    const a = buildEndpointSurface({ baseUrl: BASE, pages: [], scripts });
    const b = buildEndpointSurface({ baseUrl: BASE, pages: [], scripts: [...scripts].reverse() });
    expect(b).toEqual(a);

    const small = buildEndpointSurface({ baseUrl: BASE, pages: [], scripts: scripts.slice(0, 3) });
    expect(small.scriptsSkipped).toBe(0);
    expect(small.truncated).toBe(false);
  });
});

describe("rule context", () => {
  test("a site rule reads ctx.endpointSurface from runSiteRules", async () => {
    let seen: unknown = "unset";
    const probe: Rule = {
      meta: {
        id: "test/endpoint-surface-probe",
        name: "probe",
        description: "reads the endpoint surface",
        category: "security",
        scope: "site",
        severity: "info",
        weight: 1,
        optionsSchema: undefined,
      } as unknown as Rule["meta"],
      run(ctx: RuleContext) {
        seen = ctx.endpointSurface;
        return { checks: [] } as never;
      },
    } as unknown as Rule;

    const runner = new RuleRunner({ config: { rule_options: {}, rules: { enable: [] } } as never });
    const internals = runner as unknown as { rules: Map<string, Rule>; enabledRuleIds: string[] };
    internals.rules.set(probe.meta.id, probe);
    internals.enabledRuleIds = [probe.meta.id];

    const surface = buildEndpointSurface({ baseUrl: BASE, pages: [], techIds: ["nuxt"] });
    await runner.runSiteRules({ baseUrl: BASE, pages: [], robotsTxt: null, sitemaps: null }, undefined, undefined, surface);
    expect(seen).toBe(surface);
  });
});
