// links/generic-anchor-density: generic anchors as a site-wide ratio (repo#1387).

import type { LinkData } from "@squirrelscan/core-contracts";

import { describe, expect, test } from "bun:test";

import type { CheckResult, ParsedPage, RuleContext } from "../src/types";

import { GENERIC_LINK_TEXT } from "../src/a11y/link-text";
import { genericAnchorDensityRule } from "../src/links/generic-anchor-density";
import {
  CORE_GENERIC_ANCHORS,
  countGenericAnchors,
} from "../src/shared/generic-anchor-phrases";

const BASE = "https://example.com/";

function a(text: string, extra: Partial<LinkData> = {}): LinkData {
  return { url: "/x", text, isInternal: true, isChrome: false, ...extra };
}

function ctx(
  pages: Record<string, LinkData[]>,
  options: Record<string, unknown> = {}
): RuleContext {
  return {
    page: { url: BASE, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: {
      baseUrl: BASE,
      pages: Object.entries(pages).map(([url, links]) => ({
        url,
        finalUrl: url,
        statusCode: 200,
        parsed: { links } as ParsedPage,
      })),
      robotsTxt: null,
      sitemaps: null,
    },
    options: { minAnchors: 30, warnRatio: 0.2, failRatio: 0.4, ...options },
  } as unknown as RuleContext;
}

async function run(c: RuleContext): Promise<CheckResult> {
  return (await genericAnchorDensityRule.run(c)).checks[0]!;
}

/** `generic` generic anchors and `descriptive` descriptive ones on one page. */
function mix(generic: number, descriptive: number): LinkData[] {
  return [
    ...Array.from({ length: generic }, () => a("Read more")),
    ...Array.from({ length: descriptive }, (_, i) => a(`Guide to topic ${i}`)),
  ];
}

describe("links/generic-anchor-density", () => {
  test("fail: a mostly generic site reports the ratio and the worst pages", async () => {
    const c = await run(
      ctx({
        [`${BASE}a`]: mix(30, 5),
        [`${BASE}b`]: mix(10, 15),
        [`${BASE}c`]: mix(0, 10),
      })
    );
    expect(c.status).toBe("fail");
    expect(c.message).toContain("of internal anchors are generic (40 of 70)");
    expect(c.items?.map((i) => i.id)).toEqual([`${BASE}a`, `${BASE}b`]);
  });

  test("warn: between the warn and fail ratios", async () => {
    const c = await run(ctx({ [`${BASE}a`]: mix(15, 45) }));
    expect(c.status).toBe("warn");
    expect(c.details).toMatchObject({ genericAnchors: 15, totalAnchors: 60 });
  });

  test("pass (no false positive): occasional generic anchors below the threshold", async () => {
    const c = await run(
      ctx({ [`${BASE}a`]: mix(3, 40), [`${BASE}b`]: mix(2, 40) })
    );
    expect(c.status).toBe("pass");
    expect(c.items).toBeUndefined();
  });

  test("skipped: too few anchors to judge", async () => {
    const c = await run(ctx({ [`${BASE}a`]: mix(5, 0) }));
    expect(c.status).toBe("skipped");
  });

  test("does not count chrome, nofollow, empty, external or conventional labels", () => {
    const counts = countGenericAnchors([
      a("click here", { isChrome: true }),
      a("click here", { isNofollow: true }),
      a("   "),
      a("click here", { isInternal: false }),
      a("Sign in"),
      a("click here", { url: "#top" }),
      a("Read more"),
      a("Pricing"),
      a("Read more", { isChrome: undefined }),
    ]);
    expect(counts).toEqual({ generic: 2, total: 4 });
  });

  test("worst pages are capped at ten and ordered by generic count then url", async () => {
    const pages: Record<string, LinkData[]> = {};
    for (let i = 0; i < 12; i++)
      pages[`${BASE}p${String(i).padStart(2, "0")}`] = mix(i + 1, 0);
    const c = await run(ctx(pages));
    expect(c.items).toHaveLength(10);
    expect(c.items![0]!.id).toBe(`${BASE}p11`);
  });

  test("the phrase list agrees with links/anchor-text and a11y/link-text", () => {
    for (const phrase of CORE_GENERIC_ANCHORS)
      expect(GENERIC_LINK_TEXT).toContain(phrase);
  });
});
