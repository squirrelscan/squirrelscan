// squirrelscan/repo#2759: external links the checker never requested, because
// they look like an action or carry a token, are reported as not requested,
// with their status unknown: never as working, never as broken, and never as
// over the audit's limit.

import { describe, expect, test } from "bun:test";

import { EXTERNAL_LINKS_OVER_CAP_SKIP_REASON } from "@squirrelscan/core-contracts";
import { maskLinkTokens } from "@squirrelscan/utils/link-actions";

import { brokenExternalLinksRule } from "../src/links/broken-external-links";
import { deadLinksRule } from "../src/links/dead-links";
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
      "3 of 8 external link(s) were not checked: over this audit's limit of 5, which checks the most-linked first",
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

  test("a sample entry linked from more pages than it lists carries the page count", () => {
    const { checks } = brokenExternalLinksRule.run(
      ctx([ok("https://partner.example/")], {
        found: 2,
        checked: 1,
        cap: 200,
        notRequested: 1,
        notRequestedLinks: [
          {
            href: "https://mail.example/unsubscribe?token=…",
            sourcePages: [`${BASE}/`],
            pageCount: 40,
          },
        ],
      }),
    );
    expect(checks.find((c) => c.name === "not-requested-external-links")?.items).toEqual([
      { id: "https://mail.example/unsubscribe?token=…", sourcePages: [`${BASE}/`], pageCount: 40 },
    ]);
  });

  test("no check results for the rest: the not-requested ones are listed, not counted as not checked", () => {
    const pages = [
      {
        url: `${BASE}/`,
        statusCode: 200,
        parsed: {
          links: [UNSUBSCRIBE, SIGNED, "https://partner.example/"].map((url) => ({
            url,
            isInternal: false,
            text: "",
            rel: null,
          })),
        } as unknown as ParsedPage,
      },
    ];
    const context = ctx([], {
      found: 3,
      checked: 1,
      cap: 200,
      notRequested: 2,
      notRequestedLinks: sample,
    });
    (context.site as { pages: unknown }).pages = pages;
    const { checks } = brokenExternalLinksRule.run(context);
    expect(checks.map((c) => `${c.name}:${c.status}`)).toEqual([
      "not-requested-external-links:info",
      "broken-external-links:skipped",
    ]);
    expect(checks[1]!.message).toBe(
      "No external link check results for the 1 external link(s) on the audited pages, so they were not checked",
    );
  });

  test("links/dead-links says why nothing was verified when every link was left out", () => {
    const { checks } = deadLinksRule.run(
      ctx([], { found: 2, checked: 0, cap: 200, notRequested: 2, notRequestedLinks: sample }),
    );
    expect(checks.map((c) => c.message)).toEqual([
      "No external links were verified: all 2 look like actions or carry a token, so they were not requested",
    ]);
  });

  test("links refused for their address are listed too, never counted as working (pub#770)", () => {
    const refusedLinks = [
      { href: "http://192.168.1.1/admin", sourcePages: [`${BASE}/`], pageCount: 1 },
    ];
    const { checks } = brokenExternalLinksRule.run(
      ctx([ok("https://partner.example/")], {
        found: 2,
        checked: 1,
        cap: 1,
        refused: 1,
        refusedByUrl: 1,
        refusedLinks,
      }),
    );
    // Not over the limit of 1 either: the refused link never took a slot.
    expect(checks.map((c) => `${c.name}:${c.status}`)).toEqual([
      "broken-external-links:pass",
      "refused-external-links:info",
    ]);
    expect(checks[0]!.message).toBe("All 1 external link(s) are working");
    expect(checks[1]).toMatchObject({
      message:
        "1 external link(s) point at a private, link-local or cloud metadata address, or a name public DNS does not resolve, so they were not requested and their status was not checked",
      items: [{ id: "http://192.168.1.1/admin", sourcePages: [`${BASE}/`] }],
      details: { refused: 1 },
    });
  });

  test("every link refused or left out: only those lines, no not-checked skip (pub#770)", () => {
    const { checks } = brokenExternalLinksRule.run(
      ctx([], {
        found: 3,
        checked: 0,
        cap: 200,
        notRequested: 2,
        notRequestedLinks: sample,
        refused: 1,
        refusedByUrl: 1,
        refusedLinks: [
          { href: "http://192.168.1.1/admin", sourcePages: [`${BASE}/`], pageCount: 1 },
        ],
      }),
    );
    expect(checks.map((c) => `${c.name}:${c.status}`)).toEqual([
      "not-requested-external-links:info",
      "refused-external-links:info",
    ]);
  });

  test("nothing left out: no not-requested line", () => {
    const { checks } = brokenExternalLinksRule.run(
      ctx([ok("https://partner.example/")], { found: 1, checked: 1, cap: 200 }),
    );
    expect(checks.map((c) => c.name)).toEqual(["broken-external-links"]);
  });
});

// #2307: the not-requested and refused links say where on the audited pages they sit.
describe("links/broken-external-links: where never-requested links sit (#2307)", () => {
  test("not-requested items name the sections of the links that carry them", () => {
    const c = ctx([ok("https://partner.example/")], {
      found: 2,
      checked: 1,
      cap: 200,
      notRequested: 1,
      notRequestedLinks: [sample[0]!],
    } as SiteData["externalLinkCheck"]);
    c.site!.pages = [
      {
        url: `${BASE}/`,
        parsed: {
          links: [{ url: UNSUBSCRIBE, text: "unsubscribe", isInternal: false, section: "footer" }],
        },
      },
    ] as never;
    const { checks } = brokenExternalLinksRule.run(c);
    const item = checks.find((x) => x.name === "not-requested-external-links")!.items![0]!;

    expect(item.id).toBe(UNSUBSCRIBE);
    expect(item.label).toBe(`${UNSUBSCRIBE}, linked in the footer`);
    expect(item.meta).toEqual({ sections: { footer: 1 } });
  });

  test("without section data the item is as it was", () => {
    const { checks } = brokenExternalLinksRule.run(
      ctx([ok("https://partner.example/")], {
        found: 2,
        checked: 1,
        cap: 200,
        notRequested: 1,
        notRequestedLinks: [sample[0]!],
      } as SiteData["externalLinkCheck"]),
    );
    const item = checks.find((x) => x.name === "not-requested-external-links")!.items![0]!;

    expect(item).toEqual({ id: UNSUBSCRIBE, sourcePages: [`${BASE}/`, `${BASE}/about`] });
  });
});

describe("links/broken-external-links: masked hrefs still find their section (#2307)", () => {
  test("the sample is reported masked and matched to the link by its own masked form", () => {
    const masked = maskLinkTokens(UNSUBSCRIBE);
    expect(masked).not.toBe(UNSUBSCRIBE);
    const c = ctx([ok("https://partner.example/")], {
      found: 2,
      checked: 1,
      cap: 200,
      notRequested: 1,
      notRequestedLinks: [{ href: masked, sourcePages: [`${BASE}/`] }],
    } as SiteData["externalLinkCheck"]);
    c.site!.pages = [
      {
        url: `${BASE}/`,
        parsed: {
          links: [{ url: UNSUBSCRIBE, text: "unsubscribe", isInternal: false, section: "footer" }],
        },
      },
    ] as never;
    const item = brokenExternalLinksRule
      .run(c)
      .checks.find((x) => x.name === "not-requested-external-links")!.items![0]!;

    expect(item.id).toBe(masked);
    expect(item.label).toBe(`${masked}, linked in the footer`);
    // The credential is in neither the label nor the meta.
    expect(JSON.stringify(item)).not.toContain("0123456789abcdef0123456789abcdef"); // pragma: allowlist secret
  });
});
