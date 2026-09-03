// #1829 — the report has to say whether its numbers cover the whole site.
//
// Before this, a 429 was folded into `blockedPages` alongside 401/403, so a
// throttled Shopify storefront reported "Site blocked the crawler (bot
// protection / auth / rate limit)". That sends the reader to their WAF settings
// for a problem only a slower crawl fixes. Rate limiting now gets its own
// reason, and a crawl that gathered content but lost pages reports `partial`
// rather than a clean `completed`.

import { describe, expect, test } from "bun:test";

import { deriveAuditStatus, deriveAuditStatusFromPages } from "../src/scoring";

describe("deriveAuditStatus — rate-limit reasons (#1829)", () => {
  test("nothing crawled because of throttling → blocked, with a rate-limit reason", () => {
    const out = deriveAuditStatus({
      pagesCrawled: 0,
      contentPages: 0,
      blockedPages: 0,
      blockedErrors: 0,
      rateLimitedErrors: 4,
      rateLimitedHosts: ["shop.example.com"],
    });

    expect(out.status).toBe("blocked");
    expect(out.reason).toContain("Rate limited");
    expect(out.reason).toContain("shop.example.com");
    // Must NOT be the bot-protection copy, which points at the wrong fix.
    expect(out.reason).not.toContain("bot protection");
  });

  test("a real bot wall still reports the bot-protection reason", () => {
    const out = deriveAuditStatus({
      pagesCrawled: 0,
      contentPages: 0,
      blockedPages: 0,
      blockedErrors: 3,
    });

    expect(out.status).toBe("blocked");
    expect(out.reason).toContain("bot protection");
  });

  test("content gathered but pages lost to throttling → partial, naming the count", () => {
    const out = deriveAuditStatus({
      pagesCrawled: 40,
      contentPages: 38,
      blockedPages: 0,
      rateLimitedErrors: 12,
      rateLimitedHosts: ["shop.example.com"],
    });

    expect(out.status).toBe("partial");
    expect(out.reason).toContain("12");
    expect(out.reason).toContain("shop.example.com");
  });

  test("a clean crawl is still completed with no reason", () => {
    const out = deriveAuditStatus({ pagesCrawled: 40, contentPages: 40, blockedPages: 0 });
    expect(out.status).toBe("completed");
    expect(out.reason).toBeUndefined();
  });

  test("an unreachable site is still failed, not rate limited", () => {
    const out = deriveAuditStatus({ pagesCrawled: 0, contentPages: 0, blockedPages: 0 });
    expect(out.status).toBe("failed");
    expect(out.reason).toContain("No pages were crawled");
  });

  test("with no host recorded the reason still reads sensibly", () => {
    const out = deriveAuditStatus({
      pagesCrawled: 10,
      contentPages: 10,
      blockedPages: 0,
      rateLimitedErrors: 2,
    });
    expect(out.status).toBe("partial");
    expect(out.reason).toContain("the host");
  });

  test("many hosts are summarized rather than listed in full", () => {
    const out = deriveAuditStatus({
      pagesCrawled: 10,
      contentPages: 10,
      blockedPages: 0,
      rateLimitedErrors: 2,
      rateLimitedHosts: ["a.example", "b.example", "c.example", "d.example"],
    });
    expect(out.reason).toContain("a.example");
    expect(out.reason).toContain("2 other host(s)");
    expect(out.reason).not.toContain("d.example");
  });
});

describe("deriveAuditStatusFromPages — stored 429/430 pages (#1829)", () => {
  test("a stored 429 page counts as rate limited, not as a bot wall", () => {
    const out = deriveAuditStatusFromPages([{ status: 200 }, { status: 429 }], 0, {
      hosts: ["shop.example.com"],
    });

    expect(out.status).toBe("partial");
    expect(out.reason).toContain("rate limited");
    expect(out.reason).not.toContain("bot protection");
  });

  test("a stored 430 page counts the same way", () => {
    const out = deriveAuditStatusFromPages([{ status: 200 }, { status: 430 }], 0);
    expect(out.status).toBe("partial");
  });

  test("a stored 403 page still reads as blocked when nothing was fetched", () => {
    const out = deriveAuditStatusFromPages([{ status: 403 }], 0);
    expect(out.status).toBe("blocked");
    expect(out.reason).toContain("bot protection");
  });

  test("an all-2xx crawl is completed", () => {
    const out = deriveAuditStatusFromPages([{ status: 200 }, { status: 200 }], 0);
    expect(out.status).toBe("completed");
  });
});
