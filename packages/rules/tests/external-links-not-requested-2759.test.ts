// squirrelscan/repo#2759: external links the checker never requested, because
// they look like an action or carry a token, are reported as not requested,
// with their status unknown: never as working, never as broken, and never as
// over the audit's limit.

import { describe, expect, test } from "bun:test";

import { EXTERNAL_LINKS_OVER_CAP_SKIP_REASON } from "@squirrelscan/core-contracts";

import { brokenExternalLinksRule } from "../src/links/broken-external-links";
import type { ExternalLinkCheckData, ParsedPage, RuleContext, SiteData } from "../src/types";

const BASE = "https://example.com";
const UNSUBSCRIBE = "https://mail.example/unsubscribe?token=0123456789abcdef0123456789abcdef";
const SIGNED = "https://cdn.example/report.pdf?sig=Zm9vYmFyYmF6cXV4MTIzNDU2";

function ctx(
  externalLinks: ExternalLinkCheckData[],
  externalLinkCheck: SiteData["externalLinkCheck"],
): RuleContext {
  return {
    page: { url: `${BASE}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: {
      baseUrl: BASE,
      robotsTxt: null,
      sitemaps: null,
      pages: [],
      externalLinks,
      externalLinkCheck,
    },
    options: {},
  } as unknown as RuleContext;
}

const ok = (href: string): ExternalLinkCheckData =>
  ({ href, status: 200, error: null, sourcePages: [`${BASE}/`] }) as ExternalLinkCheckData;

const sample = [
  { href: UNSUBSCRIBE, sourcePages: [`${BASE}/`, `${BASE}/about`] },
  { href: SIGNED, sourcePages: [`${BASE}/reports`] },
];

describe("links/broken-external-links: links never requested (repo#2759)", () => {
  test("listed as not requested beside the pass for the ones checked, and not over the limit", () => {
    const { checks } = brokenExternalLinksRule.run(
      ctx([ok("https://partner.example/")], {
        found: 3,
        checked: 1,
        cap: 200,
        notRequested: 2,
        notRequestedLinks: sample,
      }),
    );
    expect(checks.map((c) => `${c.name}:${c.status}`)).toEqual([
      "broken-external-links:pass",
      "not-requested-external-links:info",
    ]);
    expect(checks[0]!.message).toBe("All 1 external link(s) are working");
    expect(checks[1]).toMatchObject({
      message:
        "2 external link(s) were not requested because they look like actions (log out, unsubscribe) or carry a token or signature in the URL, so their status was not checked",
      value: 2,
      details: { notRequested: 2 },
      items: [
        { id: UNSUBSCRIBE, sourcePages: [`${BASE}/`, `${BASE}/about`] },
        { id: SIGNED, sourcePages: [`${BASE}/reports`] },
      ],
    });
  });

  test("the over-limit count leaves them out", () => {
    const { checks } = brokenExternalLinksRule.run(
      ctx([ok("https://a.example/"), ok("https://b.example/")], {
        found: 10,
        checked: 5,
        cap: 5,
        notRequested: 2,
        notRequestedLinks: sample,
      }),
    );
    const overCap = checks.find((c) => c.skipReason === EXTERNAL_LINKS_OVER_CAP_SKIP_REASON);
    expect(overCap?.message).toBe(
      "3 of 10 external link(s) were not checked: over this audit's limit of 5, which checks the most-linked first",
    );
  });

  test("every external link not requested: only the not-requested line, no pass and no not-checked", () => {
    const { checks } = brokenExternalLinksRule.run(
      ctx([], { found: 2, checked: 0, cap: 200, notRequested: 2, notRequestedLinks: sample }),
    );
    expect(checks.map((c) => `${c.name}:${c.status}`)).toEqual([
      "not-requested-external-links:info",
    ]);
  });

  test("a sample shorter than the count says how many it lists", () => {
    const { checks } = brokenExternalLinksRule.run(
      ctx([ok("https://partner.example/")], {
        found: 81,
        checked: 1,
        cap: 200,
        notRequested: 80,
        notRequestedLinks: sample,
      }),
    );
    expect(checks.find((c) => c.name === "not-requested-external-links")?.details).toEqual({
      notRequested: 80,
      listed: 2,
    });
  });

  test("nothing left out: no not-requested line", () => {
    const { checks } = brokenExternalLinksRule.run(
      ctx([ok("https://partner.example/")], { found: 1, checked: 1, cap: 200 }),
    );
    expect(checks.map((c) => c.name)).toEqual(["broken-external-links"]);
  });
});
