// pub#811 — Cloudflare email-protection links are not broken internal links.
//
// With Cloudflare's email obfuscation on, every `mailto:` link on a site becomes
// `/cdn-cgi/l/email-protection#<hex>`. Requested, the path answers an error
// status, so `links/broken-links` listed one broken link per obfuscated address
// and every page with one in its footer as a source. The parser now carries
// them as contact links; a parse stored before that still has them in `links`,
// so the rule skips them by URL too, and says how many it left out.

import { describe, expect, test } from "bun:test";

import type { ContactLinkData } from "@squirrelscan/core-contracts";

import { brokenLinksRule } from "../src/links/broken-links";
import type { ParsedPage, RuleContext, SiteData } from "../src/types";

const BASE = "https://example.com";
const PROTECTED = `${BASE}/cdn-cgi/l/email-protection#6a0b0e`;

interface FixturePage {
  url: string;
  statusCode: number;
  internal?: string[];
  contactLinks?: ContactLinkData[];
}

function ctx(
  pages: FixturePage[],
  site: Partial<Pick<SiteData, "linkTargetStatuses" | "internalLinkProbe">> = {},
): RuleContext {
  return {
    page: { url: `${BASE}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: {
      baseUrl: BASE,
      robotsTxt: null,
      sitemaps: null,
      pages: pages.map((p) => ({
        url: p.url,
        statusCode: p.statusCode,
        parsed: {
          links: (p.internal ?? []).map((url) => ({ url, isInternal: true, text: "", rel: null })),
          ...(p.contactLinks ? { contactLinks: p.contactLinks } : {}),
        } as unknown as ParsedPage,
      })),
      ...site,
    },
    options: {},
  } as unknown as RuleContext;
}

const obfuscated = (value = "hi@example.com"): ContactLinkData => ({
  scheme: "mailto",
  value,
  text: "[email protected]",
  obfuscated: "cloudflare",
});

function row(pages: FixturePage[], site?: Parameters<typeof ctx>[1]) {
  const { checks } = brokenLinksRule.run(ctx(pages, site));
  return checks.find((c) => c.name === "broken-links")!;
}

describe("links/broken-links — Cloudflare email-protection links (pub#811)", () => {
  test("a stored parse's email-protection link the crawl got a 404 for is not broken, and is counted", () => {
    const r = row([
      { url: `${BASE}/`, statusCode: 200, internal: [PROTECTED, `${BASE}/about`] },
      { url: `${BASE}/about`, statusCode: 200, internal: [`${BASE}/cdn-cgi/l/email-protection#1f2e`] },
      { url: `${BASE}/cdn-cgi/l/email-protection`, statusCode: 404 },
    ]);
    expect(r.status).toBe("pass");
    expect(r.details).toMatchObject({ emailProtectionLinks: 2, linkTargets: 1 });
  });

  test("nor one the internal link check got a 404 for", () => {
    const r = row([{ url: `${BASE}/`, statusCode: 200, internal: [PROTECTED] }], {
      linkTargetStatuses: [{ url: PROTECTED, status: 404 }],
      internalLinkProbe: { unfetched: 1, cap: 200 },
    } as Parameters<typeof ctx>[1]);
    expect(r.status).toBe("pass");
    expect(r.details).toMatchObject({ emailProtectionLinks: 1, linkTargets: 0 });
  });

  test("the parser's obfuscated contact links are counted, on a pass and beside a real broken link", () => {
    const pass = row([
      { url: `${BASE}/`, statusCode: 200, contactLinks: [obfuscated(), obfuscated("b@example.com")] },
      { url: `${BASE}/contact`, statusCode: 200, contactLinks: [obfuscated("")] },
    ]);
    expect(pass.status).toBe("pass");
    expect(pass.details).toMatchObject({ emailProtectionLinks: 3 });

    const fail = row([
      { url: `${BASE}/`, statusCode: 200, internal: [`${BASE}/gone`], contactLinks: [obfuscated()] },
      { url: `${BASE}/gone`, statusCode: 404 },
    ]);
    expect(fail.status).toBe("fail");
    expect(fail.items?.map((i) => i.id)).toEqual([`${BASE}/gone`]);
    expect(fail.details).toMatchObject({ emailProtectionLinks: 1 });
  });

  test("a plain mailto contact link is not counted, and no count is added when there are none", () => {
    const r = row([
      {
        url: `${BASE}/`,
        statusCode: 200,
        internal: [`${BASE}/about`],
        contactLinks: [{ scheme: "mailto", value: "hi@example.com", text: "Email" }],
      },
      { url: `${BASE}/about`, statusCode: 200 },
    ]);
    expect(r.status).toBe("pass");
    expect(r.details).not.toHaveProperty("emailProtectionLinks");
  });

  test("other /cdn-cgi/ links are still checked: a broken image-resizing link is broken", () => {
    const resized = `${BASE}/cdn-cgi/image/width=1200/a.jpg`;
    const r = row([
      { url: `${BASE}/`, statusCode: 200, internal: [resized] },
      { url: resized, statusCode: 404 },
    ]);
    expect(r.status).toBe("fail");
    expect(r.items?.map((i) => i.id)).toEqual([resized]);
  });
});
