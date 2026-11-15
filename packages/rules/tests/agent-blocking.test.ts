// ax/agent-blocking — browser-vs-agent access parity probe.

import { describe, expect, test } from "bun:test";

import type {
  AgentAccessData,
  AgentAccessProbe,
  AgentAccessUserAgent,
  CheckResult,
} from "@squirrelscan/core-contracts";

import { PROBE_NOT_ATTEMPTED_ERROR } from "@squirrelscan/core-contracts/storage";

import { agentBlockingRule } from "../src/ax/agent-blocking";
import type { ParsedPage, RuleContext } from "../src/types";

function probe(
  userAgent: AgentAccessUserAgent,
  over: Partial<AgentAccessProbe> = {},
): AgentAccessProbe {
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
    site: {
      baseUrl: "https://example.com",
      pages: [],
      robotsTxt: null,
      sitemaps: null,
      agentAccess,
    },
    options: {},
  };
}

async function run(agentAccess: AgentAccessData | null): Promise<CheckResult[]> {
  return (await agentBlockingRule.run(ctx(agentAccess))).checks;
}

const both = (
  gpt: Partial<AgentAccessProbe>,
  claude: Partial<AgentAccessProbe>,
): AgentAccessData => ({
  probes: [probe("browser"), probe("gptbot", gpt), probe("claude-user", claude)],
});

describe("ax/agent-blocking", () => {
  test("skips cleanly when the prefetch did not run", async () => {
    const checks = await run(null);
    expect(checks[0]?.status).toBe("skipped");
    expect(checks[0]?.value).toBe("not-checked");
    expect(checks[0]?.message).toContain("not checked");
  });

  // #409: a probe the budget skipped is not a network failure to report.
  test("a browser baseline that was never sent → skipped as not checked", async () => {
    const checks = await run({
      probes: [
        probe("browser", { status: 0, error: PROBE_NOT_ATTEMPTED_ERROR }),
        probe("gptbot"),
        probe("claude-user"),
      ],
    });
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("skipped");
    expect(checks[0]?.message).toContain("not checked");
  });

  test("an agent probe that was never sent → not checked info, no pass", async () => {
    const checks = await run(both({}, { status: 0, error: PROBE_NOT_ATTEMPTED_ERROR }));
    const claude = checks.find(
      (c) => c.name === "agent-access" && c.details?.userAgent === "claude-user",
    );
    expect(claude?.status).toBe("skipped");
    expect(claude?.value).toBe("not-checked");
    expect(checks.some((c) => c.status === "pass")).toBe(false);
  });

  test("skips when the browser baseline is not 2xx", async () => {
    const checks = await run({
      probes: [probe("browser", { status: 503 }), probe("gptbot"), probe("claude-user")],
    });
    expect(checks[0]?.status).toBe("skipped");
    expect(checks[0]?.message).toContain("Browser baseline");
  });

  test("passes when both agents match the browser", async () => {
    const checks = await run(both({}, {}));
    expect(checks.some((c) => c.status === "pass")).toBe(true);
    expect(checks.every((c) => c.status !== "warn" && c.status !== "fail")).toBe(true);
  });

  test("GPTBot 403 while browser 200 is a warn (training opt-out)", async () => {
    const checks = await run(both({ status: 403 }, {}));
    const gpt = checks.find((c) => c.details?.userAgent === "gptbot");
    expect(gpt?.status).toBe("warn");
    expect(gpt?.message).toContain("GPTBot");
  });

  test("Claude-User blocked is the worst case → fail", async () => {
    const checks = await run(both({}, { status: 403 }));
    const claude = checks.find((c) => c.details?.userAgent === "claude-user");
    expect(claude?.status).toBe("fail");
    expect(claude?.message).toContain("worst case");
  });

  test("a Cloudflare challenge to Claude-User counts as blocked", async () => {
    const checks = await run(
      both({}, { status: 200, challenged: true, challengeSignal: "cf-mitigated" }),
    );
    const claude = checks.find((c) => c.details?.userAgent === "claude-user");
    expect(claude?.status).toBe("fail");
    expect(claude?.message).toContain("cf-mitigated");
  });

  test("a 402 is treated as pay-per-crawl (info), not a block", async () => {
    const checks = await run(
      both({ status: 402, paymentRequired: true, paymentSignal: "http-402" }, {}),
    );
    const pay = checks.find((c) => c.name === "agent-access-payment");
    expect(pay?.status).toBe("info");
    expect(checks.every((c) => c.status !== "warn" && c.status !== "fail")).toBe(true);
  });

  test("a same-status but tiny body warns (soft-block / interstitial)", async () => {
    const checks = await run(both({ status: 200, bodySize: 500 }, {}));
    const gpt = checks.find((c) => c.details?.userAgent === "gptbot");
    expect(gpt?.status).toBe("warn");
    expect(gpt?.message).toContain("soft-block");
  });

  test("a network-error agent probe is inconclusive info, not a block", async () => {
    const checks = await run(both({ status: 0, error: "ECONNRESET" }, {}));
    const gpt = checks.find((c) => c.name === "agent-access" && c.details?.userAgent === "gptbot");
    expect(gpt?.status).toBe("info");
  });
});

describe("ax/agent-blocking UA probes and all-token mode (#3788)", () => {
  test("verdicts say UA probe, not a confirmed bot", async () => {
    const blocked = await run(both({ status: 403 }, { status: 403 }));
    const gpt = blocked.find((c) => c.details?.userAgent === "gptbot");
    const claude = blocked.find((c) => c.details?.userAgent === "claude-user");
    expect(gpt?.message).toContain("GPTBot UA probe is blocked (HTTP 403)");
    expect(claude?.message).toContain("Claude-User UA probe is blocked");
    const passed = (await run(both({}, {}))).find((c) => c.status === "pass");
    expect(passed?.message).toBe(
      "GPTBot and Claude-User UA probes reached the homepage like a browser",
    );
  });

  test("per-bot checks carry status and X-Robots-Tag", async () => {
    const checks = await run(both({ status: 403, xRobotsTag: "noai" }, {}));
    const gpt = checks.find((c) => c.details?.userAgent === "gptbot");
    expect(gpt?.details).toMatchObject({ status: 403, xRobotsTag: "noai" });
    const clean = await run(both({ xRobotsTag: "noindex" }, {}));
    const pass = clean.find((c) => c.status === "pass");
    expect(pass?.details?.probes).toEqual([
      { userAgent: "gptbot", status: 200, xRobotsTag: "noindex" },
      { userAgent: "claude-user", status: 200, xRobotsTag: null },
    ]);
  });

  test("a user-action bot other than Claude-User blocked fails; a training bot warns", async () => {
    const checks = await run({
      probes: [
        probe("browser"),
        probe("perplexity-user", { status: 403 }),
        probe("ccbot", { status: 403 }),
      ],
    });
    expect(checks.find((c) => c.details?.userAgent === "perplexity-user")?.status).toBe("fail");
    expect(checks.find((c) => c.details?.userAgent === "ccbot")?.status).toBe("warn");
  });

  test("all-token mode (a bot beyond the default pair) emits one agent-access-probes info check listing every probe", async () => {
    const checks = await run({
      probes: [
        probe("browser", { xRobotsTag: "all" }),
        probe("gptbot", { xRobotsTag: "noai" }),
        probe("ccbot", { status: 403 }),
        probe("claude-user"),
      ],
    });
    const summary = checks.filter((c) => c.name === "agent-access-probes");
    expect(summary).toHaveLength(1);
    expect(summary[0]?.status).toBe("info");
    expect(summary[0]?.message).toBe(
      "Probed 3 AI user agents (UA probe, not the real bots): 2 matched the browser",
    );
    expect(summary[0]?.details?.browserXRobotsTag).toBe("all");
    expect(summary[0]?.details?.probes).toEqual([
      {
        userAgent: "gptbot",
        token: "GPTBot",
        userAgentString: "gptbot-UA",
        status: 200,
        xRobotsTag: "noai",
        verdict: "ok",
      },
      {
        userAgent: "ccbot",
        token: "CCBot",
        userAgentString: "ccbot-UA",
        status: 403,
        xRobotsTag: null,
        verdict: "blocked",
      },
      {
        userAgent: "claude-user",
        token: "Claude-User",
        userAgentString: "claude-user-UA",
        status: 200,
        xRobotsTag: null,
        verdict: "ok",
      },
    ]);
  });

  test("the default GPTBot and Claude-User pair emits no agent-access-probes check", async () => {
    const checks = await run(both({}, {}));
    expect(checks.some((c) => c.name === "agent-access-probes")).toBe(false);
  });
});
