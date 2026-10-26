import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { createHeaderScope } from "@squirrelscan/utils/headers";

import { fetchRslLicensing } from "../src/rsl";
import type { RobotsTxtData } from "@squirrelscan/core-contracts";

import { discoverSitemaps, fetchSitemap } from "../src/sitemaps";

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
    await Effect.runPromise(
      fetchSitemap(sitemapUrl, "test-agent", SECRET, createHeaderScope(BASE_ORIGIN)),
    );
    // A negative result only means something if the URL was really requested.
    expect(seen.some((s) => s.url === sitemapUrl)).toBe(true);
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
      expect(seen.some((s) => s.url === licenseUrl)).toBe(true);
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

describe("discoverSitemaps threads the audited origin to child sitemaps (#959)", () => {
  const INDEX = "https://example.test/sitemap-index.xml";
  const CHILD_SAME = "https://example.test/child-same.xml";
  const CHILD_HTTP = "http://example.test/child-http.xml";
  const CHILD_PORT = "https://example.test:8443/child-port.xml";
  const INDEX_XML = `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${[
    CHILD_SAME,
    CHILD_HTTP,
    CHILD_PORT,
  ]
    .map((u) => `<sitemap><loc>${u}</loc></sitemap>`)
    .join("")}</sitemapindex>`;

  const robots: RobotsTxtData = {
    exists: true,
    url: "https://example.test/robots.txt",
    content: `Sitemap: ${INDEX}\n`,
    sizeBytes: 0,
    sitemaps: [INDEX],
    rules: [],
    errors: [],
  };

  test("the index and a same-origin child carry the headers; other schemes and ports do not", async () => {
    const seen = await withFetch(
      (url) =>
        url === INDEX
          ? new Response(INDEX_XML, { headers: { "content-type": "application/xml" } })
          : url === CHILD_SAME || url === CHILD_HTTP || url === CHILD_PORT
            ? xml()
            : new Response("not found", { status: 404 }),
      async (recorded) => {
        await Effect.runPromise(
          discoverSitemaps(BASE_ORIGIN, robots, "test-agent", {
            maxUrls: 50,
            customHeaders: SECRET,
          }),
        );
        return recorded.slice();
      },
    );
    const tokenOf = (url: string) => {
      const hit = seen.find((s) => s.url === url);
      expect(hit).toBeDefined();
      return hit!.token;
    };
    expect(tokenOf(INDEX)).toBe("secret");
    expect(tokenOf(CHILD_SAME)).toBe("secret");
    expect(tokenOf(CHILD_HTTP)).toBeNull();
    // A child on another port is not crawled at all (the walk stays on the parent's
    // host and port); if it ever were, it must not carry the headers.
    expect(seen.find((s) => s.url === CHILD_PORT)?.token ?? null).toBeNull();
  });
});

describe("a robots.txt Sitemap line on plain http is requested without the headers (#959)", () => {
  const PLAIN = "http://example.test/robots-sitemap.xml";
  const robots: RobotsTxtData = {
    exists: true,
    url: "https://example.test/robots.txt",
    content: `Sitemap: ${PLAIN}\n`,
    sizeBytes: 0,
    sitemaps: [PLAIN],
    rules: [],
    errors: [],
  };

  test("the http: sitemap is fetched with no custom headers; a named host over https keeps them", async () => {
    const seen = await withFetch(
      () => xml(),
      async (recorded) => {
        await Effect.runPromise(
          discoverSitemaps(BASE_ORIGIN, robots, "test-agent", {
            maxUrls: 50,
            customHeaders: SECRET,
            headerScope: createHeaderScope(BASE_ORIGIN, ["named.test"]),
          }),
        );
        return recorded.slice();
      },
    );
    const hit = seen.find((s) => s.url === PLAIN);
    expect(hit).toBeDefined();
    expect(hit?.token).toBeNull();
    expect(seen.find((s) => s.url === "https://example.test/sitemap.xml")?.token).toBe("secret");
  });
});
