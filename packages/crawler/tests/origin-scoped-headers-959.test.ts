import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { fetchRslLicensing } from "../src/rsl";
import { fetchSitemap } from "../src/sitemaps";

const SECRET = { "X-Audit-Token": "secret" };
const BASE_ORIGIN = "https://example.test";

type Seen = { url: string; token: string | null };

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

// Stub global fetch; record each URL with the custom header it carried.
async function withFetch<T>(
  respond: (url: string) => Response,
  run: (seen: Seen[]) => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
    seen.push({ url, token: headers.get("x-audit-token") });
    return respond(url);
  }) as typeof fetch;
  try {
    return await run(seen);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const SITEMAP_XML =
  '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.test/a</loc></url></urlset>';
const xml = () => new Response(SITEMAP_XML, { headers: { "content-type": "application/xml" } });

async function tokenFor(sitemapUrl: string): Promise<string | null> {
  return withFetch(xml, async (seen) => {
    await Effect.runPromise(fetchSitemap(sitemapUrl, "test-agent", SECRET, BASE_ORIGIN));
    return seen.find((s) => s.url === sitemapUrl)?.token ?? null;
  });
}

describe("sitemap fetch scopes custom headers to the audited origin (#959)", () => {
  test("exact origin keeps the headers", async () => {
    expect(await tokenFor("https://example.test/sitemap.xml")).toBe("secret");
  });

  test("same host on http: gets no headers", async () => {
    expect(await tokenFor("http://example.test/sitemap.xml")).toBeNull();
  });

  test("same host on a different port gets no headers", async () => {
    expect(await tokenFor("https://example.test:8443/sitemap.xml")).toBeNull();
  });

  test("an explicit default port is still the same origin", async () => {
    expect(await tokenFor("https://example.test:443/sitemap.xml")).toBe("secret");
  });
});

const RSL_XML = '<?xml version="1.0"?><rsl xmlns="https://rslstandard.org/rsl"></rsl>';

async function licenseTokens(licenseUrl: string): Promise<string | null> {
  return withFetch(
    (url) =>
      url.endsWith("/robots.txt")
        ? new Response(`License: ${licenseUrl}\n`, { headers: { "content-type": "text/plain" } })
        : new Response(RSL_XML, { headers: { "content-type": "application/rsl+xml" } }),
    async (seen) => {
      await Effect.runPromise(fetchRslLicensing(BASE_ORIGIN, "test-agent", SECRET));
      return seen.find((s) => s.url === licenseUrl)?.token ?? null;
    },
  );
}

describe("license fetch scopes custom headers to the audited origin (#959)", () => {
  test("exact origin keeps the headers", async () => {
    expect(await licenseTokens("https://example.test/license.xml")).toBe("secret");
  });

  test("same host on http: gets no headers", async () => {
    expect(await licenseTokens("http://example.test/license.xml")).toBeNull();
  });

  test("same host on a different port gets no headers", async () => {
    expect(await licenseTokens("https://example.test:8443/license.xml")).toBeNull();
  });
});
