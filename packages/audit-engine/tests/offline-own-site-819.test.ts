// squirrelscan/squirrelscan#819: `squirrel audit --offline` holds every request
// to the audited site. Real loopback servers: `127.0.0.1` is the site and
// `localhost` another host that reaches a second server, which records the
// `Host` header of every request it gets. Each case asserts that second host
// got nothing, and each has a control without the policy where it does get the
// request, so the absence is the policy and not a mock miss.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { parseDocument, parsePage } from "@squirrelscan/parser";
import { createHeaderScope } from "@squirrelscan/utils/headers";
import { ownSiteHostMatcher } from "@squirrelscan/utils/own-site";
import { ASSET_FETCH_REFUSED_ERROR } from "@squirrelscan/utils/constants";
import { EgressRefusedError, type EgressPolicy } from "@squirrelscan/utils/public-egress";

import {
  absorbResourceOccurrences,
  emptySiteAssetOccurrences,
  fetchAssetsFromOccurrences,
  probeEgress,
} from "../src/adapter";
import { runCloakingProbe } from "../src/cloaking-probe";
import { probeFetch } from "../src/lib/probe-fetch";
import { checkResourceSizes } from "../src/resource-checker";
import { confirmSoft404Candidates } from "../src/soft404-confirm";

const SHELL_HTML = `<!doctype html><html id="__next_error__"><head><meta name="robots" content="noindex"><title>Page Not Found</title></head><body><main><h1>Page Not Found</h1></main></body></html>`;

type Seen = { path: string; host: string | null };
const otherSeen: Seen[] = [];
let site: ReturnType<typeof Bun.serve>;
let other: ReturnType<typeof Bun.serve>;
let siteBase: string;

beforeAll(() => {
  other = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      otherSeen.push({ path, host: req.headers.get("host") });
      if (path.endsWith(".css")) {
        return new Response("body{}", { headers: { "content-type": "text/css" } });
      }
      return new Response(SHELL_HTML, { headers: { "content-type": "text/html" } });
    },
  });
  site = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/cross" || path === "/off.css") {
        const target = path === "/off.css" ? "/stolen.css" : "/landed";
        return new Response(null, {
          status: 302,
          headers: { location: `http://localhost:${other.port}${target}` },
        });
      }
      if (path === "/own.css") {
        return new Response("body{}", { headers: { "content-type": "text/css" } });
      }
      return new Response(SHELL_HTML, { headers: { "content-type": "text/html" } });
    },
  });
  siteBase = `http://127.0.0.1:${site.port}`;
});

afterAll(() => {
  site.stop(true);
  other.stop(true);
});

beforeEach(() => {
  otherSeen.length = 0;
});

/** The audited site only: its host, its www or apex twin and its subdomains. */
const offlinePolicy = (): EgressPolicy => ({
  allowPrivateNetwork: true,
  // `localhost` resolves to the loopback server whatever the machine's resolver says.
  resolve: async () => ["127.0.0.1"],
  allowHost: ownSiteHostMatcher({ baseUrl: siteBase }),
});
const onlinePolicy = (): EgressPolicy => {
  const { allowHost: _drop, ...rest } = offlinePolicy();
  return rest;
};

describe("probeFetch", () => {
  test("offline: a redirect to another host is refused and that host gets no request", async () => {
    await expect(probeFetch(`${siteBase}/cross`, {}, offlinePolicy())).rejects.toBeInstanceOf(
      EgressRefusedError,
    );
    expect(otherSeen).toEqual([]);
  });

  test("control: without the policy the other host is requested, by its own name", async () => {
    const res = await probeFetch(`${siteBase}/cross`, {}, onlinePolicy());
    await res.text();
    expect(otherSeen).toHaveLength(1);
    expect(otherSeen[0]?.host).toBe(`localhost:${other.port}`);
  });
});

describe("cloaking probe", () => {
  const opts = (egress: EgressPolicy) => ({
    maxPages: 1,
    recentDays: 14,
    queryVariation: false,
    googlebotUserAgent: "Googlebot",
    defaultUserAgent: "Browser",
    egress,
  });

  test("offline: nothing is sent to another host", async () => {
    const [probe] = await runCloakingProbe(
      [{ url: `${siteBase}/cross`, reason: "orphan" }],
      opts(offlinePolicy()),
    );
    expect(probe?.defaultStatus).toBe(0);
    expect(otherSeen).toEqual([]);
  });

  test("control: without the policy it is", async () => {
    await runCloakingProbe([{ url: `${siteBase}/cross`, reason: "orphan" }], opts(onlinePolicy()));
    expect(otherSeen.length).toBeGreaterThan(0);
  });
});

describe("soft-404 confirmation", () => {
  const run = async (egress: EgressPolicy) => {
    const url = `${siteBase}/cross`;
    const parsed = parsePage(SHELL_HTML, url);
    await confirmSoft404Candidates([{ url, statusCode: 200, parsed }], {
      userAgent: "test-agent",
      headerScope: createHeaderScope(siteBase),
      egress,
    });
    return parsed;
  };

  test("offline: nothing is sent to another host, and the candidate stays unconfirmed", async () => {
    const parsed = await run(offlinePolicy());
    expect(otherSeen).toEqual([]);
    expect(parsed.soft404Confirmation).toBe("unconfirmed");
  });

  test("control: without the policy it is", async () => {
    await run(onlinePolicy());
    expect(otherSeen.length).toBeGreaterThan(0);
  });
});

describe("asset checks", () => {
  test("offline: a first-party asset that redirects to another host is refused there", async () => {
    const [result] = await Effect.runPromise(
      checkResourceSizes([`${siteBase}/off.css`], { egress: offlinePolicy(), statusOnly: true }),
    );
    expect(result?.error).toBe(ASSET_FETCH_REFUSED_ERROR);
    expect(otherSeen).toEqual([]);
  });

  test("control: without the policy the redirect is followed", async () => {
    const [result] = await Effect.runPromise(
      checkResourceSizes([`${siteBase}/off.css`], { egress: onlinePolicy(), statusOnly: true }),
    );
    expect(result?.status).toBe(200);
    expect(otherSeen).toHaveLength(1);
  });

  test("the asset phase with ownSiteOnly: the site's own asset is checked, its redirect off-site is not followed", async () => {
    const occurrences = emptySiteAssetOccurrences();
    const doc = `<html><head><link rel="stylesheet" href="${siteBase}/own.css"><link rel="stylesheet" href="${siteBase}/off.css"></head><body></body></html>`;
    absorbResourceOccurrences(
      occurrences,
      [
        {
          url: `${siteBase}/`,
          finalUrl: `${siteBase}/`,
          parsed: { document: parseDocument(doc), images: [] } as never,
          hasCsp: false,
        },
      ],
      siteBase,
    );
    occurrences.pageCount = 1;
    const storage = {
      getCrawl: () => Effect.succeed({ baseUrl: siteBase }),
      getSitemaps: () => Effect.succeed([]),
      getCachedResources: () => Effect.succeed([]),
      getRobotsTxt: () => Effect.succeed(null),
    } as never;
    const config = { rules: { enable: ["*"], disable: [] } } as never;
    const assets = await Effect.runPromise(
      fetchAssetsFromOccurrences(storage, "crawl", occurrences, config, { ownSiteOnly: true }),
    );
    const css = assets.resourceSizes.css;
    expect(css.find((r) => r.url === `${siteBase}/own.css`)?.status).toBe(200);
    expect(css.find((r) => r.url === `${siteBase}/off.css`)?.error).toBe(ASSET_FETCH_REFUSED_ERROR);
    expect(otherSeen).toEqual([]);
  });
});

describe("what counts as an asset on the site", () => {
  const page = (html: string) => ({
    url: "https://www.example.com/",
    finalUrl: "https://www.example.com/",
    parsed: { document: parseDocument(html), images: [] } as never,
    hasCsp: false,
  });
  const html = `<html><head>
    <link rel="stylesheet" href="https://example.com/twin.css">
    <link rel="stylesheet" href="https://assets.brand.test/brand.css">
    <link rel="stylesheet" href="https://cdn.other.test/other.css">
  </head><body></body></html>`;

  test("by default the twin and a project domain are third parties, as before", () => {
    const occurrences = emptySiteAssetOccurrences();
    absorbResourceOccurrences(occurrences, [page(html)], "https://www.example.com/");
    expect([...occurrences.css.keys()]).toEqual([]);
    expect([...occurrences.externalCss.keys()].sort()).toEqual([
      "https://assets.brand.test/brand.css",
      "https://cdn.other.test/other.css",
      "https://example.com/twin.css",
    ]);
  });

  test("offline: the www or apex twin and a project domain are the site's own", () => {
    const occurrences = emptySiteAssetOccurrences();
    absorbResourceOccurrences(
      occurrences,
      [page(html)],
      "https://www.example.com/",
      ownSiteHostMatcher({ baseUrl: "https://www.example.com/", domains: ["brand.test"] }),
    );
    expect([...occurrences.css.keys()].sort()).toEqual([
      "https://assets.brand.test/brand.css",
      "https://example.com/twin.css",
    ]);
    expect([...occurrences.externalCss.keys()]).toEqual(["https://cdn.other.test/other.css"]);
  });
});

describe("probeEgress", () => {
  const config = { project: { domains: ["brand.test"] } } as never;

  test("ownSiteOnly holds the end-of-crawl probes to the site and its project domains", () => {
    const policy = probeEgress("https://example.com/", config, undefined, undefined, true);
    expect(policy.allowHost?.("example.com")).toBe(true);
    expect(policy.allowHost?.("www.example.com")).toBe(true);
    expect(policy.allowHost?.("assets.brand.test")).toBe(true);
    expect(policy.allowHost?.("other.test")).toBe(false);
  });

  test("it sets no host restriction otherwise", () => {
    expect(probeEgress("https://example.com/", config).allowHost).toBeUndefined();
    expect(
      probeEgress("https://example.com/", config, undefined, undefined, false).allowHost,
    ).toBeUndefined();
  });
});
