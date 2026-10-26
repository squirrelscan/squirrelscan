// HTTP-only fixture for reliability/broken-resources (#703).
//
// Serves a small site from a local Bun server, runs the real asset phase
// (fetchAssetsFromOccurrences) against it with no render, and feeds the result to
// the rule. Covers the acceptance fixtures end to end: a first-party script that
// 404s, a first-party stylesheet that 500s, a third-party script that 404s and a
// font that 404s, plus the per-URL grouping and the asset-cap partial result.
// Then the third-party probe's limits: no request to a private, loopback or
// metadata address (on any redirect hop), and none of the audit's custom headers.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { parseDocument } from "@squirrelscan/parser";
import { reliability } from "@squirrelscan/rules";
import {
  ASSET_FETCH_REFUSED_ERROR,
  RESOURCE_SIZE_LIMITS,
  SQUIRRELSCAN_USER_AGENT,
} from "@squirrelscan/utils/constants";

import {
  absorbResourceOccurrences,
  assetCapDroppedOf,
  emptySiteAssetOccurrences,
  fetchAssetsFromOccurrences,
} from "../src/adapter";
import { createFetchBudget } from "../src/fetch-budget";
import { checkResourceSizes } from "../src/resource-checker";

type Storage = Parameters<typeof fetchAssetsFromOccurrences>[0];
type Config = Parameters<typeof fetchAssetsFromOccurrences>[3];
type ParsedPage = Parameters<typeof absorbResourceOccurrences>[1][number]["parsed"];
type Overrides = Parameters<typeof fetchAssetsFromOccurrences>[4];

// No sitemap, cache or robots.txt rows: the fetch phase only needs the URLs it is given, and
// the crawl's base URL, which decides how far a third-party probe may reach.
function storageFor(siteBase: string): Storage {
  return {
    getCrawl: () => Effect.succeed({ baseUrl: siteBase }),
    getSitemaps: () => Effect.succeed([]),
    getCachedResources: () => Effect.succeed([]),
    getRobotsTxt: () => Effect.succeed(null),
  } as unknown as Storage;
}

/** Fake credentials an audit sends its own host; a third-party probe must carry none. */
const AUDIT_HEADERS = { "Signature-Input": "sig1=fake", Authorization: "Bearer t", Cookie: "c=1" };

/** Every rule on, as the config schema's default `enable = ["*"]` has it. */
const ALL_RULES = { enable: ["*"], disable: [] };
const NO_CONFIG = { rules: ALL_RULES } as unknown as Config;

let server: ReturnType<typeof Bun.serve>;
let base: string;
let thirdParty: string;
/** Distinct `/ext-N` paths requested, to prove the third-party cap holds. */
const extHits = new Set<string>();
/** Method and headers of every request to a `/probe/` path, in order. */
const probeHits: Array<{ path: string; method: string; headers: Headers }> = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname.startsWith("/ext-")) {
        extHits.add(pathname);
        return text("ok", 200, "text/javascript");
      }
      if (pathname.startsWith("/probe/")) {
        probeHits.push({ path: pathname, method: req.method, headers: req.headers });
        // Redirects a status probe must not follow: to the metadata address, to
        // a private IP, and to a public-looking name that resolves privately.
        if (pathname === "/probe/to-metadata") {
          return redirect("http://169.254.169.254/latest/meta-data/iam");
        }
        if (pathname === "/probe/to-private-ip") return redirect("http://10.0.0.7/x");
        if (pathname === "/probe/to-private-name") {
          return redirect(`http://inside.public.example.com:${server.port}/probe/never`);
        }
        if (pathname === "/probe/to-public") {
          return redirect(`http://cdn.public.example.com:${server.port}/probe/landed`);
        }
        // HEAD refused, so the probe falls back to a GET; and a same-host hop.
        if (pathname === "/probe/head-405" && req.method === "HEAD") {
          return new Response(null, { status: 405 });
        }
        if (pathname === "/probe/hop") return redirect("/probe/hop-landed");
        return text("ok", 200, "text/javascript");
      }
      if (pathname === "/app.js") return text("gone", 404);
      if (pathname === "/site.css") return text("body{}", 500, "text/css");
      if (pathname === "/third.js") return text("gone", 404);
      if (pathname === "/f.woff2") return text("gone", 404);
      if (pathname === "/css-a.css" || pathname === "/css-b.css") {
        return text("body{}", 200, "text/css");
      }
      // A WAF challenge: 403 with a Cloudflare fingerprint, as the link checker sees it.
      if (pathname === "/waf.js") {
        return new Response("<html>Just a moment...</html>", {
          status: 403,
          headers: { "content-type": "text/html", server: "cloudflare", "cf-ray": "abc123-LHR" },
        });
      }
      // Throttled (503 + Retry-After) and a bare outage (503).
      if (pathname === "/busy.css") {
        return new Response("busy", { status: 503, headers: { "retry-after": "1" } });
      }
      if (pathname === "/down.css") return text("down", 503, "text/css");
      return text("not found", 404);
    },
  });
  // `localhost` and `127.0.0.1` are different hostnames, so the second one is a
  // third party to the first, while both reach this server.
  base = `http://localhost:${server.port}`;
  thirdParty = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

function text(body: string, status: number, type = "text/plain"): Response {
  return new Response(body, { status, headers: { "content-type": type } });
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

// Every request the asset phase sends goes through the global fetch, so a spy
// on it sees every URL and every redirect hop, whether or not anything answers.
const realFetch = globalThis.fetch;
let sent: string[] = [];
/**
 * A public address the test resolver hands out for public-looking names. The
 * guard pins each request to it, and the spy delivers it to the local server.
 */
const PUBLIC_STAND_IN = "93.184.216.34";

function spyOnFetch(): void {
  sent = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    sent.push(url.toString());
    if (url.hostname === PUBLIC_STAND_IN) url.hostname = "127.0.0.1";
    return realFetch(url.toString(), init);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A third-party probe carries squirrel's User-Agent and none of the audit's credentials. */
function expectNoCredentials(headers: Headers): void {
  expect(headers.get("signature-input")).toBeNull();
  expect(headers.get("authorization")).toBeNull();
  expect(headers.get("cookie")).toBeNull();
  expect(headers.get("user-agent")).toBe(SQUIRRELSCAN_USER_AGENT);
}

/** The page list the asset phase reads, parsed the way the crawl parses it. */
function pagesFor(urls: string[], markup: (url: string) => string) {
  return urls.map((url) => ({
    url,
    finalUrl: url,
    parsed: { document: parseDocument(markup(url)), images: [] } as unknown as ParsedPage,
    hasCsp: false,
  }));
}

async function assetsFor(
  urls: string[],
  markup: (url: string) => string,
  overrides?: Overrides,
  { siteBase = base, config = NO_CONFIG }: { siteBase?: string; config?: Config } = {},
) {
  const occurrences = emptySiteAssetOccurrences();
  absorbResourceOccurrences(occurrences, pagesFor(urls, markup), siteBase);
  occurrences.pageCount = urls.length;
  return Effect.runPromise(
    fetchAssetsFromOccurrences(
      storageFor(siteBase),
      "fixture-crawl",
      occurrences,
      config,
      overrides,
    ),
  );
}

function ruleChecks(assets: Awaited<ReturnType<typeof assetsFor>>, siteBase = base): CheckResult[] {
  const result = reliability.brokenResourcesRule.run({
    page: { url: `${siteBase}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as never,
    site: {
      baseUrl: siteBase,
      pages: [],
      robotsTxt: null,
      sitemaps: null,
      resourceSizes: assets.resourceSizes,
      scripts: assets.scripts,
      externalAssets: assets.externalAssets,
      assetCapDropped: assets.assetCapDropped,
    },
    options: {},
  });
  return result.checks as CheckResult[];
}

function named(checks: CheckResult[], name: string): CheckResult | undefined {
  return checks.find((c) => c.name === name);
}

describe("reliability/broken-resources over real HTTP (no render)", () => {
  test("404 script, 500 stylesheet, third-party 404 and font 404 each read as the acceptance criteria say", async () => {
    const pages = [`${base}/`, `${base}/about`];
    const checks = ruleChecks(await assetsFor(pages, (url) => markupFor(url)));

    const fail = named(checks, "broken-resources");
    expect(fail?.status).toBe("fail");
    const appJs = fail?.items?.find((i) => i.id === `${base}/app.js`);
    expect(appJs?.label).toContain("HTTP 404");
    expect(appJs?.sourcePages?.sort()).toEqual([...pages].sort());
    const css = fail?.items?.find((i) => i.id === `${base}/site.css`);
    expect(css?.label).toContain("HTTP 500");

    // The third-party script and the font are warnings, never errors.
    const warn = named(checks, "unreachable-resources");
    expect(warn?.status).toBe("warn");
    expect(warn?.items?.some((i) => i.id === `${thirdParty}/third.js`)).toBe(true);
    expect(warn?.items?.some((i) => i.id === `${base}/f.woff2`)).toBe(true);
    expect(fail?.items?.some((i) => i.id.includes("third.js"))).toBe(false);
    expect(fail?.items?.some((i) => i.id.includes("f.woff2"))).toBe(false);
  });

  test("a WAF challenge is unverified, and 503 splits on Retry-After (bare 503 is broken)", async () => {
    const pages = [`${base}/`];
    const markup = () =>
      `<!doctype html><html><head><title>x</title><link rel="stylesheet" href="/busy.css"><link rel="stylesheet" href="/down.css"></head><body><p>x</p></body></html>`;
    const challenged = `<!doctype html><html><head><title>x</title></head><body><p>x</p></body></html>`;
    const assets = await assetsFor(pages, markup);
    const checks = ruleChecks(assets);
    const fail = named(checks, "broken-resources");
    expect(fail?.items?.map((i) => i.id)).toEqual([`${base}/down.css`]);
    const unverified = named(checks, "unverified-resources");
    expect(unverified?.items?.map((i) => i.id)).toEqual([`${base}/busy.css`]);

    // A script answered with a WAF challenge, on a first-party URL.
    const wafAssets = await assetsFor([`${base}/`], () =>
      challenged.replace("<head>", `<head><script src="/waf.js"></script>`),
    );
    const wafChecks = ruleChecks(wafAssets);
    expect(named(wafChecks, "broken-resources")).toBeUndefined();
    const wafUnverified = named(wafChecks, "unverified-resources");
    expect(wafUnverified?.items?.some((i) => i.id === `${base}/waf.js`)).toBe(true);
  });

  test("a stylesheet fetch cap drops referenced URLs and the result says the check was partial", async () => {
    const pages = [`${base}/`];
    const markup = () =>
      `<!doctype html><html><head><title>x</title><link rel="stylesheet" href="/css-a.css"><link rel="stylesheet" href="/css-b.css"></head><body><p>x</p></body></html>`;
    const assets = await assetsFor(pages, markup, { resourceCheckMaxItems: 1 });
    expect(assets.assetCapDropped?.css).toBe(1);

    const checks = ruleChecks(assets);
    const partial = named(checks, "unchecked-resources");
    expect(partial?.status).toBe("info");
    expect(partial?.message).toContain("asset fetch cap");
    expect(named(checks, "broken-resources")?.message).toBe(
      "No broken resources among the 1 checked",
    );
  });

  test("third-party checks stop at the per-kind cap, and the dropped URLs make the result partial", async () => {
    const limit = RESOURCE_SIZE_LIMITS.MAX_EXTERNAL_ASSETS_TO_CHECK;
    const scripts = Array.from(
      { length: limit + 1 },
      (_, n) => `<script src="${thirdParty}/ext-${n}"></script>`,
    ).join("");
    const markup = () =>
      `<!doctype html><html><head><title>x</title>${scripts}</head><body><p>x</p></body></html>`;

    extHits.clear();
    const assets = await assetsFor([`${base}/`], markup);
    expect(assets.externalAssets?.scripts).toHaveLength(limit);
    expect(assets.assetCapDropped?.externalScripts).toBe(1);
    expect(extHits.size).toBe(limit);

    const checks = ruleChecks(assets);
    expect(named(checks, "unchecked-resources")?.message).toContain(
      "1 referenced resource(s) were not fetched (asset fetch cap)",
    );
    expect(named(checks, "broken-resources")?.message).toBe(
      `No broken resources among the ${limit} checked`,
    );

    // A caller cap below the third-party cap wins.
    extHits.clear();
    const capped = await assetsFor([`${base}/`], markup, { resourceCheckMaxItems: 3 });
    expect(capped.externalAssets?.scripts).toHaveLength(3);
    expect(capped.assetCapDropped?.externalScripts).toBe(limit + 1 - 3);
    expect(extHits.size).toBe(3);
  });
});

describe("third-party probes stay off private networks and carry no credentials (#703)", () => {
  test("a public site's references to private, loopback and metadata addresses are never requested", async () => {
    const port = server.port;
    const siteBase = "https://www.example.com";
    const refs = [
      `<script src="http://127.0.0.1:${port}/probe/loopback-ip"></script>`,
      `<link rel="stylesheet" href="http://localhost:${port}/probe/loopback-name.css">`,
      `<link rel="preload" as="font" href="http://[::1]:${port}/probe/loopback-v6.woff2" crossorigin>`,
      `<script src="http://169.254.169.254/latest/meta-data/iam"></script>`,
      `<link rel="stylesheet" href="http://10.0.0.1/private.css">`,
      `<script src="http://metadata.google.internal/computeMetadata/v1/x"></script>`,
    ].join("");
    const markup = () =>
      `<!doctype html><html><head><title>x</title>${refs}</head><body><p>x</p></body></html>`;

    probeHits.length = 0;
    spyOnFetch();
    const assets = await assetsFor([`${siteBase}/`], markup, undefined, { siteBase });

    // Not one request left the process, and none reached the local server.
    expect(sent).toEqual([]);
    expect(probeHits).toEqual([]);
    const external = assets.externalAssets;
    const rows = [
      ...(external?.scripts ?? []),
      ...(external?.css ?? []),
      ...(external?.fonts ?? []),
    ];
    expect(rows).toHaveLength(6);
    for (const row of rows) expect(row.error).toBe(ASSET_FETCH_REFUSED_ERROR);

    // Not checked, never broken.
    const checks = ruleChecks(assets, siteBase);
    expect(named(checks, "broken-resources")).toBeUndefined();
    expect(named(checks, "unreachable-resources")).toBeUndefined();
    expect(named(checks, "unchecked-resources")?.message).toContain(
      "6 referenced resource(s) were not requested (a private, loopback or metadata address, or another site in an offline audit)",
    );
  });

  test("a public probe that redirects to a private or metadata address stops before that hop", async () => {
    const port = server.port;
    // Every *.public.example.com name resolves publicly except inside.public.example.com.
    const resolve = async (host: string) =>
      host === "inside.public.example.com" ? ["10.0.0.8"] : [PUBLIC_STAND_IN];
    const files = ["to-metadata", "to-private-ip", "to-private-name", "to-public"];

    probeHits.length = 0;
    spyOnFetch();
    const results = await Effect.runPromise(
      checkResourceSizes(
        files.map((file) => `http://cdn.public.example.com:${port}/probe/${file}`),
        { statusOnly: true, egress: { allowPrivateNetwork: false, resolve }, concurrency: 1 },
      ),
    );

    const byPath = new Map(results.map((r) => [new URL(r.url).pathname, r]));
    for (const file of ["to-metadata", "to-private-ip", "to-private-name"]) {
      expect(byPath.get(`/probe/${file}`)?.error).toBe(ASSET_FETCH_REFUSED_ERROR);
    }
    // A redirect between public hosts is still followed.
    expect(byPath.get("/probe/to-public")?.status).toBe(200);
    // The refused hops were never sent: every request went to the pinned public
    // address, one per refused probe to its public first hop, and nothing to
    // the private targets.
    expect(sent.every((u) => new URL(u).hostname === PUBLIC_STAND_IN)).toBe(true);
    expect(probeHits.map((h) => h.path)).not.toContain("/probe/never");
    expect(
      probeHits.filter((h) => h.path !== "/probe/landed" && h.path !== "/probe/to-public"),
    ).toHaveLength(3);
    // Pinned by address, addressed by name: each hop kept its own Host header.
    for (const hit of probeHits)
      expect(hit.headers.get("host")).toBe(`cdn.public.example.com:${port}`);
  });

  test("a refused probe is not a tarpit strike against its host", async () => {
    const port = server.port;
    const resolve = async () => [PUBLIC_STAND_IN];
    const budget = createFetchBudget({ tarpitLatencyMs: 60_000, tarpitStrikes: 1 });
    spyOnFetch();
    await Effect.runPromise(
      checkResourceSizes(
        ["to-metadata", "to-private-ip"].map(
          (f) => `http://cdn.public.example.com:${port}/probe/${f}`,
        ),
        {
          statusOnly: true,
          egress: { allowPrivateNetwork: false, resolve },
          concurrency: 1,
          budget,
        },
      ),
    );
    expect(budget.summary().tarpitHosts).toEqual([]);
    expect(budget.shouldSkip(`http://cdn.public.example.com:${port}/probe/landed`)).toBe(false);
  });

  test("a site on a private network may probe private hosts, never the metadata address", async () => {
    const markup = () =>
      `<!doctype html><html><head><title>x</title><script src="${thirdParty}/probe/to-metadata"></script><script src="${thirdParty}/probe/ok"></script></head><body><p>x</p></body></html>`;

    probeHits.length = 0;
    spyOnFetch();
    const assets = await assetsFor([`${base}/`], markup);

    const rows = new Map(
      (assets.externalAssets?.scripts ?? []).map((r) => [new URL(r.url).pathname, r]),
    );
    expect(rows.get("/probe/ok")?.status).toBe(200);
    expect(rows.get("/probe/to-metadata")?.error).toBe(ASSET_FETCH_REFUSED_ERROR);
    expect(sent.some((u) => u.includes("169.254.169.254"))).toBe(false);
  });

  test("third-party probes carry none of the audit's custom headers; the site's own assets do", async () => {
    const config = {
      rules: ALL_RULES,
      crawler: {
        headers: AUDIT_HEADERS,
      },
    } as unknown as Config;
    const markup = () =>
      `<!doctype html><html><head><title>x</title><link rel="stylesheet" href="/probe/own.css"><script src="${thirdParty}/probe/third"></script></head><body><p>x</p></body></html>`;

    probeHits.length = 0;
    await assetsFor([`${base}/`], markup, undefined, { config });

    const own = probeHits.filter((h) => h.path === "/probe/own.css");
    expect(own.length).toBeGreaterThan(0);
    for (const hit of own) expect(hit.headers.get("signature-input")).toBe("sig1=fake");

    // Status only: one HEAD, and only User-Agent and Accept of the audit's own.
    const third = probeHits.filter((h) => h.path === "/probe/third");
    expect(third.map((h) => h.method)).toEqual(["HEAD"]);
    for (const hit of third) expectNoCredentials(hit.headers);
  });

  test("no custom headers on the GET fallback or a redirect hop of a third-party probe", async () => {
    const config = {
      rules: ALL_RULES,
      crawler: {
        headers: AUDIT_HEADERS,
      },
    } as unknown as Config;
    const markup = () =>
      `<!doctype html><html><head><title>x</title><script src="${thirdParty}/probe/head-405"></script><script src="${thirdParty}/probe/hop"></script></head><body><p>x</p></body></html>`;

    probeHits.length = 0;
    const assets = await assetsFor([`${base}/`], markup, undefined, { config });

    const fallback = probeHits.filter((h) => h.path === "/probe/head-405");
    expect(fallback.map((h) => h.method)).toEqual(["HEAD", "GET"]);
    const hops = probeHits.filter((h) => h.path.startsWith("/probe/hop"));
    expect(hops.map((h) => h.path)).toEqual(["/probe/hop", "/probe/hop-landed"]);
    for (const hit of [...fallback, ...hops]) expectNoCredentials(hit.headers);
    const rows = assets.externalAssets?.scripts ?? [];
    expect(rows.every((r) => r.status === 200)).toBe(true);
  });

  test("with the rule disabled, no third-party request is sent", async () => {
    const config = { rules: { enable: ["*"], disable: ["reliability/*"] } } as unknown as Config;
    const markup = () =>
      `<!doctype html><html><head><title>x</title><script src="${thirdParty}/probe/rule-off"></script></head><body><p>x</p></body></html>`;

    probeHits.length = 0;
    const assets = await assetsFor([`${base}/`], markup, undefined, { config });

    expect(probeHits.filter((h) => h.path === "/probe/rule-off")).toEqual([]);
    expect(assets.externalAssets).toBeUndefined();
    expect(assets.assetCapDropped?.externalScripts).toBe(0);
  });

  test("an unknown base URL takes the strict policy", async () => {
    const markup = () =>
      `<!doctype html><html><head><title>x</title><script src="${thirdParty}/probe/no-base"></script></head><body><p>x</p></body></html>`;

    probeHits.length = 0;
    const assets = await assetsFor([`${base}/`], markup, undefined, { siteBase: "" });

    expect(probeHits).toEqual([]);
    expect(assets.externalAssets?.scripts.map((r) => r.error)).toEqual([ASSET_FETCH_REFUSED_ERROR]);
  });
});

describe("assetCapDroppedOf", () => {
  const urls = (n: number) =>
    new Map(Array.from({ length: n }, (_, i) => [`u${i}`, new Set<string>()]));
  const rows = (n: number) => Array.from({ length: n }, () => ({}));

  test("is referenced minus fetched per kind, floored at zero", () => {
    expect(
      assetCapDroppedOf(
        {
          scripts: urls(60),
          css: urls(3),
          fonts: urls(0),
          externalScripts: urls(51),
          externalCss: urls(2),
          externalFonts: urls(1),
        },
        {
          scripts: rows(50),
          css: rows(3),
          // More rows than URLs (a duplicate row) never reads as negative.
          fonts: rows(1),
          externalScripts: rows(50),
          externalCss: rows(0),
          externalFonts: rows(1),
        },
      ),
    ).toEqual({
      scripts: 10,
      css: 0,
      fonts: 0,
      externalScripts: 1,
      externalCss: 2,
      externalFonts: 0,
    });
  });
});

// Every fixture page references the same first-party script, stylesheet and font,
// and a third-party script.
function markupFor(_url: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture</title><meta name="description" content="Fixture page for the broken resources check, long enough to read well."><link rel="preload" as="font" href="/f.woff2" type="font/woff2" crossorigin><link rel="stylesheet" href="/site.css"><script src="/app.js"></script><script src="${thirdParty}/third.js"></script></head><body><h1>Fixture</h1><p>Body text.</p></body></html>`;
}
