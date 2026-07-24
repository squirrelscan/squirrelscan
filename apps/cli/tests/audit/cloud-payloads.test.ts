// Cloud page payload construction: per-page fields must stay bounded so a
// batch request body can never blow the API's 5MB limit (the nytimes 40-page
// incident — one 20-page batch 413'd and silently lost all its results).

import type { SiteMetadata } from "@squirrelscan/core-contracts";
import type { PageRecord } from "@squirrelscan/core-contracts/storage";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { buildSiteContext } from "../../src/audit/adapter";
import {
  buildCloudPagePayloads,
  buildMetadataPayload,
  truncateUtf8Bytes,
} from "../../src/audit/cloud";
import { gateStage1 } from "../../src/audit/cloud-gating";

function pageRecord(html: string, url = "https://example.com/"): PageRecord {
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 0,
    status: 200,
    contentType: "text/html",
    sizeBytes: html.length,
    loadTimeMs: 10,
    fetchedAt: Date.now(),
    etag: null,
    lastModified: null,
    contentHash: "hash",
    html,
    parsedData: null,
    headers: {
      contentType: "text/html",
      contentEncoding: null,
      cacheControl: null,
      vary: null,
      etag: null,
      server: null,
      lastModified: null,
      link: null,
      serverTiming: null,
      age: null,
      xCache: null,
      cfCacheStatus: null,
      xVercelCache: null,
      altSvc: null,
      acceptRanges: null,
    },
    securityHeaders: {
      hsts: null,
      csp: null,
      xFrameOptions: null,
      xContentTypeOptions: null,
      referrerPolicy: null,
      permissionsPolicy: null,
      xRobotsTag: null,
    },
  };
}

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

describe("truncateUtf8Bytes", () => {
  test("returns short text unchanged", () => {
    expect(truncateUtf8Bytes("hello", 100)).toBe("hello");
  });

  test("caps ASCII text at the byte budget", () => {
    const out = truncateUtf8Bytes("x".repeat(10_000), 6_000);
    expect(out.length).toBe(6_000);
    expect(utf8Bytes(out)).toBe(6_000);
  });

  test("caps multi-byte text by BYTES, not code units", () => {
    // "你" is 3 bytes in UTF-8 — slice(0, 6000) would yield 18KB.
    const out = truncateUtf8Bytes("你".repeat(6_000), 6_000);
    expect(utf8Bytes(out)).toBeLessThanOrEqual(6_000);
    expect(out.length).toBe(2_000);
  });

  test("never splits a code point mid-sequence", () => {
    // 4-byte emoji; a 6-byte budget cuts the second one mid-sequence.
    const out = truncateUtf8Bytes("😀😀", 6);
    expect(out).toBe("😀");
    expect(out.includes("�")).toBe(false);
  });
});

describe("buildCloudPagePayloads", () => {
  test("bounds every per-page field so batch bodies stay small", async () => {
    const html = `<html><head>
      <title>${"t".repeat(2_000)}</title>
      <meta name="description" content="${"d".repeat(3_000)}">
    </head><body>
      ${Array.from({ length: 30 }, (_, i) => `<h2>${`h${i} `.repeat(200)}</h2>`).join("\n")}
      <p>${"body text ".repeat(50_000)}</p>
    </body></html>`;
    const siteContext = await Effect.runPromise(
      buildSiteContext([pageRecord(html)])
    );

    const payloads = buildCloudPagePayloads(siteContext);
    expect(payloads.length).toBe(1);
    const p = payloads[0];

    expect(utf8Bytes(p.textExcerpt)).toBeLessThanOrEqual(6_000);
    expect(p.title!.length).toBeLessThanOrEqual(300);
    expect(p.meta!.description.length).toBeLessThanOrEqual(500);
    expect(p.headings!.length).toBeLessThanOrEqual(20);
    for (const h of p.headings!) {
      expect(h.length).toBeLessThanOrEqual(200);
    }

    // The whole serialized page stays far under the batch byte budget:
    // 20 such pages must fit comfortably in a 4MB request body.
    expect(utf8Bytes(JSON.stringify(p))).toBeLessThan(15_000);
  });

  test("skips non-2xx and unparsed pages", async () => {
    const errorPage = { ...pageRecord("<html></html>"), status: 500 };
    const siteContext = await Effect.runPromise(buildSiteContext([errorPage]));
    expect(buildCloudPagePayloads(siteContext)).toEqual([]);
  });
});

describe("buildMetadataPayload", () => {
  const META_HTML = `<html lang="en-US"><head>
    <title>Acme Co</title>
    <meta property="og:site_name" content="Acme">
    <meta name="twitter:site" content="@acme">
    <link rel="alternate" hreflang="fr" href="https://example.com/fr">
    <link rel="alternate" hreflang="de" href="https://example.com/de">
    <script type="application/ld+json">{"@type":"Organization","name":"Acme"}</script>
  </head><body>
    <a href="https://twitter.com/acme">X</a>
    <a href="mailto:hi@acme.com">Email</a>
  </body></html>`;

  test("extracts identity signals (title, meta, JSON-LD, links, lang, hreflang), home first", async () => {
    const siteContext = await Effect.runPromise(
      buildSiteContext([pageRecord(META_HTML, "https://example.com/")])
    );
    const payloads = buildMetadataPayload(siteContext, "https://example.com/");
    expect(payloads.length).toBe(1);
    const p = payloads[0];

    expect(p.url).toBe("https://example.com/");
    expect(p.title).toBe("Acme Co");
    expect(p.metaTags?.["og:site_name"]).toBe("Acme");
    expect(p.metaTags?.["twitter:site"]).toBe("@acme");
    expect(p.lang).toBe("en-US");
    expect(p.hreflang).toEqual(["fr", "de"]);
    expect(p.jsonLd?.length).toBe(1);
    expect(p.jsonLd?.[0]).toContain("Organization");
    expect(p.visibleLinks?.map((l) => l.href)).toContain("mailto:hi@acme.com");
  });

  test("home page is sampled first even when crawled later", async () => {
    const other = pageRecord(
      "<html><head><title>About</title></head></html>",
      "https://example.com/about"
    );
    const home = pageRecord(META_HTML, "https://example.com/");
    const siteContext = await Effect.runPromise(
      buildSiteContext([other, home])
    );
    const payloads = buildMetadataPayload(siteContext, "https://example.com/");
    expect(payloads[0].url).toBe("https://example.com/");
  });

  test("falls back to the root-path page when the exact baseUrl doesn't match (redirect)", async () => {
    // baseUrl has no match by exact URL, but a root-path page exists — it should
    // still lead the sample rather than an arbitrary inner page.
    const inner = pageRecord(
      "<html><head><title>Inner</title></head></html>",
      "https://example.com/blog/post"
    );
    const root = pageRecord(META_HTML, "https://example.com/");
    const siteContext = await Effect.runPromise(
      buildSiteContext([inner, root])
    );
    // Pass a baseUrl that matches neither page URL exactly (no trailing slash).
    const payloads = buildMetadataPayload(siteContext, "https://example.com");
    expect(payloads[0].url).toBe("https://example.com/");
  });

  test("caps to metadataMaxPages and returns [] when nothing is usable", async () => {
    const errorPage = { ...pageRecord("<html></html>"), status: 500 };
    const errCtx = await Effect.runPromise(buildSiteContext([errorPage]));
    expect(buildMetadataPayload(errCtx, "https://example.com/")).toEqual([]);

    const pages = Array.from({ length: 12 }, (_, i) =>
      pageRecord(
        "<html><head><title>P</title></head></html>",
        `https://example.com/p${i}`
      )
    );
    const manyCtx = await Effect.runPromise(buildSiteContext(pages));
    const payloads = buildMetadataPayload(manyCtx, "https://example.com/p0");
    // metadataMaxPages = 6.
    expect(payloads.length).toBe(6);
  });
});

describe("gateStage1", () => {
  const meta = (over: Partial<SiteMetadata>): SiteMetadata => ({
    siteType: "saas",
    isYMYL: false,
    isLocalBusiness: false,
    hasOwnershipVerified: false,
    confidence: "high",
    ...over,
  });

  test("skips keyword/content gaps for personal + portfolio sites", () => {
    for (const siteType of ["personal", "portfolio"] as const) {
      expect(gateStage1(meta({ siteType }), "keyword-gaps")).toBe(false);
      expect(gateStage1(meta({ siteType }), "content-gaps")).toBe(false);
    }
    // Gaps run for everything else.
    expect(gateStage1(meta({ siteType: "ecommerce" }), "keyword-gaps")).toBe(
      true
    );
  });

  test("authority-signals run only for YMYL or editorial/medical types", () => {
    expect(
      gateStage1(meta({ isYMYL: true, siteType: "saas" }), "authority-signals")
    ).toBe(true);
    for (const siteType of ["blog", "news", "healthcare_provider"] as const) {
      expect(gateStage1(meta({ siteType }), "authority-signals")).toBe(true);
    }
    // Non-YMYL marketing SaaS / landing pages → skip.
    expect(gateStage1(meta({ siteType: "saas" }), "authority-signals")).toBe(
      false
    );
    expect(
      gateStage1(meta({ siteType: "landing_page" }), "authority-signals")
    ).toBe(false);
  });

  test("unknown/ungated services default to true (backward-compat)", () => {
    expect(gateStage1(meta({ siteType: "personal" }), "ai-parse")).toBe(true);
    expect(gateStage1(meta({ siteType: "personal" }), "tech-detect")).toBe(
      true
    );
    expect(gateStage1(meta({ siteType: "personal" }), "blocklist-check")).toBe(
      true
    );
  });
});
