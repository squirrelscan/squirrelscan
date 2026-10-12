// The web app manifest fetch (#710) against a real local server: one request per
// manifest however many pages link it, icons resolved against the manifest URL
// (not the page), icon sizes read from the header, and the rule judging the result.

import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseHTML } from "@squirrelscan/parser/dom";

import { mobile, type ParsedPage } from "@squirrelscan/rules";
import { ASSET_FETCH_REFUSED_ERROR } from "@squirrelscan/utils/constants";
import type { EgressPolicy } from "@squirrelscan/utils/public-egress";

import { createSiteAssetCollector, fetchAssetsFromOccurrences } from "../src/adapter";
import { createFetchBudget } from "../src/fetch-budget";
import { checkResourceSizes } from "../src/resource-checker";
import { fetchScriptContents } from "../src/script-fetcher";
import {
  absorbWebAppManifestLinks,
  emptyWebAppManifestOccurrences,
  fetchWebAppManifests,
  type WebAppManifestOccurrences,
} from "../src/web-app-manifest";

/** A PNG header declaring `w` x `h`; only the IHDR is ever parsed. */
function pngHeader(w: number, h: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, w);
  view.setUint32(20, h);
  bytes[24] = 8;
  bytes[25] = 2;
  return bytes;
}

const MANIFEST = {
  name: "Example",
  short_name: "Example",
  start_url: "/app",
  display: "standalone",
  theme_color: "#ffffff",
  icons: [
    // Relative to /static/m.json, so it resolves to /static/icon.png. Declared 512, real 256.
    { src: "icon.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    // Absolute and missing: a 404 the rule must name.
    { src: "/icons/192.png", sizes: "192x192", type: "image/png" },
  ],
};

const hits = new Map<string, number>();
let server: ReturnType<typeof Bun.serve>;
let base = "";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      hits.set(path, (hits.get(path) ?? 0) + 1);
      if (path === "/static/m.json") {
        return new Response(JSON.stringify(MANIFEST), {
          headers: { "content-type": "application/manifest+json" },
        });
      }
      if (path === "/static/icon.png") {
        return new Response(pngHeader(256, 256), { headers: { "content-type": "image/png" } });
      }
      // Same-site manifest paths that redirect off the site: to another host
      // (`localhost` reaches this server, but is not the site's host) and to
      // the metadata address.
      if (path === "/off-site.json") {
        return Response.redirect(`http://localhost:${server.port}/static/m.json`, 302);
      }
      if (path === "/to-metadata.json") {
        return Response.redirect("http://169.254.169.254/latest/meta-data/", 302);
      }
      if (path === "/waf-icons.json") {
        return new Response(
          JSON.stringify({
            ...MANIFEST,
            icons: [
              { src: "/icons/waf.png", sizes: "192x192", type: "image/png" },
              { src: "/icons/busy.png", sizes: "512x512", type: "image/png" },
            ],
          }),
          { headers: { "content-type": "application/manifest+json" } },
        );
      }
      if (path === "/icons/waf.png") {
        return new Response("<html>Just a moment...</html>", {
          status: 403,
          headers: { "content-type": "text/html", server: "cloudflare", "cf-ray": "abc123-LHR" },
        });
      }
      if (path === "/icons/busy.png") {
        return new Response("busy", { status: 429 });
      }
      if (path.startsWith("/many/")) {
        return new Response(JSON.stringify(MANIFEST), {
          headers: { "content-type": "application/manifest+json" },
        });
      }
      return new Response("missing", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

function pageWith(head: string): ParsedPage {
  const { document } = parseHTML(`<html><head>${head}</head><body></body></html>`);
  return { document } as unknown as ParsedPage;
}

const MANIFEST_HEAD = `<link rel="manifest" href="/static/m.json"><meta name="theme-color" content="#FFF">`;

function sameHost(url: string): boolean {
  return new URL(url).host === new URL(base).host;
}

/** Held to the site's host, as the adapter holds a real audit to its own. */
const SITE_EGRESS: EgressPolicy = {
  allowPrivateNetwork: true,
  allowHost: (host) => host === "127.0.0.1",
};

async function fetchAll(occurrences: WebAppManifestOccurrences) {
  return (
    await Effect.runPromise(fetchWebAppManifests(occurrences, { timeoutMs: 5000 }, SITE_EGRESS))
  ).manifests;
}

function judge(webAppManifests: Awaited<ReturnType<typeof fetchAll>>, dropped = 0) {
  return mobile.webAppManifestRule.run({
    page: { url: `${base}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: { baseUrl: base, pages: [], webAppManifests, webAppManifestsDropped: dropped },
    options: {},
  } as Parameters<typeof mobile.webAppManifestRule.run>[0]) as {
    checks: Array<{
      name: string;
      status: string;
      message: string;
      items?: Array<{ id?: string; label?: string }>;
    }>;
  };
}

describe("web app manifest fetch (#710)", () => {
  test("a manifest linked from ten pages is fetched once and listed with all ten pages", async () => {
    hits.clear();
    const occurrences: WebAppManifestOccurrences = emptyWebAppManifestOccurrences();
    const pages = Array.from({ length: 10 }, (_, i) => `${base}/p${i}`);
    for (const page of pages) {
      absorbWebAppManifestLinks(
        occurrences,
        { url: page, parsed: pageWith(MANIFEST_HEAD) },
        sameHost,
      );
    }

    const manifests = await fetchAll(occurrences);

    expect(manifests).toHaveLength(1);
    expect(hits.get("/static/m.json")).toBe(1);
    const [manifest] = manifests;
    expect(manifest?.url).toBe(`${base}/static/m.json`);
    expect(manifest?.status).toBe(200);
    expect(manifest?.sourcePages).toEqual([...pages].sort());
    expect(manifest?.themeColorsByPage[`${base}/p0`]).toEqual([{ content: "#FFF", media: null }]);
  });

  test("icons resolve against the manifest URL and carry the header size; a 404 icon keeps its status", async () => {
    const occurrences = emptyWebAppManifestOccurrences();
    absorbWebAppManifestLinks(
      occurrences,
      { url: `${base}/`, parsed: pageWith(MANIFEST_HEAD) },
      sameHost,
    );

    const [manifest] = await fetchAll(occurrences);

    const big = manifest?.icons.find((icon) => icon.url === `${base}/static/icon.png`);
    expect(big?.status).toBe(200);
    expect(big?.naturalWidth).toBe(256);
    expect(big?.naturalHeight).toBe(256);

    const missing = manifest?.icons.find((icon) => icon.url === `${base}/icons/192.png`);
    expect(missing?.status).toBe(404);
  });

  test("the rule judges the fetched manifest: the size mismatch and the 404 icon are both warnings", async () => {
    const occurrences = emptyWebAppManifestOccurrences();
    absorbWebAppManifestLinks(
      occurrences,
      { url: `${base}/`, parsed: pageWith(MANIFEST_HEAD) },
      sameHost,
    );
    const webAppManifests = await fetchAll(occurrences);

    const result = judge(webAppManifests);

    const [check] = result.checks;
    expect(check?.status).toBe("warn");
    const labels = (check?.items ?? []).map((item) => item.label ?? "").join("\n");
    expect(labels).toContain("declared 512x512 but is 256x256");
    expect(labels).toContain(`${base}/icons/192.png answers HTTP 404`);
  });

  test("the site asset collector records each linked manifest once with every page that links it", () => {
    const collector = createSiteAssetCollector(`${base}/`);
    const siteContext = [0, 1, 2].map((i) => ({
      page: {
        normalizedUrl: `${base}/p${i}`,
        finalUrl: undefined,
        status: 200,
        headers: {},
        securityHeaders: {},
        html: "",
      },
      parsed: { ...pageWith(MANIFEST_HEAD), images: [], links: [] } as unknown as ParsedPage,
    }));
    collector.absorb(siteContext as never);
    const manifests = collector.occurrences.webAppManifests;
    expect(manifests.size).toBe(1);
    expect([...(manifests.get(`${base}/static/m.json`)?.keys() ?? [])]).toEqual([
      `${base}/p0`,
      `${base}/p1`,
      `${base}/p2`,
    ]);
  });

  test("a manifest on another host is never fetched", async () => {
    const occurrences = emptyWebAppManifestOccurrences();
    absorbWebAppManifestLinks(
      occurrences,
      {
        url: `${base}/`,
        parsed: pageWith(`<link rel="manifest" href="https://elsewhere.invalid/m.json">`),
      },
      sameHost,
    );
    expect(occurrences.size).toBe(0);
    const manifests = await fetchAll(occurrences);
    expect(manifests).toEqual([]);
  });

  test("a manifest that answers 404 is kept with its status and no body", async () => {
    const occurrences = emptyWebAppManifestOccurrences();
    absorbWebAppManifestLinks(
      occurrences,
      { url: `${base}/`, parsed: pageWith(`<link rel="manifest" href="/gone.webmanifest">`) },
      sameHost,
    );
    const [manifest] = await fetchAll(occurrences);
    expect(manifest?.status).toBe(404);
    expect(manifest?.content).toBeNull();
    expect(manifest?.icons).toEqual([]);
  });

  test("a same-site manifest that redirects to another host is not fetched there", async () => {
    hits.clear();
    const occurrences = emptyWebAppManifestOccurrences();
    absorbWebAppManifestLinks(
      occurrences,
      { url: `${base}/`, parsed: pageWith(`<link rel="manifest" href="/off-site.json">`) },
      sameHost,
    );
    const [manifest] = await fetchAll(occurrences);
    expect(manifest?.error).toBe(ASSET_FETCH_REFUSED_ERROR);
    // The redirect was answered, its target on the other host never requested.
    expect(hits.get("/off-site.json")).toBe(1);
    expect(hits.get("/static/m.json")).toBeUndefined();
    const [check] = judge([manifest!]).checks;
    expect(check?.status).toBe("info");
    expect(check?.message).toContain("redirects off the site");
  });

  test("a same-site manifest that redirects to the metadata address is refused", async () => {
    const occurrences = emptyWebAppManifestOccurrences();
    absorbWebAppManifestLinks(
      occurrences,
      { url: `${base}/`, parsed: pageWith(`<link rel="manifest" href="/to-metadata.json">`) },
      sameHost,
    );
    const [manifest] = await fetchAll(occurrences);
    expect(manifest?.error).toBe(ASSET_FETCH_REFUSED_ERROR);
    expect(judge([manifest!]).checks[0]?.status).toBe("info");
  });

  test("an icon answered by a WAF challenge or a 429 is not checked, never a broken icon", async () => {
    const occurrences = emptyWebAppManifestOccurrences();
    absorbWebAppManifestLinks(
      occurrences,
      { url: `${base}/`, parsed: pageWith(`<link rel="manifest" href="/waf-icons.json">`) },
      sameHost,
    );
    const [manifest] = await fetchAll(occurrences);
    expect(manifest?.icons.find((i) => i.url.endsWith("/icons/waf.png"))?.wafBlocked).toBe(true);
    expect(manifest?.icons.find((i) => i.url.endsWith("/icons/busy.png"))?.rateLimited).toBe(true);
    const [check] = judge([manifest!]).checks;
    const items = check?.items ?? [];
    expect(items.some((item) => item.id === "icon-status")).toBe(false);
    expect(items.filter((item) => item.id === "icon-unverified")).toHaveLength(2);
  });

  test("a relative manifest link resolves against <base href>, not the page path", () => {
    const occurrences = emptyWebAppManifestOccurrences();
    absorbWebAppManifestLinks(
      occurrences,
      {
        url: `${base}/blog/post-1`,
        parsed: pageWith(`<base href="/"><link rel="manifest" href="manifest.webmanifest">`),
      },
      sameHost,
    );
    expect([...occurrences.keys()]).toEqual([`${base}/manifest.webmanifest`]);
  });

  test("a non-http manifest link is not collected", () => {
    const occurrences = emptyWebAppManifestOccurrences();
    absorbWebAppManifestLinks(
      occurrences,
      { url: `${base}/`, parsed: pageWith(`<link rel="manifest" href="ftp://127.0.0.1/m.json">`) },
      () => true,
    );
    expect(occurrences.size).toBe(0);
  });

  test("refusals and manifest 404s are not tarpit strikes against the site's host", async () => {
    const budget = createFetchBudget({ tarpitLatencyMs: 60_000, tarpitStrikes: 1 });
    // Icons that redirect off the site: refused, nothing sent.
    await Effect.runPromise(
      checkResourceSizes([`${base}/off-site.json`, `${base}/to-metadata.json`], {
        timeoutMs: 5000,
        egress: SITE_EGRESS,
        budget,
      }),
    );
    // Manifests that answer 404: an answer, not a failing host.
    await Effect.runPromise(
      fetchScriptContents([`${base}/gone-1.webmanifest`, `${base}/gone-2.webmanifest`], {
        timeoutMs: 5000,
        anyContentType: true,
        egress: SITE_EGRESS,
        budget,
      }),
    );
    expect(budget.summary().tarpitHosts).toEqual([]);
    expect(budget.shouldSkip(`${base}/static/m.json`)).toBe(false);
  });

  test("with the rule disabled, no manifest is fetched and the rule data is absent", async () => {
    hits.clear();
    const collector = createSiteAssetCollector(`${base}/`);
    collector.absorb([
      {
        page: {
          normalizedUrl: `${base}/`,
          finalUrl: undefined,
          status: 200,
          headers: {},
          securityHeaders: {},
          html: "",
        },
        parsed: { ...pageWith(MANIFEST_HEAD), images: [], links: [] } as unknown as ParsedPage,
      },
    ] as never);
    const storage = {
      getCrawl: () => Effect.succeed({ baseUrl: `${base}/` }),
      getSitemaps: () => Effect.succeed([]),
      getCachedResources: () => Effect.succeed([]),
      getRobotsTxt: () => Effect.succeed(null),
    } as unknown as Parameters<typeof fetchAssetsFromOccurrences>[0];
    const config = {
      rules: { enable: ["*"], disable: ["mobile/web-app-manifest"] },
      internal_links: { enabled: false },
    } as unknown as Parameters<typeof fetchAssetsFromOccurrences>[3];
    const assets = await Effect.runPromise(
      fetchAssetsFromOccurrences(storage, "crawl", collector.occurrences, config),
    );
    expect(assets.webAppManifests).toBeUndefined();
    expect(hits.get("/static/m.json")).toBeUndefined();
  });

  test("manifests past the per-site cap are counted, and the rule says so", async () => {
    const occurrences = emptyWebAppManifestOccurrences();
    for (let n = 0; n < 7; n++) {
      absorbWebAppManifestLinks(
        occurrences,
        { url: `${base}/p${n}`, parsed: pageWith(`<link rel="manifest" href="/many/${n}.json">`) },
        sameHost,
      );
    }
    const fetched = await Effect.runPromise(
      fetchWebAppManifests(occurrences, { timeoutMs: 5000 }, SITE_EGRESS),
    );
    expect(fetched.manifests).toHaveLength(5);
    expect(fetched.dropped).toBe(2);
    const note = judge(fetched.manifests, fetched.dropped).checks.find(
      (c) => c.name === "web-app-manifest-unchecked",
    );
    expect(note?.status).toBe("info");
    expect(note?.message).toContain("2 more linked web app manifest(s) not checked");
  });
});
