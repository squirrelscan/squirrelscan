// pub#821: say why a link is unverifiable. The link checker knows whether bot
// protection refused it, it could not be reached, or it is a first 404 waiting
// for its confirming check. The last is a likely-broken link: since #1739 it has its own
// warning check (see broken-external-links-1739.test.ts); the others keep their labels here.

import { describe, expect, test } from "bun:test";

import { brokenExternalLinksRule } from "../src/links/broken-external-links";
import type { ExternalLinkCheckData, ParsedPage, RuleContext } from "../src/types";

const BASE = "https://example.com";

function unverifiedRow(links: ExternalLinkCheckData[]) {
  const ctx = {
    page: { url: `${BASE}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: { baseUrl: BASE, pages: [], robotsTxt: null, sitemaps: null, externalLinks: links },
    options: {},
  } as unknown as RuleContext;
  return brokenExternalLinksRule.run(ctx).checks.find((c) => c.name === "waf-blocked-external-links")!;
}

const link = (href: string, over: Partial<ExternalLinkCheckData>): ExternalLinkCheckData => ({
  href,
  status: null,
  error: null,
  sourcePages: [`${BASE}/`],
  wafBlocked: true,
  ...over,
});

describe("why an external link is unverifiable (pub#821)", () => {
  test("a link awaiting its confirming check says so; blocked and unreachable keep their labels", () => {
    const row = unverifiedRow([
      link("https://walled.example/", { unverifiedReason: "blocked", wafProvider: "cloudflare" }),
      link("https://other-wall.example/", { unverifiedReason: "blocked", wafProvider: "unknown" }),
      link("https://stalls.example/", { unverifiedReason: "unreachable", wafProvider: "unknown" }),
      link("https://older-answer.example/", { wafProvider: "unknown" }),
    ]);
    expect(row.items?.map((i) => i.label)).toEqual([
      "https://walled.example/ (unverified: cloudflare)",
      "https://other-wall.example/ (unverified)",
      "https://stalls.example/ (unverified)",
      "https://older-answer.example/ (unverified)",
    ]);
  });

  test("the reason is item data when known, and absent when not", () => {
    const row = unverifiedRow([
      link("https://stalls.example/", { unverifiedReason: "unreachable" }),
      link("https://older-answer.example/", { wafProvider: "unknown" }),
    ]);
    expect(row.items?.map((i) => i.meta)).toEqual([
      { wafProvider: undefined, unverifiedReason: "unreachable" },
      { wafProvider: "unknown" },
    ]);
  });
});
