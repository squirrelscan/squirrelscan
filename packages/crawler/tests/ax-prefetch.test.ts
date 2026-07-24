// AX prefetch parsers/validators — pure-function unit tests (no network).

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type {
  AgentAccessRecord,
  MarkdownProbeRecord,
  RslRecord,
  WellKnownProbeRecord,
} from "@squirrelscan/core-contracts";

import { SQLiteStorage } from "../src/storage/sqlite";
import { detectChallenge, detectPayment } from "../src/agent-access";
import {
  extractLinkHeaderLicenseUrls,
  extractRobotsLicenseUrls,
  looksLikeRsl,
  looksLikeXml,
} from "../src/rsl";
import { parseAlternateMarkdownLink } from "../src/markdown";
import {
  extractOAuthFields,
  looksLikeHtml,
  looksLikeMarkdown,
  sniffJson,
  WELL_KNOWN_PATHS,
} from "../src/well-known";

describe("parseAlternateMarkdownLink (ax/markdown-response Link-header discovery)", () => {
  test("matches rel=alternate + type=text/markdown and resolves to absolute", () => {
    const header = '</index.md>; rel="alternate"; type="text/markdown"';
    expect(parseAlternateMarkdownLink(header, "https://example.com/")).toBe(
      "https://example.com/index.md",
    );
  });

  test("ignores non-matching rel/type entries and multi-entry headers", () => {
    const header =
      '<https://example.com/next>; rel="next", </index.md>; rel="alternate"; type="text/markdown"';
    expect(parseAlternateMarkdownLink(header, "https://example.com/")).toBe(
      "https://example.com/index.md",
    );
    expect(
      parseAlternateMarkdownLink('<https://example.com/next>; rel="next"', "https://example.com/"),
    ).toBeNull();
  });

  test("null header or no match → null", () => {
    expect(parseAlternateMarkdownLink(null, "https://example.com/")).toBeNull();
    expect(parseAlternateMarkdownLink("", "https://example.com/")).toBeNull();
  });
});

describe("well-known sniffing (SPA-fallback traps)", () => {
  test("WELL_KNOWN_PATHS includes llms.txt alt paths for ax/llms-txt fallback detection", () => {
    expect(WELL_KNOWN_PATHS).toContain("/.well-known/llms.txt");
    expect(WELL_KNOWN_PATHS).toContain("/docs/llms.txt");
  });

  test("looksLikeHtml catches doctype + html root, ignoring leading whitespace", () => {
    expect(looksLikeHtml("<!DOCTYPE html><html><head>")).toBe(true);
    expect(looksLikeHtml("\n  <html lang=\"en\">")).toBe(true);
    expect(looksLikeHtml('{"name":"x"}')).toBe(false);
    expect(looksLikeHtml("# Agents\n")).toBe(false);
  });

  test("sniffJson returns top-level object keys and rejects invalid JSON", () => {
    expect(sniffJson('{"schema":"mcp","tools":[]}')).toEqual({
      valid: true,
      keys: ["schema", "tools"],
    });
    // Arrays/scalars are valid JSON but carry no top-level keys.
    expect(sniffJson("[1,2,3]")).toEqual({ valid: true, keys: [] });
    expect(sniffJson("<!DOCTYPE html>")).toEqual({ valid: false, keys: [] });
  });

  test("looksLikeMarkdown detects ATX headings and md links", () => {
    expect(looksLikeMarkdown("# AGENTS\nStuff")).toBe(true);
    expect(looksLikeMarkdown("See [docs](https://x.dev/docs) for more")).toBe(true);
    expect(looksLikeMarkdown("plain text no structure")).toBe(false);
  });

  test("extractOAuthFields reads registration_endpoint + CIMD flag", () => {
    const body = JSON.stringify({
      issuer: "https://x.dev",
      registration_endpoint: "https://x.dev/register",
      client_id_metadata_document_supported: true,
    });
    expect(extractOAuthFields(body)).toEqual({
      registrationEndpoint: "https://x.dev/register",
      clientIdMetadataDocumentSupported: true,
    });
    // Absent fields / wrong types → null, never a throw.
    expect(extractOAuthFields('{"issuer":"https://x.dev"}')).toEqual({
      registrationEndpoint: null,
      clientIdMetadataDocumentSupported: null,
    });
    expect(extractOAuthFields("<!DOCTYPE html>")).toEqual({
      registrationEndpoint: null,
      clientIdMetadataDocumentSupported: null,
    });
  });
});

describe("agent-access challenge + payment detection", () => {
  test("detectChallenge flags cf-mitigated header and body markers", () => {
    expect(detectChallenge(new Headers({ "cf-mitigated": "challenge" }), "")).toBe("cf-mitigated");
    expect(detectChallenge(new Headers(), "<html>Just a moment...</html>")).toBe("just-a-moment");
    expect(detectChallenge(new Headers(), "window.__cf_chl_opt = {}")).toBe("__cf_chl_");
    expect(detectChallenge(new Headers(), "<html><body>welcome</body></html>")).toBeNull();
  });

  test("detectPayment flags 402 + x402 body and crawler-price header", () => {
    expect(detectPayment(402, new Headers(), '{"x402Version":1,"accepts":[]}')).toBe("x402-body");
    expect(detectPayment(200, new Headers({ "crawler-price": "USD 0.01" }), "")).toBe(
      "crawler-price",
    );
    expect(detectPayment(402, new Headers(), "Payment Required")).toBe("http-402");
    expect(detectPayment(200, new Headers(), "<html>ok</html>")).toBeNull();
  });
});

describe("rsl licensing extraction", () => {
  test("extractRobotsLicenseUrls reads License directives, skipping comments", () => {
    const robots = [
      "User-agent: *",
      "Disallow:",
      "License: https://example.com/license.xml",
      "# License: https://example.com/ignored.xml",
      "license:   https://example.com/second.xml   # inline note",
    ].join("\n");
    expect(extractRobotsLicenseUrls(robots)).toEqual([
      "https://example.com/license.xml",
      "https://example.com/second.xml",
    ]);
  });

  test("extractLinkHeaderLicenseUrls pulls rel=license URLs only", () => {
    const header = '<https://x.dev/lic.xml>; rel="license", <https://x.dev/next>; rel="next"';
    expect(extractLinkHeaderLicenseUrls(header)).toEqual(["https://x.dev/lic.xml"]);
    expect(extractLinkHeaderLicenseUrls(null)).toEqual([]);
  });

  test("looksLikeRsl + looksLikeXml recognise RSL docs and reject HTML", () => {
    const rsl = '<?xml version="1.0"?><rsl xmlns="https://rslstandard.org/rsl"></rsl>';
    expect(looksLikeXml(rsl)).toBe(true);
    expect(looksLikeRsl(rsl)).toBe(true);
    expect(looksLikeXml("<!DOCTYPE html><html></html>")).toBe(false);
    expect(looksLikeRsl("<rss></rss>")).toBe(false);
  });
});

describe("AX store round-trip", () => {
  function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
    return Effect.runPromise(eff as Effect.Effect<A, never, never>);
  }

  async function freshStore(): Promise<{ store: SQLiteStorage; crawlId: string }> {
    const store = new SQLiteStorage(":memory:");
    await run(store.init());
    const crawlId = await run(
      store.createCrawl({
        baseUrl: "https://example.com",
        startedAt: 1,
        status: "running",
        config: {
          maxPages: 10,
          concurrency: 1,
          perHostConcurrency: 1,
          delayMs: 0,
          perHostDelayMs: 0,
          timeoutMs: 1000,
          userAgent: "test",
          followRedirects: true,
          respectRobots: false,
          incremental: false,
          include: [],
          exclude: [],
          allowQueryParams: [],
          dropQueryPrefixes: [],
          allowedDomains: [],
        },
        stats: {
          pagesTotal: 0,
          pagesFetched: 0,
          pagesFailed: 0,
          pagesSkipped: 0,
          pagesUnchanged: 0,
          linksTotal: 0,
          imagesTotal: 0,
          bytesTotal: 0,
          avgLoadTimeMs: 0,
        },
      }),
    );
    return { store, crawlId };
  }

  test("well-known / agent-access / rsl records persist and read back", async () => {
    const { store, crawlId } = await freshStore();

    const wellKnown: WellKnownProbeRecord = {
      probes: [
        {
          path: "/.well-known/mcp.json",
          url: "https://example.com/.well-known/mcp.json",
          status: 200,
          contentType: "application/json",
          bodySize: 12,
          looksHtml: false,
          jsonValid: true,
          jsonKeys: ["schema"],
          markdownLike: false,
          excerpt: '{"schema":1}',
          oauthRegistrationEndpoint: null,
          oauthClientIdMetadataDocumentSupported: null,
          error: null,
        },
      ],
      fetchedAt: 111,
    };
    const access: AgentAccessRecord = {
      probes: [
        {
          userAgent: "gptbot",
          userAgentString: "GPTBot/1.1",
          status: 403,
          bodySize: 42,
          challenged: true,
          challengeSignal: "cf-mitigated",
          paymentRequired: false,
          paymentSignal: null,
          error: null,
        },
      ],
      fetchedAt: 222,
    };
    const rsl: RslRecord = {
      licenseUrls: ["https://example.com/license.xml"],
      robotsHasLicense: true,
      linkHeaderPresent: false,
      documents: [
        {
          url: "https://example.com/license.xml",
          status: 200,
          contentType: "application/rsl+xml",
          xmlValid: true,
          looksRsl: true,
          excerpt: "<rsl/>",
          error: null,
        },
      ],
      fetchedAt: 333,
    };

    await run(store.setWellKnownProbe(crawlId, wellKnown));
    await run(store.setAgentAccess(crawlId, access));
    await run(store.setRsl(crawlId, rsl));

    expect(await run(store.getWellKnownProbe(crawlId))).toEqual(wellKnown);
    expect(await run(store.getAgentAccess(crawlId))).toEqual(access);
    expect(await run(store.getRsl(crawlId))).toEqual(rsl);
  });

  test("markdown-response header fingerprints (schema v15) persist and read back", async () => {
    const { store, crawlId } = await freshStore();

    const markdown: MarkdownProbeRecord = {
      negotiatedUrl: "https://example.com/",
      negotiatedContentType: "text/markdown",
      servesMarkdown: true,
      mdVariantUrl: "https://example.com/index.md",
      mdVariantExists: true,
      mdVariantContentType: "text/markdown",
      negotiatedVary: "Accept",
      markdownTokensHeader: "100",
      originalTokensHeader: "400",
      alternateMarkdownUrl: "https://example.com/index.md",
      fetchedAt: 444,
    };

    await run(store.setMarkdownProbe(crawlId, markdown));

    expect(await run(store.getMarkdownProbe(crawlId))).toEqual(markdown);
  });

  test("markdown-response round-trips null header fingerprints (pre-v15-shaped probe)", async () => {
    const { store, crawlId } = await freshStore();

    const markdown: MarkdownProbeRecord = {
      negotiatedUrl: "https://example.com/",
      negotiatedContentType: "text/html",
      servesMarkdown: false,
      mdVariantUrl: "https://example.com/index.md",
      mdVariantExists: false,
      mdVariantContentType: null,
      negotiatedVary: null,
      markdownTokensHeader: null,
      originalTokensHeader: null,
      alternateMarkdownUrl: null,
      fetchedAt: 555,
    };

    await run(store.setMarkdownProbe(crawlId, markdown));

    expect(await run(store.getMarkdownProbe(crawlId))).toEqual(markdown);
  });
});
