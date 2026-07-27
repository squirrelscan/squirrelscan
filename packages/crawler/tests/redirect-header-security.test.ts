import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { RobotsTxtData } from "@squirrelscan/core-contracts";
import { findClientRedirects } from "@squirrelscan/utils/client-redirects";
import { safeRedirectFetch } from "@squirrelscan/utils/safe-fetch";

import { fetchPage } from "../src/fetcher";
import { fetchRslLicensing } from "../src/rsl";
import { discoverSitemaps, fetchSitemap } from "../src/sitemaps";

// Resolve the URL from a fetch() first argument (string | URL | Request).
function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

describe("standard fetch redirect headers", () => {
  test("strips caller-provided headers when a redirect changes origin", async () => {
    let receivedAuthorization: string | null = null;
    let receivedCustomHeader: string | null = null;

    const target = Bun.serve({
      port: 0,
      fetch(req) {
        receivedAuthorization = req.headers.get("authorization");
        receivedCustomHeader = req.headers.get("x-crawl-secret");
        return new Response("<html>ok</html>", {
          headers: { "content-type": "text/html" },
        });
      },
    });
    const source = Bun.serve({
      port: 0,
      fetch() {
        return new Response(null, {
          status: 302,
          headers: { location: `http://127.0.0.1:${target.port}/final` },
        });
      },
    });

    try {
      const result = await Effect.runPromise(
        fetchPage(`http://127.0.0.1:${source.port}/redirect`, {
          userAgent: "squirrel-test",
          timeoutMs: 5_000,
          followRedirects: true,
          headers: {
            Authorization: "Bearer review-secret",
            "X-Crawl-Secret": "custom-secret", // pragma: allowlist secret
          },
        }),
      );

      expect(result.status).toBe(200);
      expect(receivedAuthorization).toBeNull();
      expect(receivedCustomHeader).toBeNull();
    } finally {
      source.stop(true);
      target.stop(true);
    }
  });
});

// #1392: a hand-rolled manual-redirect loop must NOT follow a cross-protocol
// (non-http/https) redirect target — that is the critical local-file-read /
// scheme-SSRF vector, since crawler.ts stores result.body unconditionally.
describe("cross-protocol redirect refusal (#1392)", () => {
  test("main page fetch refuses an http -> file:// redirect (no local file read)", async () => {
    const source = Bun.serve({
      port: 0,
      fetch() {
        return new Response(null, {
          status: 302,
          headers: { location: "file:///etc/passwd" },
        });
      },
    });

    try {
      const result = await Effect.runPromise(
        fetchPage(`http://127.0.0.1:${source.port}/x`, {
          userAgent: "squirrel-test",
          timeoutMs: 5_000,
          followRedirects: true,
        }),
      );

      // The file:// target is never fetched; the redirect is a terminal error
      // hop and the final URL stays on the http origin.
      expect(result.status).toBe(302);
      expect(result.finalUrl).toContain(`127.0.0.1:${source.port}`);
      expect(result.redirectChain.endsInError).toBe(true);
      // Body must never contain /etc/passwd contents.
      expect(result.body).not.toContain("root:");
    } finally {
      source.stop(true);
    }
  });

  test("safeRedirectFetch throws on a cross-protocol (file://) redirect", async () => {
    const source = Bun.serve({
      port: 0,
      fetch() {
        return new Response(null, {
          status: 302,
          headers: { location: "file:///etc/passwd" },
        });
      },
    });

    try {
      await expect(safeRedirectFetch(`http://127.0.0.1:${source.port}/x`)).rejects.toThrow(
        /non-http/i,
      );
    } finally {
      source.stop(true);
    }
  });
});

// #1395: auxiliary probe fetches carry the user's secret customHeaders. A
// cross-origin redirect must strip them (undici/Bun natively strip only
// authorization/cookie/proxy-authorization/host), while generic browser headers
// (user-agent) survive.
describe("probe fetch cross-origin header stripping (#1395)", () => {
  test("a probe (sitemap) strips secret headers across a cross-origin redirect", async () => {
    let targetSawSecret: string | null = "unset";
    let targetSawUserAgent: string | null = null;

    const target = Bun.serve({
      port: 0,
      fetch(req) {
        targetSawSecret = req.headers.get("x-api-key");
        targetSawUserAgent = req.headers.get("user-agent");
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`,
          { headers: { "content-type": "application/xml" } },
        );
      },
    });
    const source = Bun.serve({
      port: 0,
      fetch() {
        // Different port on 127.0.0.1 == different origin.
        return new Response(null, {
          status: 302,
          headers: { location: `http://127.0.0.1:${target.port}/sitemap.xml` },
        });
      },
    });

    try {
      const result = await Effect.runPromise(
        fetchSitemap(`http://127.0.0.1:${source.port}/sitemap.xml`, "squirrel-test", {
          "X-Api-Key": "supersecret", // pragma: allowlist secret
        }),
      );

      expect(result.success).toBe(true);
      // Secret header dropped on the cross-origin hop; UA (allowlisted) survives.
      expect(targetSawSecret).toBeNull();
      expect(targetSawUserAgent).toBe("squirrel-test");
    } finally {
      source.stop(true);
      target.stop(true);
    }
  });
});

// #1393 / #1394: robots.txt Sitemap:/License: directives are untrusted page
// content. A file:// (or any non-http/https) target must be refused BEFORE any
// fetch is attempted — never fetched, never parsed, never captured.
describe("robots.txt directive scheme refusal (#1393/#1394)", () => {
  test("a Sitemap: file:// directive is refused (never fetched)", async () => {
    const originalFetch = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      requested.push(requestUrl(input));
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const robotsTxt: RobotsTxtData = {
        exists: true,
        url: "https://example.test/robots.txt",
        content: "Sitemap: file:///etc/passwd\n",
        sizeBytes: 0,
        sitemaps: ["file:///etc/passwd"],
        rules: [],
        errors: [],
      };
      const result = await Effect.runPromise(
        discoverSitemaps("https://example.test", robotsTxt, "test-agent", { maxUrls: 50 }),
      );

      expect(requested.some((u) => u.startsWith("file:"))).toBe(false);
      expect(result.failed.some((f) => f.url.startsWith("file:"))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a License: file:// directive is refused (never fetched)", async () => {
    const originalFetch = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = requestUrl(input);
      requested.push(url);
      if (url.endsWith("/robots.txt")) {
        return new Response("License: file:///etc/passwd\n", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;

    try {
      const result = await Effect.runPromise(
        fetchRslLicensing("https://example.test", "test-agent"),
      );

      expect(requested.some((u) => u.startsWith("file:"))).toBe(false);
      // The directive was present, but its file:// target was dropped pre-fetch.
      expect(result.robotsHasLicense).toBe(true);
      expect(result.licenseUrls.length).toBe(0);
      expect(result.documents.length).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// #1396: findMetaRefresh must restrict targets to http/https, like
// findJavaScriptRedirect, so a meta refresh can't point the crawler at a
// file:///data:/javascript: URL.
describe("findMetaRefresh scheme restriction (#1396)", () => {
  const base = "https://example.com/page";

  test("rejects a file:// meta refresh target", () => {
    expect(
      findClientRedirects(
        `<meta http-equiv="refresh" content="0;url=file:///etc/passwd">`,
        base,
      ),
    ).toBeNull();
  });

  test("rejects data: and javascript: meta refresh targets", () => {
    expect(
      findClientRedirects(`<meta http-equiv="refresh" content="0;url=data:text/html,x">`, base),
    ).toBeNull();
    expect(
      findClientRedirects(`<meta http-equiv="refresh" content="0;url=javascript:alert(1)">`, base),
    ).toBeNull();
  });

  test("still follows http(s) and relative meta refresh targets", () => {
    expect(
      findClientRedirects(
        `<meta http-equiv="refresh" content="0;url=https://other.example/next">`,
        base,
      ),
    ).toBe("https://other.example/next");
    expect(
      findClientRedirects(`<meta http-equiv="refresh" content="0;url=/next">`, base),
    ).toBe("https://example.com/next");
  });
});
