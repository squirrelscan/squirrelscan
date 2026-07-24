// ax/pay-per-crawl — Cloudflare Pay Per Crawl / x402 monetized agent access.

import { describe, expect, test } from "bun:test";

import type { AgentAccessData, AgentAccessProbe, CheckResult } from "@squirrelscan/core-contracts";

import { payPerCrawlRule } from "../src/ax/pay-per-crawl";
import type { ParsedPage, RuleContext } from "../src/types";

function probe(over: Partial<AgentAccessProbe> = {}): AgentAccessProbe {
  return {
    userAgent: "browser",
    userAgentString: "Mozilla/5.0",
    status: 200,
    bodySize: 1000,
    challenged: false,
    challengeSignal: null,
    paymentRequired: false,
    paymentSignal: null,
    error: null,
    ...over,
  };
}

function ctx(data: AgentAccessData | null | undefined): RuleContext {
  return {
    page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: { baseUrl: "https://example.com", pages: [], robotsTxt: null, sitemaps: null, agentAccess: data },
    options: {},
  };
}

function run(data: AgentAccessData | null | undefined): CheckResult[] {
  return payPerCrawlRule.run(ctx(data)).checks;
}

describe("ax/pay-per-crawl", () => {
  test("data unavailable → info, no crash", () => {
    const checks = run(undefined);
    expect(checks[0]?.status).toBe("info");
    expect(checks[0]?.message).toContain("not available");
  });

  test("no payment wall anywhere → quiet absent", () => {
    const checks = run({ probes: [probe({ userAgent: "browser" }), probe({ userAgent: "gptbot" })] });
    expect(checks).toHaveLength(1);
    expect(checks[0]?.value).toBe("absent");
    expect(checks[0]?.status).toBe("info");
  });

  test("Cloudflare Pay Per Crawl on gptbot only → info, names mechanism", () => {
    const checks = run({
      probes: [
        probe({ userAgent: "browser" }),
        probe({ userAgent: "gptbot", status: 402, paymentRequired: true, paymentSignal: "crawler-price" }),
        probe({ userAgent: "claude-user" }),
      ],
    });
    const main = checks.find((c) => c.name === "pay-per-crawl");
    expect(main?.value).toBe("configured");
    expect(main?.message).toContain("Cloudflare Pay Per Crawl");
    expect(checks.some((c) => c.name === "pay-per-crawl-user-action")).toBe(false);
  });

  test("x402 signal named correctly", () => {
    const checks = run({
      probes: [
        probe({ userAgent: "browser" }),
        probe({ userAgent: "gptbot", status: 402, paymentRequired: true, paymentSignal: "x402-body" }),
        probe({ userAgent: "claude-user" }),
      ],
    });
    expect(checks.find((c) => c.name === "pay-per-crawl")?.message).toContain("x402");
  });

  test("Claude-User charged while browser gets 2xx → warn (bills a live user question)", () => {
    const checks = run({
      probes: [
        probe({ userAgent: "browser", status: 200 }),
        probe({ userAgent: "gptbot" }),
        probe({
          userAgent: "claude-user",
          status: 402,
          paymentRequired: true,
          paymentSignal: "crawler-price",
        }),
      ],
    });
    const warn = checks.find((c) => c.name === "pay-per-crawl-user-action");
    expect(warn?.status).toBe("warn");
    expect(warn?.message).toContain("live");
  });

  test("Claude-User charged but browser ALSO charged (not user-targeted) → no warn escalation", () => {
    const checks = run({
      probes: [
        probe({ userAgent: "browser", status: 402, paymentRequired: true, paymentSignal: "crawler-price" }),
        probe({ userAgent: "gptbot" }),
        probe({
          userAgent: "claude-user",
          status: 402,
          paymentRequired: true,
          paymentSignal: "crawler-price",
        }),
      ],
    });
    expect(checks.some((c) => c.name === "pay-per-crawl-user-action")).toBe(false);
  });
});
