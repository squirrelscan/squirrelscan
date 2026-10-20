// #732: the audit's custom headers go to the audited origin and the hosts the
// user names, not to every subdomain. Two loopback servers: a different port is
// a different origin, standing in for a subdomain.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { createHeaderScope } from "../src/lib/header-scope";
import { checkResourceSizes } from "../src/resource-checker";
import { fetchScriptContents } from "../src/script-fetcher";

const SECRET = { "X-Api-Key": "audit-secret" };
const seen: Record<"site" | "cdn", Array<string | null>> = { site: [], cdn: [] };
let site: ReturnType<typeof Bun.serve>;
let cdn: ReturnType<typeof Bun.serve>;

const serve = (which: "site" | "cdn") =>
  Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      seen[which].push(req.headers.get("x-api-key"));
      if (
        new URL(req.url).pathname.endsWith(".js") &&
        which === "cdn" &&
        !req.headers.get("x-api-key")
      ) {
        return new Response("no", { status: 401 });
      }
      return new Response("body{}", { headers: { "content-type": "text/css" } });
    },
  });

beforeAll(() => {
  site = serve("site");
  cdn = serve("cdn");
});
afterAll(() => {
  site.stop(true);
  cdn.stop(true);
});
const reset = () => {
  seen.site.length = 0;
  seen.cdn.length = 0;
};
const siteUrl = (p: string) => `http://127.0.0.1:${site.port}${p}`;
const cdnUrl = (p: string) => `http://127.0.0.1:${cdn.port}${p}`;

describe("createHeaderScope", () => {
  test("the audited origin only: scheme, host and port", () => {
    const scope = createHeaderScope("https://www.example.com/");
    expect(scope("https://www.example.com/a.js")).toBe(true);
    expect(scope("https://cdn.example.com/a.js")).toBe(false);
    expect(scope("https://example.com/a.js")).toBe(false);
    expect(scope("https://www.example.com:8443/a.js")).toBe(false);
    expect(scope("http://www.example.com/a.js")).toBe(false);
  });

  test("named hosts get them, by host alone", () => {
    const scope = createHeaderScope("https://example.com/", [
      "Assets.Example.com",
      "https://cf.example.net/x",
    ]);
    expect(scope("https://assets.example.com:444/a.js")).toBe(true);
    expect(scope("https://cf.example.net/a.js")).toBe(true);
    expect(scope("https://other.example.com/a.js")).toBe(false);
  });
});

describe("asset pools", () => {
  const scope = () => createHeaderScope(siteUrl("/"));
  const opts = () => ({ customHeaders: SECRET, headerScope: scope() });

  // Stylesheets, images, fonts, PDFs, sitemap URLs and manifest icons all go
  // through checkResourceSizes; scripts and preloads through fetchScriptContents.
  {
    test("checkResourceSizes pools: the other origin gets no custom header, the audited one does", async () => {
      reset();
      await Effect.runPromise(checkResourceSizes([siteUrl("/a.css"), cdnUrl("/a.css")], opts()));
      expect(seen.site.every((v) => v === "audit-secret")).toBe(true);
      expect(seen.site.length).toBeGreaterThan(0);
      expect(seen.cdn.length).toBeGreaterThan(0);
      expect(seen.cdn.every((v) => v === null)).toBe(true);
    });
  }

  test("script and preload pool", async () => {
    reset();
    await Effect.runPromise(fetchScriptContents([siteUrl("/a.js"), cdnUrl("/a.js")], opts()));
    expect(seen.site.every((v) => v === "audit-secret")).toBe(true);
    expect(seen.cdn.length).toBeGreaterThan(0);
    expect(seen.cdn.every((v) => v === null)).toBe(true);
  });

  test("a named host gets them", async () => {
    reset();
    await Effect.runPromise(
      checkResourceSizes([cdnUrl("/a.css")], {
        customHeaders: SECRET,
        headerScope: createHeaderScope(siteUrl("/"), ["127.0.0.1"]),
      }),
    );
    expect(seen.cdn.every((v) => v === "audit-secret")).toBe(true);
  });
});
