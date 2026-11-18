// crawl/home-page-unreachable: the entry URL failed to load, per failure class.

import { describe, expect, test } from "bun:test";

import type { AuditFailureDetail } from "@squirrelscan/core-contracts";

import { homePageUnreachableRule } from "../src/crawl/home-page-unreachable";
import type { RuleContext } from "../src/types";

const ctxFor = (entryFailure?: AuditFailureDetail): RuleContext =>
  ({
    site: {
      baseUrl: "https://example.com",
      entryUrls: ["https://example.com/"],
      pages: [],
      robotsTxt: null,
      sitemaps: null,
      entryFailure,
    },
  }) as unknown as RuleContext;

const run = async (failure?: AuditFailureDetail) =>
  (await homePageUnreachableRule.run(ctxFor(failure))).checks;

describe("crawl/home-page-unreachable", () => {
  test.each([
    [{ code: "dns", host: "example.com" }, "DNS"],
    [{ code: "tls", host: "example.com", detail: "certificate expired" }, "TLS"],
    [{ code: "connection", host: "example.com" }, "connection"],
    [{ code: "timeout", host: "example.com" }, "in time"],
    [{ code: "http_5xx", host: "example.com", status: 503 }, "503"],
  ] as Array<[AuditFailureDetail, string]>)("reports %o", async (failure, text) => {
    const checks = await run(failure);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.name).toBe("home-page-unreachable");
    expect(checks[0]!.status).toBe("fail");
    expect(checks[0]!.message).toContain("example.com");
    expect(checks[0]!.message).toContain(text);
    expect(checks[0]!.pageUrl).toBe("https://example.com/");
    expect(checks[0]!.details?.reason).toBe(failure.code);
  });

  test("a healthy home page (no failure recorded) reports one clean pass", async () => {
    const checks = await run(undefined);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.name).toBe("home-page-unreachable");
    expect(checks[0]!.status).toBe("pass");
  });

  test.each(["http_4xx", "robots", "redirect", "unknown"] as const)(
    "%s is an answer, not an outage: no finding",
    async (code) => {
      expect(await run({ code, host: "example.com" })).toEqual([]);
    },
  );

  test("a sitemap-sourced failure is not the home page", async () => {
    expect(await run({ code: "dns", host: "example.com", source: "sitemap" })).toEqual([]);
  });
});
