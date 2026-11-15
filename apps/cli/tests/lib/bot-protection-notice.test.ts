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
    expect(botProtectionNotice({ wafBlocked: { total: 1 } })).toContain(
      "bot protection refused 1 URL "
    );
  });

  test("root fetch refusals count, and sources are not double counted", () => {
    expect(refusedUrlCount({ refusedFetches: [{}, {}] })).toBe(2);
    expect(refusedUrlCount({ pagesBlocked: 5, wafBlocked: { total: 4 } })).toBe(
      5
    );
  });
});
