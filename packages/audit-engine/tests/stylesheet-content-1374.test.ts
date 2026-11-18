// repo#1374: same-site stylesheet bodies reach rules in-process as ctx.site.stylesheets[].content.
// A body that is not read (per-file cap, per-crawl cap, cross-origin, budget spent, failure) is an entry
// with no `content`, never a throw. Rules emit derived signals; the body is not in what they return.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { parseDocument } from "@squirrelscan/parser";
import { STYLESHEET_FETCH_LIMITS } from "@squirrelscan/utils/constants";

import {
  absorbResourceOccurrences,
  emptySiteAssetOccurrences,
  fetchAssetsFromOccurrences,
} from "../src/adapter";
import { createFetchBudget } from "../src/fetch-budget";
import { fetchScriptContents } from "../src/script-fetcher";
import { toStylesheetContentData } from "../src/stylesheet-content";

type Storage = Parameters<typeof fetchAssetsFromOccurrences>[0];
type Config = Parameters<typeof fetchAssetsFromOccurrences>[3];
type ParsedPage = Parameters<typeof absorbResourceOccurrences>[1][number]["parsed"];

const CSS = { "content-type": "text/css" };
const SECRET_BODY = "/* body-marker-1374 */ .a { color: red }";
const CONFIG = { rules: { enable: ["*"], disable: [] } } as unknown as Config;

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/big.css") {
        return new Response(`.a{}${"x".repeat(STYLESHEET_FETCH_LIMITS.MAX_STYLESHEET_SIZE_BYTES)}`, { headers: CSS });
      }
      if (pathname === "/boom.css") return new Response("boom", { status: 500 });
      return new Response(SECRET_BODY, { headers: CSS });
    },
  });
  base = `http://localhost:${server.port}`;
});
afterAll(() => server.stop(true));

function storageFor(siteBase: string): Storage {
  return {
    getCrawl: () => Effect.succeed({ baseUrl: siteBase }),
    getSitemaps: () => Effect.succeed([]),
    getCachedResources: () => Effect.succeed([]),
    getRobotsTxt: () => Effect.succeed(null),
  } as unknown as Storage;
}

async function assetsFor(links: string[], config: Config = CONFIG) {
  const url = `${base}/`;
  const markup = `<!doctype html><html><head><title>x</title>${links
    .map((l) => `<link rel="stylesheet" href="${l}">`)
    .join("")}</head><body><p>hi</p></body></html>`;
  const occurrences = emptySiteAssetOccurrences();
  absorbResourceOccurrences(
    occurrences,
    [
      {
        url,
        finalUrl: url,
        parsed: { document: parseDocument(markup), images: [] } as unknown as ParsedPage,
        hasCsp: false,
      },
    ],
    base,
  );
  occurrences.pageCount = 1;
  return Effect.runPromise(
    fetchAssetsFromOccurrences(storageFor(base), "fixture-crawl", occurrences, config, undefined),
  );
}

describe("ctx.site.stylesheets (repo#1374)", () => {
  test("a real asset phase hands same-site CSS bodies to rules", async () => {
    const assets = await assetsFor(["/a.css", "/b.css"]);
    const bodies = new Map((assets.stylesheets ?? []).map((s) => [s.url, s.content]));
    expect(bodies.get(`${base}/a.css`)).toBe(SECRET_BODY);
    expect(bodies.get(`${base}/b.css`)).toBe(SECRET_BODY);
  });

  test("per-file cap: an oversized stylesheet is an entry with no content", async () => {
    const assets = await assetsFor(["/big.css", "/a.css"]);
    const big = assets.stylesheets?.find((s) => s.url.endsWith("/big.css"));
    expect(big).toBeDefined();
    expect(big?.content).toBeUndefined();
    expect(assets.stylesheets?.find((s) => s.url.endsWith("/a.css"))?.content).toBe(SECRET_BODY);
  });

  test("per-crawl cap: no more than the limit is requested", async () => {
    const links = Array.from({ length: STYLESHEET_FETCH_LIMITS.MAX_STYLESHEETS_TO_FETCH + 5 }, (_, i) => `/n${i}.css`);
    const assets = await assetsFor(links);
    expect(assets.stylesheets).toHaveLength(STYLESHEET_FETCH_LIMITS.MAX_STYLESHEETS_TO_FETCH);
  });

  test("a failed response is an entry with no content", async () => {
    const assets = await assetsFor(["/boom.css"]);
    expect(assets.stylesheets).toHaveLength(1);
    expect(assets.stylesheets?.[0]?.content).toBeUndefined();
  });

  test("not fetched when no rule reads stylesheets", async () => {
    const off = {
      rules: { enable: [], disable: ["a11y/color-contrast", "content/color-sprawl"] },
    } as unknown as Config;
    const assets = await assetsFor(["/a.css"], off);
    expect(assets.stylesheets).toBeUndefined();
  });

  test("content/color-sprawl alone fetches the bodies, not color-contrast's background summary (repo#1377)", async () => {
    const sprawlOnly = { rules: { enable: ["*"], disable: ["a11y/color-contrast"] } } as unknown as Config;
    const assets = await assetsFor(["/a.css"], sprawlOnly);
    expect(assets.stylesheets?.[0]?.content).toBe(SECRET_BODY);
    expect(assets.stylesheetBackgrounds).toBeUndefined();
  });

  test("cross-origin: a host outside the site is refused, no content, no throw", async () => {
    const results = await Effect.runPromise(
      fetchScriptContents([`${base}/a.css`], {
        anyContentType: true,
        fetchAll: true,
        egress: {
          allowPrivateNetwork: true,
          resolve: async () => ["127.0.0.1"],
          allowHost: () => false,
        },
      }),
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toBeNull();
    expect(toStylesheetContentData(results[0]!)).toEqual({ url: `${base}/a.css` });
  });

  test("budget exhausted: skipped stylesheets are entries with no content", async () => {
    const budget = createFetchBudget({ totalBudgetMs: 1, now: (() => { let t = 0; return () => (t += 10); })() });
    const results = await Effect.runPromise(
      fetchScriptContents([`${base}/a.css`, `${base}/b.css`], { anyContentType: true, fetchAll: true, budget }),
    );
    expect(results).toHaveLength(2);
    for (const r of results) expect(toStylesheetContentData(r)).toEqual({ url: r.url });
  });

  test("a rule reading the body emits a derived signal, not the body", async () => {
    const assets = await assetsFor(["/a.css"]);
    // A stand-in rule: it reads ctx.site.stylesheets[].content and returns only a count.
    const derived = (assets.stylesheets ?? []).map((s) => ({ url: s.url, bytes: s.content?.length ?? 0 }));
    expect(derived[0]?.bytes).toBe(SECRET_BODY.length);
    expect(JSON.stringify(derived)).not.toContain("body-marker-1374");
  });
});
