// perf/source-maps reports a map that a shared bundle exposes once for every
// page that loads the bundle (repo#2341). Each such page emits the identical
// check, keyed on the bundle set, so report grouping shows one finding with the
// pages listed; a section bundle gets its own finding; a map only one page is
// known to expose stays the page-level check it always was.

import { describe, expect, test } from "bun:test";

import type { ScriptContentData } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { foldGroupKey, foldOverflowChecks } from "../src/fold";
import { sourceMapsRule } from "../src/performance/source-maps";
import type { CheckResult, RuleContext } from "../src/types";

const ORIGIN = "https://example.com";
const PAGES = ["/", "/a", "/b", "/docs/1", "/docs/2"].map((p) => `${ORIGIN}${p}`);
const DOCS = PAGES.filter((p) => p.includes("/docs/"));

function script(path: string, sourcePages: string[], mapComment = true): ScriptContentData {
  const url = `${ORIGIN}${path}`;
  return {
    url,
    status: 200,
    error: null,
    contentType: "application/javascript",
    sizeBytes: 100,
    content: `console.log(1);\n${mapComment ? `//# sourceMappingURL=${path.split("/").pop()}.map` : ""}`,
    sourcePages,
  };
}

const SITE_SCRIPTS: ScriptContentData[] = [
  script("/assets/app.js", PAGES),
  script("/assets/vendor.js", PAGES),
  script("/assets/docs.js", DOCS),
  script("/assets/home-only.js", [`${ORIGIN}/`]),
];

function checksFor(url: string, scriptPaths: string[], scripts = SITE_SCRIPTS, extra = ""): CheckResult[] {
  const tags = scriptPaths.map((p) => `<script src="${p}"></script>`).join("");
  const html = `<!DOCTYPE html><html><head><title>t</title>${tags}${extra}</head><body>x</body></html>`;
  const ctx = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    site: { baseUrl: ORIGIN, pages: [], robotsTxt: null, sitemaps: null, scripts },
    options: {},
  } as unknown as RuleContext;
  const result = sourceMapsRule.run(ctx);
  if (result instanceof Promise) throw new Error("rule is async");
  return result.checks;
}

const exposed = (checks: CheckResult[]) => checks.filter((c) => c.name === "source-maps-exposed");
const mapIds = (checks: CheckResult[]) =>
  exposed(checks)
    .flatMap((c) => (c.items ?? []).map((i) => i.id))
    .sort();

describe("perf/source-maps: shared bundles (repo#2341)", () => {
  test("every page loading the same bundles emits one identical check", () => {
    const perPage = ["/", "/a", "/b"].map((p) =>
      exposed(checksFor(`${ORIGIN}${p}`, ["/assets/app.js", "/assets/vendor.js"]))
    );
    for (const checks of perPage) {
      expect(checks).toHaveLength(1);
      expect(checks[0]).toEqual(perPage[0]![0]!);
    }
    const [check] = perPage[0]!;
    expect(check?.status).toBe("warn");
    expect(check?.message).toBe(
      "2 source map(s) exposed by bundles shared across pages: /assets/app.js.map, /assets/vendor.js.map"
    );
    expect(check?.details?.sharedPages).toBe(PAGES.length);
    expect(typeof check?.details?.foldKey).toBe("string");
  });

  test("script order on the page does not change the check", () => {
    const one = exposed(checksFor(`${ORIGIN}/a`, ["/assets/app.js", "/assets/vendor.js"]));
    const two = exposed(checksFor(`${ORIGIN}/b`, ["/assets/vendor.js", "/assets/app.js"]));
    expect(two).toEqual(one);
  });

  test("a section bundle is its own finding, with its own page count", () => {
    const checks = exposed(
      checksFor(`${ORIGIN}/docs/1`, ["/assets/app.js", "/assets/vendor.js", "/assets/docs.js"])
    );
    expect(checks.map((c) => c.message).sort()).toEqual([
      "1 source map(s) exposed by bundles shared across pages: /assets/docs.js.map",
      "2 source map(s) exposed by bundles shared across pages: /assets/app.js.map, /assets/vendor.js.map",
    ]);
    const docs = checks.find((c) => c.message.includes("docs.js.map"));
    expect(docs?.details?.sharedPages).toBe(DOCS.length);
    expect(docs?.details?.foldKey).not.toBe(checks.find((c) => c !== docs)?.details?.foldKey);
  });

  test("a map only one page loads stays a page-level finding", () => {
    const checks = exposed(checksFor(`${ORIGIN}/`, ["/assets/app.js", "/assets/home-only.js"]));
    const pageLevel = checks.find((c) => c.message === "1 potential source map(s) detected");
    expect(pageLevel?.items?.map((i) => i.id)).toEqual([`${ORIGIN}/assets/home-only.js.map`]);
    expect(checks).toHaveLength(2);
  });

  test("inline maps and the page's SourceMap header stay page-level", () => {
    const checks = exposed(
      checksFor(
        `${ORIGIN}/a`,
        ["/assets/app.js"],
        SITE_SCRIPTS,
        `<style>a{}/*# sourceMappingURL=inline.css.map */</style>`
      )
    );
    expect(checks.map((c) => c.message).sort()).toEqual([
      "1 potential source map(s) detected",
      "1 source map(s) exposed by bundles shared across pages: /assets/app.js.map",
    ]);
  });

  test("without script records only the page's own maps are seen, page-level as before", () => {
    const checks = exposed(
      checksFor(`${ORIGIN}/a`, ["/assets/app.js"], [], `<script>x();//# sourceMappingURL=/inline.js.map</script>`)
    );
    expect(checks.map((c) => c.message)).toEqual(["1 potential source map(s) detected"]);
  });

  test("detection per page is unchanged: the same map URLs, split across checks", () => {
    const checks = checksFor(`${ORIGIN}/`, [
      "/assets/app.js",
      "/assets/vendor.js",
      "/assets/docs.js",
      "/assets/home-only.js",
    ]);
    expect(mapIds(checks)).toEqual(
      ["app", "docs", "home-only", "vendor"].map((n) => `${ORIGIN}/assets/${n}.js.map`)
    );
    expect(checks.some((c) => c.status === "pass")).toBe(false);
  });

  test("a page with no maps still passes", () => {
    const clean = [script("/assets/clean.js", PAGES, false)];
    const checks = checksFor(`${ORIGIN}/a`, ["/assets/clean.js"], clean);
    expect(checks).toEqual([
      { name: "source-maps", status: "pass", message: "No exposed source maps detected" },
    ]);
  });

  test("a shared group lists every map up to the publish item cap, then counts the rest", () => {
    const many = Array.from({ length: 60 }, (_, i) => script(`/chunks/c${String(i).padStart(2, "0")}.js`, PAGES));
    const checks = exposed(checksFor(`${ORIGIN}/a`, many.map((s) => new URL(s.url).pathname), many));
    expect(checks).toHaveLength(1);
    expect(checks[0]?.items).toHaveLength(50);
    expect(checks[0]?.details?.additional).toBe(10);
    expect(checks[0]?.message).toBe(
      "60 source map(s) exposed by bundles shared across pages: /chunks/c00.js.map, /chunks/c01.js.map, /chunks/c02.js.map, and 57 more"
    );
  });
});

describe("perf/source-maps: the grouping is the same from every page (repo#2341)", () => {
  // Two scripts expose shared.map, on different page sets; other.map comes
  // from a third script on a page set of its own.
  const [a, b, c] = ["/a", "/b", "/c"].map((p) => `${ORIGIN}${p}`) as [string, string, string];
  const mapScript = (path: string, map: string, pages: string[]): ScriptContentData => ({
    ...script(path, pages, false),
    content: `x();\n//# sourceMappingURL=/maps/${map}`,
  });
  const scripts = [
    mapScript("/s/one.js", "shared.map", [a, b]),
    mapScript("/s/two.js", "shared.map", [b, c]),
    mapScript("/s/three.js", "other.map", [a, b]),
  ];
  const onPage = (url: string, paths: string[]) => exposed(checksFor(url, paths, scripts));

  test("a map's page set spans every script that exposes it, not just this page's", () => {
    const fromA = onPage(a, ["/s/one.js", "/s/three.js"]);
    const fromB = onPage(b, ["/s/one.js", "/s/two.js", "/s/three.js"]);
    const fromC = onPage(c, ["/s/two.js"]);
    const sharedOf = (checks: CheckResult[]) => checks.find((x) => x.message.includes("shared.map"));
    const otherOf = (checks: CheckResult[]) => checks.find((x) => x.message.includes("other.map"));
    expect(sharedOf(fromA)).toEqual(sharedOf(fromB)!);
    expect(sharedOf(fromC)).toEqual(sharedOf(fromB)!);
    expect(otherOf(fromA)).toEqual(otherOf(fromB)!);
    expect(sharedOf(fromB)?.details?.sharedPages).toBe(3);
    expect(otherOf(fromB)?.details?.sharedPages).toBe(2);
    expect(fromC).toHaveLength(1);
  });
});

describe("perf/source-maps: every group has its own message (repo#2341)", () => {
  test("off-site maps that differ only in their query are named in full", () => {
    const one = { ...script("/x/one.js", PAGES, false), content: "x();\n//# sourceMappingURL=https://cdn.example.net/app.map?v=one" };
    const two = { ...script("/x/two.js", DOCS, false), content: "x();\n//# sourceMappingURL=https://cdn.example.net/app.map?v=two" };
    const checks = exposed(checksFor(`${ORIGIN}/docs/1`, ["/x/one.js", "/x/two.js"], [one, two]));
    expect(checks.map((x) => x.message).sort()).toEqual([
      "1 source map(s) exposed by bundles shared across pages: https://cdn.example.net/app.map?v=one",
      "1 source map(s) exposed by bundles shared across pages: https://cdn.example.net/app.map?v=two",
    ]);
  });

  test("a map a script's SourceMap header names is labelled with the header", () => {
    const viaHeader = { ...script("/x/h.js", PAGES, false), sourceMapHeader: "h.js.map" };
    const [check] = exposed(checksFor(`${ORIGIN}/a`, ["/x/h.js"], [viaHeader]));
    expect(check?.items).toEqual([{ id: `${ORIGIN}/x/h.js.map`, label: "from /x/h.js (HTTP header)" }]);
  });

  test("pages on another origin of the site emit the same check", () => {
    const https = exposed(checksFor(`${ORIGIN}/a`, ["/assets/app.js"]));
    const http = exposed(checksFor("http://example.com/b", [`${ORIGIN}/assets/app.js`]));
    expect(http).toEqual(https);
  });

  test("a long name is cut with a hash of the whole URL", () => {
    const long = (tail: string) => `/${"segment/".repeat(20)}${tail}.js.map`;
    const one = { ...script("/x/one.js", PAGES, false), content: `x();\n//# sourceMappingURL=${long("one")}` };
    const two = { ...script("/x/two.js", DOCS, false), content: `x();\n//# sourceMappingURL=${long("two")}` };
    const [m1, m2] = exposed(checksFor(`${ORIGIN}/docs/1`, ["/x/one.js", "/x/two.js"], [one, two])).map(
      (x) => x.message
    );
    expect(m1).not.toBe(m2);
    expect(m1).toContain("…~");
  });
});

describe("fold keeps source-map groups apart (repo#2341)", () => {
  test("checks with different foldKeys fold into different aggregates, and keep the key", () => {
    const siteWide = exposed(checksFor(`${ORIGIN}/a`, ["/assets/app.js"]))[0]!;
    const docs = exposed(checksFor(`${ORIGIN}/docs/1`, ["/assets/docs.js"]))[0]!;
    const checks: CheckResult[] = [
      ...Array.from({ length: 4 }, (_, i) => ({ ...siteWide, pageUrl: `${ORIGIN}/p${i}` })),
      ...Array.from({ length: 3 }, (_, i) => ({ ...docs, pageUrl: `${ORIGIN}/docs/${i}` })),
    ];
    const folded = foldOverflowChecks(checks, {
      maxChecks: 2,
      maxItemsPerCheck: 50,
      maxPagesPerCheck: 100,
      maxSourcePagesPerItem: 5,
    });
    expect(folded).toHaveLength(2);
    const byKey = new Map(folded.map((c) => [c.details?.foldKey, c]));
    expect(byKey.get(siteWide.details?.foldKey)?.pages).toHaveLength(4);
    expect(byKey.get(docs.details?.foldKey)?.pages).toHaveLength(3);
    // A re-fold of the aggregates keeps the same two groups and their pages.
    const refolded = foldOverflowChecks([...folded, ...folded], {
      maxChecks: 3,
      maxItemsPerCheck: 50,
      maxPagesPerCheck: 100,
      maxSourcePagesPerItem: 5,
    });
    expect(refolded).toHaveLength(2);
    const again = new Map(refolded.map((c) => [c.details?.foldKey, c]));
    expect(again.get(siteWide.details?.foldKey)?.pages).toHaveLength(4);
    expect(again.get(docs.details?.foldKey)?.pages).toHaveLength(3);
  });

  test("checks without a foldKey fold exactly as before", () => {
    expect(foldGroupKey({ name: "x", status: "warn", message: "m" })).toBe("x\u0000warn\u0000\u0000");
  });
});

describe("perf/source-maps: noscript content is not read (#440)", () => {
  function pageChecks(body: string): CheckResult[] {
    const url = `${ORIGIN}/`;
    const html = `<!DOCTYPE html><html><head><title>t</title></head><body>${body}</body></html>`;
    const ctx = {
      page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
      parsed: parsePage(html, url),
      site: { baseUrl: ORIGIN, pages: [], robotsTxt: null, sitemaps: null, scripts: [] },
      options: {},
    } as unknown as RuleContext;
    const result = sourceMapsRule.run(ctx);
    if (result instanceof Promise) throw new Error("rule is async");
    return result.checks;
  }

  const STYLE = "body{opacity:1}/*# sourceMappingURL=/fallback.css.map */";
  const SCRIPT = "console.log(1);//# sourceMappingURL=/fallback.js.map";
  const INLINE_SCRIPT = "console.log(1);//# sourceMappingURL=data:application/json;base64,e30=";

  test("an inline style inside noscript is not reported", () => {
    const checks = pageChecks(`<noscript><style>${STYLE}</style></noscript>`);
    expect(exposed(checks)).toHaveLength(0);
    expect(checks.some((c) => c.name === "source-maps-inline")).toBe(false);
  });

  test("an inline script inside noscript is not reported", () => {
    const checks = pageChecks(`<noscript><script>${SCRIPT}</script></noscript>`);
    expect(exposed(checks)).toHaveLength(0);
    expect(checks.some((c) => c.name === "source-maps-inline")).toBe(false);
  });

  test("an inline data: script map inside noscript is not reported as inline", () => {
    const checks = pageChecks(`<noscript><script>${INLINE_SCRIPT}</script></noscript>`);
    expect(checks.some((c) => c.name === "source-maps-inline")).toBe(false);
  });

  test("the same inline style outside noscript is still reported", () => {
    const checks = pageChecks(`<style>${STYLE}</style>`);
    expect(mapIds(checks)).toEqual([`${ORIGIN}/fallback.css.map`]);
  });

  test("the same inline script outside noscript is still reported", () => {
    const checks = pageChecks(`<script>${SCRIPT}</script>`);
    expect(mapIds(checks)).toEqual([`${ORIGIN}/fallback.js.map`]);
  });

  test("the same inline data: script outside noscript is still reported as inline", () => {
    const checks = pageChecks(`<script>${INLINE_SCRIPT}</script>`);
    expect(checks.some((c) => c.name === "source-maps-inline")).toBe(true);
  });
});
