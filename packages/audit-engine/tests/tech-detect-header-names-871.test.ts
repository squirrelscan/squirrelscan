// pub#871: a local audit detects technologies from the page records the
// crawler stores, and the crawler kept only a fixed header subset, so a
// header-only fingerprint (`X-CDN: Imperva`, `X-Sucuri-ID`) never matched. The
// crawler now keeps every header the fingerprints and WAF providers read, by
// name, each value capped.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { createCrawler, SQLiteStorage } from "@squirrelscan/crawler";
import { ALL_FINGERPRINTS } from "@squirrelscan/tech-detect";
import {
  TECH_DETECT_HEADER_MAX_CHARS,
  TECH_DETECT_HEADER_NAMES,
  TECH_DETECT_MAX_COOKIE_NAMES,
  TECH_DETECT_PRESENCE_HEADERS,
} from "@squirrelscan/utils/constants";
import { overlayTechHeaders, techCookieNames } from "@squirrelscan/utils/headers";
import { HEADER_PATTERNS } from "@squirrelscan/waf-detect";

import { buildTechHeadersMap } from "../src/adapter";

describe("TECH_DETECT_HEADER_NAMES (pub#871)", () => {
  const listed = new Set<string>(TECH_DETECT_HEADER_NAMES);

  test("lists every header a fingerprint reads (Set-Cookie has its own field)", () => {
    const missing = ALL_FINGERPRINTS.flatMap((fp) =>
      fp.detectors.flatMap((d) => (d.type === "header" ? [d.name.toLowerCase()] : [])),
    ).filter((name) => name !== "set-cookie" && !listed.has(name));
    expect([...new Set(missing)]).toEqual([]);
  });

  test("lists every header a WAF provider reads", () => {
    const missing = HEADER_PATTERNS.flatMap((p) =>
      p.headers.map((h) => h.name.toLowerCase()),
    ).filter((name) => !listed.has(name));
    expect([...new Set(missing)]).toEqual([]);
  });

  test("the presence-only set is exactly the headers no reader matches by value", () => {
    // A reader matches by value unless its pattern accepts anything, or its
    // fingerprint reads a version (from any header value).
    const byValue = new Set<string>();
    const all = new Set<string>();
    for (const fp of ALL_FINGERPRINTS) {
      for (const d of fp.detectors) {
        if (d.type !== "header") continue;
        const name = d.name.toLowerCase();
        all.add(name);
        if (![".+", ".*"].includes(d.pattern.source) || fp.versionPattern) byValue.add(name);
      }
    }
    for (const p of HEADER_PATTERNS) {
      for (const h of p.headers) {
        all.add(h.name.toLowerCase());
        if (h.pattern) byValue.add(h.name.toLowerCase());
      }
    }
    const presence = [...all].filter((n) => n !== "set-cookie" && !byValue.has(n)).sort();
    expect([...TECH_DETECT_PRESENCE_HEADERS].sort()).toEqual(presence);
  });

  test("names are lower case and listed once", () => {
    for (const name of TECH_DETECT_HEADER_NAMES) expect(name).toBe(name.toLowerCase());
    expect(listed.size).toBe(TECH_DETECT_HEADER_NAMES.length);
  });
});

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

describe("the crawler stores the headers technology detection reads (pub#871)", () => {
  test("listed headers are kept, capped; others are not", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          "<!doctype html><html><head><title>Fixture</title></head><body>x</body></html>",
          {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "X-CDN": "Imperva",
              "x-sucuri-id": "18015",
              "x-kpsdk-ct": "kasada-client-token",
              via: `1.1 ${"v".repeat(2000)}`,
              "x-not-a-fingerprint": "1",
              "set-cookie": "PHPSESSID=secret-session-value; Path=/",
            },
          },
        ),
    });
    servers.push(server);
    const origin = `http://localhost:${server.port}`;
    const crawler = await Effect.runPromise(
      createCrawler({
        config: {
          maxPages: 1,
          concurrency: 1,
          perHostConcurrency: 1,
          delayMs: 0,
          perHostDelayMs: 0,
          timeoutMs: 5_000,
          userAgent: "squirrel-test",
          respectRobots: false,
          incremental: false,
          useCacheControl: false,
        },
      }),
    );
    const crawlId = await Effect.runPromise(crawler.start(`${origin}/`, `${origin}/`));
    const [page] = await Effect.runPromise(crawler.storage.getPages(crawlId));
    const tech = page?.headers.techHeaders ?? {};
    expect(tech["x-cdn"]).toBe("Imperva");
    // Presence-only headers keep a marker, not the value (a token here).
    expect(tech["x-sucuri-id"]).toBe("1");
    expect(tech["x-kpsdk-ct"]).toBe("1");
    expect(tech.via?.length).toBe(TECH_DETECT_HEADER_MAX_CHARS);
    expect(tech["set-cookie"]).toBe("PHPSESSID=");
    expect(Object.keys(tech).sort()).toEqual([
      "set-cookie",
      "via",
      "x-cdn",
      "x-kpsdk-ct",
      "x-sucuri-id",
    ]);
  });
});

// An incremental crawl that refetches an unchanged page reuses the stored
// record, curated headers and all. The detection headers come from the
// response just fetched, and win in the map detection reads.
test("an unchanged page refetched by an incremental crawl takes the new detection headers", async () => {
  let extra: Record<string, string> = { "x-powered-by": "Express", "set-cookie": "sid=1" };
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response("<!doctype html><html><head><title>t</title></head><body>same</body></html>", {
        headers: { "content-type": "text/html", ...extra },
      }),
  });
  servers.push(server);
  const origin = `http://localhost:${server.port}`;
  const storage = new SQLiteStorage(":memory:");
  await Effect.runPromise(storage.init());
  const crawl = async () => {
    const crawler = await Effect.runPromise(
      createCrawler({
        storage,
        config: {
          maxPages: 1,
          concurrency: 1,
          perHostConcurrency: 1,
          delayMs: 0,
          perHostDelayMs: 0,
          timeoutMs: 5_000,
          userAgent: "squirrel-test",
          respectRobots: false,
          incremental: true,
          useCacheControl: false,
        },
      }),
    );
    const crawlId = await Effect.runPromise(crawler.start(`${origin}/`, `${origin}/`));
    return (await Effect.runPromise(storage.getPages(crawlId)))[0];
  };
  expect((await crawl())?.headers.techHeaders?.["x-powered-by"]).toBe("Express");
  extra = { "x-powered-by": "Next.js" };
  const page = await crawl();
  // The record was reused: its curated fields still hold the old values.
  expect(page?.headers.xPoweredBy).toBe("Express");
  expect(page?.headers.setCookie).toBe("sid=1");
  expect(page?.headers.techHeaders?.["x-powered-by"]).toBe("Next.js");
  const map = page ? buildTechHeadersMap(page) : {};
  expect(map["x-powered-by"]).toBe("Next.js");
  // A cookie the response stopped setting is gone from the detection map.
  expect(map["set-cookie"]).toBeUndefined();
  extra = {};
  const bare = await crawl();
  expect(bare?.headers.techHeaders).toBeNull();
  expect(bare ? buildTechHeadersMap(bare)["x-powered-by"] : "missing").toBeUndefined();
});

describe("overlayTechHeaders (pub#871)", () => {
  const curated = () => ({
    server: "nginx",
    "x-powered-by": "Express",
    "set-cookie": "a=1",
    etag: "x",
  });
  test("a record without detection headers keeps the curated map", () => {
    expect(overlayTechHeaders(curated(), undefined)).toEqual(curated());
  });
  test("detection headers speak for every name detection reads, absent ones included", () => {
    expect(overlayTechHeaders(curated(), null)).toEqual({ etag: "x" });
    expect(overlayTechHeaders(curated(), { server: "Vercel" })).toEqual({
      etag: "x",
      server: "Vercel",
    });
  });
});

describe("techCookieNames (pub#871)", () => {
  test("a name ends at = or ;, so attributes never join it", () => {
    expect(techCookieNames(["sid=abc; Path=/", "foo; Secure", " bar = 1"])).toBe(
      "sid=\nfoo=\nbar=",
    );
  });
  test("names are listed once, none for no cookies", () => {
    expect(techCookieNames(["a=1", "a=2"])).toBe("a=");
    expect(techCookieNames([])).toBeNull();
    expect(techCookieNames(["=1", ";x"])).toBeNull();
  });
  test("names are kept whole: an over-long one is left out, and the count is capped", () => {
    const long = "x".repeat(TECH_DETECT_HEADER_MAX_CHARS + 1);
    expect(techCookieNames([`${long}=1`, "ok=1"])).toBe("ok=");
    const many = Array.from({ length: TECH_DETECT_MAX_COOKIE_NAMES + 10 }, (_, i) => `c${i}=1`);
    expect(techCookieNames(many)?.split("\n")).toHaveLength(TECH_DETECT_MAX_COOKIE_NAMES);
  });
});
