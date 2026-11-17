// repo#3094: the controller saves the render block it wrote into the crawl's stored scan scope, so
// `squirrel report` restores that exact block. Deleting the save in runAudit fails these tests.

import type { DocumentFetcher } from "@squirrelscan/fetchers";

import { createFetchDocumentFetcher } from "@squirrelscan/fetchers";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { runAudit } from "../../src/controllers/audit";
import { getStoredAudit } from "../../src/controllers/report";
import { isolateSquirrelHome } from "../helpers/scratch-squirrel-home";

isolateSquirrelHome("render-saved-with-crawl-3094");

const HTML = { "content-type": "text/html; charset=utf-8" };
const page = (title: string, body = "") =>
  new Response(
    `<!doctype html><html lang="en"><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`,
    { headers: HTML }
  );

let server: ReturnType<typeof Bun.serve>;
let origin: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/") {
        return page(
          "Home",
          '<a href="/shell">Shell</a><a href="/plain">Plain</a><a href="/old">Old</a>'
        );
      }
      if (pathname === "/shell") return page("Shell");
      if (pathname === "/plain") return page("Plain");
      if (pathname === "/old") {
        return new Response(null, {
          status: 301,
          headers: { location: "/plain" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  origin = server.url.origin;
});

afterAll(() => {
  server.stop(true);
});

// A hybrid fetcher: plain HTTP everywhere, but /shell comes back as a cloud render.
function hybridFetcher(): DocumentFetcher {
  const plain = createFetchDocumentFetcher();
  return {
    id: "hybrid-http-first",
    capabilities: { jsRendering: true, cookies: true, screenshot: false },
    async fetch(req) {
      const res = await plain.fetch(req);
      return new URL(req.url).pathname === "/shell"
        ? { ...res, fetcherMethod: "cloud-render" }
        : res;
    },
  };
}

async function audit(name: string, cloudAvailable?: boolean) {
  const result = await runAudit({
    url: origin,
    projectName: name,
    maxPages: 10,
    coverageMode: "surface",
    refresh: true,
    disableDiscoveryProbes: true,
    // With cloud unavailable the controller resolves no render fetcher itself (an injected one
    // would win), so the fallback case runs on the default plain fetch.
    ...(cloudAvailable === false ? {} : { documentFetcher: hybridFetcher() }),
    cloudRendering: "browser",
    ...(cloudAvailable === undefined ? {} : { cloudAvailable }),
  });
  if (!result.ok) throw new Error(`audit failed: ${result.error.message}`);
  return result.data;
}

describe("the controller saves the render block with the crawl (repo#3094)", () => {
  test("a hybrid audit with a redirect: the stored block is the live block", async () => {
    const live = await audit("render-saved-3094-a");
    // 1 rendered page; the home, /plain and the /old redirect went through plain HTTP.
    expect(live.render).toEqual({
      requested: true,
      mode: "auto",
      pagesRendered: 1,
      pagesFetchedPlain: 3,
    });
    expect(live.scanScope?.render).toBeUndefined();

    const stored = await getStoredAudit(live.crawlId!);
    if (!stored.ok) throw new Error(stored.error.message);
    expect(stored.data.render).toEqual(live.render!);
    expect(stored.data.scanScope?.render).toBeUndefined();
  }, 60_000);

  test("cloud unavailable: the stored block keeps the fallback reason", async () => {
    const live = await audit("render-saved-3094-b", false);
    expect(live.render).toEqual({
      requested: true,
      mode: "http",
      fallbackReason: "cloud unavailable (signed out or unreachable)",
      pagesRendered: 0,
      pagesFetchedPlain: 4,
    });
    expect(live.scanScope?.render).toBeUndefined();

    const stored = await getStoredAudit(live.crawlId!);
    if (!stored.ok) throw new Error(stored.error.message);
    expect(stored.data.render).toEqual(live.render!);
  }, 60_000);
});
