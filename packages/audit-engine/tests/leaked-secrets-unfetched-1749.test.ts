// #1749 end to end over real HTTP: the real asset phase fetches a small site's scripts, and the real
// security/leaked-secrets rule reads the result. A script that could not be read (a 5xx, a WAF challenge, a
// refused connection) is listed as unfetched and the rule does not claim a clean site; a script that is gone
// (404) is not listed; a script the asset cap never requested is counted.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { parseDocument } from "@squirrelscan/parser";
import { security } from "@squirrelscan/rules";

import {
  absorbResourceOccurrences,
  emptySiteAssetOccurrences,
  fetchAssetsFromOccurrences,
} from "../src/adapter";

type Storage = Parameters<typeof fetchAssetsFromOccurrences>[0];
type Config = Parameters<typeof fetchAssetsFromOccurrences>[3];
type ParsedPage = Parameters<typeof absorbResourceOccurrences>[1][number]["parsed"];
type Overrides = Parameters<typeof fetchAssetsFromOccurrences>[4];

function storageFor(siteBase: string): Storage {
  return {
    getCrawl: () => Effect.succeed({ baseUrl: siteBase }),
    getSitemaps: () => Effect.succeed([]),
    getCachedResources: () => Effect.succeed([]),
    getRobotsTxt: () => Effect.succeed(null),
  } as unknown as Storage;
}

const NO_CONFIG = { rules: { enable: ["*"], disable: [] } } as unknown as Config;

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/ok.js") return new Response("var x = 1;", { headers: { "content-type": "text/javascript" } });
      if (pathname === "/ok2.js") return new Response("var y = 2;", { headers: { "content-type": "text/javascript" } });
      if (/^\/bulk\d+\.js$/.test(pathname)) return new Response("var z = 3;", { headers: { "content-type": "text/javascript" } });
      if (pathname === "/gone.js") return new Response("gone", { status: 404 });
      if (pathname === "/boom.js") return new Response("boom", { status: 500 });
      if (pathname === "/waf.js") {
        return new Response("<html>Just a moment...</html>", {
          status: 403,
          headers: { "content-type": "text/html", server: "cloudflare", "cf-ray": "abc123-LHR" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

async function assetsFor(srcs: string[], overrides?: Overrides, config: Config = NO_CONFIG) {
  const url = `${base}/`;
  const markup = `<!doctype html><html><head><title>x</title>${srcs
    .map((s) => `<script src="${s}"></script>`)
    .join("")}</head><body><p>x</p></body></html>`;
  const occurrences = emptySiteAssetOccurrences();
  absorbResourceOccurrences(
    occurrences,
    [{ url, finalUrl: url, parsed: { document: parseDocument(markup), images: [] } as unknown as ParsedPage, hasCsp: false }],
    base,
  );
  occurrences.pageCount = 1;
  return Effect.runPromise(
    fetchAssetsFromOccurrences(storageFor(base), "fixture-crawl", occurrences, config, overrides),
  );
}

function leakChecks(assets: Awaited<ReturnType<typeof assetsFor>>): CheckResult[] {
  return security.leakedSecretsRule.run({
    page: { url: `${base}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as never,
    site: {
      baseUrl: base,
      pages: [],
      robotsTxt: null,
      sitemaps: null,
      scripts: assets.scripts,
      assetCapDropped: assets.assetCapDropped,
      scriptsNotReadUrls: assets.scriptsNotReadUrls,
    },
    options: {},
  }).checks as CheckResult[];
}

const named = (checks: CheckResult[], name: string) => checks.find((c) => c.name === name);

describe("security/leaked-secrets reports the scripts it could not read (#1749)", () => {
  test("a script that is read and clean keeps the clean pass", async () => {
    const checks = leakChecks(await assetsFor(["/ok.js"]));
    expect(named(checks, "leaked-secrets")?.status).toBe("pass");
    expect(named(checks, "leaked-secrets-unfetched")).toBeUndefined();
  });

  test("a 5xx and a WAF challenge are listed as unfetched, and the site is not called clean", async () => {
    const checks = leakChecks(await assetsFor(["/ok.js", "/boom.js", "/waf.js"]));
    const unfetched = named(checks, "leaked-secrets-unfetched");
    expect(unfetched?.status).toBe("info");
    const ids = unfetched?.items?.map((i) => i.id).sort();
    expect(ids).toEqual([`${base}/boom.js`, `${base}/waf.js`].sort());
    expect(unfetched?.items?.find((i) => i.id.endsWith("/boom.js"))?.label).toContain("500");
    expect(unfetched?.items?.find((i) => i.id.endsWith("/waf.js"))?.label).toContain("WAF");
    expect(named(checks, "leaked-secrets")).toBeUndefined();
  });

  test("a script that is gone (404) is not listed, and the site is still clean", async () => {
    const checks = leakChecks(await assetsFor(["/ok.js", "/gone.js"]));
    expect(named(checks, "leaked-secrets-unfetched")).toBeUndefined();
    expect(named(checks, "leaked-secrets")?.status).toBe("pass");
  });

  test("a script the asset cap never requested is counted", async () => {
    const assets = await assetsFor(["/ok.js", "/ok2.js"], { resourceCheckMaxItems: 1 });
    expect(assets.assetCapDropped?.scripts).toBe(1);
    const unfetched = named(leakChecks(assets), "leaked-secrets-unfetched");
    expect(unfetched?.details).toMatchObject({ unfetched: 0, capDropped: 1 });
    expect(unfetched?.message).toContain("asset fetch cap");
  });

  test("scripts a store_scripts run fetched beyond the rule limit are counted as unread", async () => {
    const srcs = Array.from({ length: 14 }, (_, i) => `/bulk${i}.js`);
    const config = {
      rules: { enable: ["*"], disable: [] },
      storage: { store_scripts: true },
    } as unknown as Config;
    const assets = await assetsFor(srcs, undefined, config);
    expect(assets.scripts.length).toBe(10);
    expect(assets.storedOnlyScripts?.length).toBe(4);
    expect(assets.scriptsNotRead).toBe(4);
    const checks = leakChecks(assets);
    const unfetched = named(checks, "leaked-secrets-unfetched");
    expect(unfetched?.details).toMatchObject({ unfetched: 0, capDropped: 4 });
    expect(named(checks, "leaked-secrets")).toBeUndefined();
    expect(assets.scriptsNotReadUrls).toHaveLength(4);
    expect(unfetched?.items?.map((i) => i.id)).toEqual(assets.scriptsNotReadUrls);
    expect(unfetched?.items?.[0]?.label).toContain("script limit");
  }, 30_000);
});
