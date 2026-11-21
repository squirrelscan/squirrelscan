// pub#783: the unverifiable row of links/broken-external-links covered every
// link nobody could verify (a wall, a timeout, a CDN origin error, a first 404
// waiting for its confirming check) under "blocked by WAF". Most are not a
// firewall, so the row says unverifiable and names a vendor only when one was
// identified.

import { describe, expect, test } from "bun:test";

import type {
  ExternalLinkCheckData,
  ParsedPage,
  RuleContext,
} from "../src/types";

import { brokenExternalLinksRule } from "../src/links/broken-external-links";

const BASE = "https://example.com";

function externalCtx(externalLinks: ExternalLinkCheckData[]): RuleContext {
  return {
    page: {
      url: `${BASE}/`,
      html: "",
      statusCode: 200,
      loadTime: 0,
      headers: {},
    },
    parsed: {} as ParsedPage,
    site: {
      baseUrl: BASE,
      pages: [],
      robotsTxt: null,
      sitemaps: null,
      externalLinks,
    },
    options: {},
  } as unknown as RuleContext;
}

const unverified = (
  href: string,
  wafProvider?: string
): ExternalLinkCheckData => ({
  href,
  status: null,
  error: null,
  sourcePages: [`${BASE}/`],
  wafBlocked: true,
  ...(wafProvider === undefined ? {} : { wafProvider }),
});

async function unverifiedRow(links: ExternalLinkCheckData[]) {
  const { checks } = await brokenExternalLinksRule.run(externalCtx(links));
  return checks.find((c) => c.name === "waf-blocked-external-links")!;
}

describe("the unverifiable external links row (pub#783)", () => {
  test("says the links could not be verified, never that a firewall blocked them", async () => {
    const row = await unverifiedRow([
      unverified("https://walled.example/", "cloudflare"),
      unverified("https://stalls.example/", "unknown"),
    ]);
    expect(row.status).toBe("info");
    expect(row.message).toBe(
      "2 external link(s) could not be verified - status unverifiable"
    );
    expect(row.message).not.toContain("WAF");
  });

  test("names the vendor in the item label only when one was identified", async () => {
    const row = await unverifiedRow([
      unverified("https://walled.example/", "cloudflare"),
      unverified("https://stalls.example/", "unknown"),
      unverified("https://pending.example/"),
    ]);
    expect(row.items?.map((i) => i.label)).toEqual([
      "https://walled.example/ (unverified: cloudflare)",
      "https://stalls.example/ (unverified)",
      "https://pending.example/ (unverified)",
    ]);
    // The meta a consumer reads is unchanged.
    expect(row.items?.map((i) => i.meta)).toEqual([
      { wafProvider: "cloudflare" },
      { wafProvider: "unknown" },
      { wafProvider: undefined },
    ]);
  });
});
