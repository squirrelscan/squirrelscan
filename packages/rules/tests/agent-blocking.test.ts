// ax/agent-blocking — browser-vs-agent access parity probe.

import { describe, expect, test } from "bun:test";

import type {
  AgentAccessData,
  AgentAccessProbe,
  AgentAccessUserAgent,
  CheckResult,
} from "@squirrelscan/core-contracts";

import { agentBlockingRule } from "../src/ax/agent-blocking";
import type { ParsedPage, RuleContext } from "../src/types";

function probe(userAgent: AgentAccessUserAgent, over: Partial<AgentAccessProbe> = {}): AgentAccessProbe {
  return {
    userAgent,
    userAgentString: `${userAgent}-UA`,
    status: 200,
    bodySize: 10_000,
    challenged: false,
    challengeSignal: null,
    paymentRequired: false,
    paymentSignal: null,
    error: null,
    ...over,
  };
}

function ctx(agentAccess: AgentAccessData | null): RuleContext {
  return {
    page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: { baseUrl: "https://example.com", pages: [], robotsTxt: null, sitemaps: null, agentAccess },
    options: {},
  };
}

function run(agentAccess: AgentAccessData | null): CheckResult[] {
  return agentBlockingRule.run(ctx(agentAccess)).checks;
}

const both = (gpt: Partial<AgentAccessProbe>, claude: Partial<AgentAccessProbe>): AgentAccessData => ({
  probes: [probe("browser"), probe("gptbot", gpt), probe("claude-user", claude)],
});

describe("ax/agent-blocking", () => {
  test("skips cleanly when the prefetch did not run", () => {
    const checks = run(null);
    expect(checks[0]?.status).toBe("skipped");
  });

  test("skips when the browser baseline is not 2xx", () => {
    const checks = run({
      probes: [probe("browser", { status: 503 }), probe("gptbot"), probe("claude-user")],
    });
    expect(checks[0]?.status).toBe("skipped");
    expect(checks[0]?.message).toContain("Browser baseline");
  });

  test("passes when both agents match the browser", () => {
    const checks = run(both({}, {}));
    expect(checks.some((c) => c.status === "pass")).toBe(true);
    expect(checks.every((c) => c.status !== "warn" && c.status !== "fail")).toBe(true);
  });

  test("GPTBot 403 while browser 200 is a warn (training opt-out)", () => {
    const checks = run(both({ status: 403 }, {}));
    const gpt = checks.find((c) => c.details?.userAgent === "gptbot");
    expect(gpt?.status).toBe("warn");
    expect(gpt?.message).toContain("GPTBot");
  });

  test("Claude-User blocked is the worst case → fail", () => {
    const checks = run(both({}, { status: 403 }));
    const claude = checks.find((c) => c.details?.userAgent === "claude-user");
    expect(claude?.status).toBe("fail");
    expect(claude?.message).toContain("worst case");
  });

  test("a Cloudflare challenge to Claude-User counts as blocked", () => {
    const checks = run(both({}, { status: 200, challenged: true, challengeSignal: "cf-mitigated" }));
    const claude = checks.find((c) => c.details?.userAgent === "claude-user");
    expect(claude?.status).toBe("fail");
    expect(claude?.message).toContain("cf-mitigated");
  });

  test("a 402 is treated as pay-per-crawl (info), not a block", () => {
    const checks = run(both({ status: 402, paymentRequired: true, paymentSignal: "http-402" }, {}));
    const pay = checks.find((c) => c.name === "agent-access-payment");
    expect(pay?.status).toBe("info");
    expect(checks.every((c) => c.status !== "warn" && c.status !== "fail")).toBe(true);
  });

  test("a same-status but tiny body warns (soft-block / interstitial)", () => {
    const checks = run(both({ status: 200, bodySize: 500 }, {}));
    const gpt = checks.find((c) => c.details?.userAgent === "gptbot");
    expect(gpt?.status).toBe("warn");
    expect(gpt?.message).toContain("soft-block");
  });

  test("a network-error agent probe is inconclusive info, not a block", () => {
    const checks = run(both({ status: 0, error: "ECONNRESET" }, {}));
    const gpt = checks.find((c) => c.name === "agent-access" && c.details?.userAgent === "gptbot");
    expect(gpt?.status).toBe("info");
  });
});
