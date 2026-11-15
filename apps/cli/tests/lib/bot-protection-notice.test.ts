import { describe, expect, test } from "bun:test";

import {
  botProtectionNotice,
  refusedUrlCount,
} from "@/lib/bot-protection-notice";

describe("botProtectionNotice (repo#2237)", () => {
  test("a crawl behind a detected vendor that served every page prints no caveat", () => {
    expect(
      botProtectionNotice({ pagesBlocked: 0 }, "cloudflare")
    ).toBeUndefined();
    expect(botProtectionNotice({}, "cloudflare")).toBeUndefined();
    expect(botProtectionNotice(undefined, "akamai")).toBeUndefined();
    expect(
      botProtectionNotice({
        pagesBlocked: 0,
        wafBlocked: { total: 0 },
        refusedFetches: [],
      })
    ).toBeUndefined();
  });

  test("a refused crawl names the vendor and how many URLs were refused", () => {
    const msg = botProtectionNotice({ pagesBlocked: 3 }, "cloudflare");
    expect(msg).toContain("cloudflare protection refused 3 URLs");
  });

  test("a single refusal is singular and an unknown vendor reads generically", () => {
    expect(
      botProtectionNotice({ pagesBlocked: 1, wafBlocked: { total: 1 } })
    ).toContain("bot protection refused 1 URL ");
  });

  test("root fetch refusals count, and waf pages are not double counted", () => {
    expect(
      refusedUrlCount({ refusedFetches: [{ status: 403 }, { status: 401 }] })
    ).toBe(2);
    expect(refusedUrlCount({ pagesBlocked: 5, wafBlocked: { total: 4 } })).toBe(
      5
    );
  });

  test("page refusals and root-fetch refusals are separate sets and add up", () => {
    expect(
      refusedUrlCount({
        pagesBlocked: 3,
        wafBlocked: { total: 2 },
        refusedFetches: [{ status: 403 }, { status: 503 }],
      })
    ).toBe(5);
  });

  test("a throttled root fetch (429, 430) is rate limiting, not bot protection", () => {
    expect(
      botProtectionNotice(
        { refusedFetches: [{ status: 429 }, { status: 430 }] },
        "shopify"
      )
    ).toBeUndefined();
    expect(
      refusedUrlCount({
        pagesBlocked: 1,
        refusedFetches: [{ status: 429 }, { status: 403 }],
      })
    ).toBe(2);
  });
});
