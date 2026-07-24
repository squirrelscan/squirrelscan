// ax/pay-per-crawl - detect HTTP 402 monetized agent access (Cloudflare Pay Per Crawl, x402)

import type { AgentAccessProbe } from "@squirrelscan/core-contracts";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

function mechanismFor(signal: string | null): string {
  switch (signal) {
    case "crawler-price":
    case "crawler-charged":
      return "Cloudflare Pay Per Crawl";
    case "x402-body":
      return "x402";
    default:
      return "an unnamed HTTP 402 payment wall";
  }
}

export const payPerCrawlRule: Rule = {
  meta: {
    id: "ax/pay-per-crawl",
    name: "Pay Per Crawl",
    description:
      "Detects an HTTP 402 Payment Required response carrying a crawler-price header (Cloudflare Pay Per Crawl) or an x402 JSON payment body, served to AI crawler user-agents",
    solution:
      "Monetizing crawler access is a legitimate business decision, reported informationally by default. Scope the 402 to the crawler classes you intend to charge (typically training/bulk crawlers) and keep it off user-action fetchers (ChatGPT-User, Claude-User, Perplexity-User) so a real person's live request through an AI assistant isn't the thing that gets billed.",
    category: "ax",
    scope: "site",
    // warning so 402-on-a-user-action-fetcher carries a warning badge; plain
    // monetization detection emits only info checks and never becomes an issue.
    severity: "warning",
    weight: 1,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const aa = ctx.site?.agentAccess;

    if (!aa) {
      checks.push({ name: "pay-per-crawl", status: "info", message: "agent access probe data not available" });
      return { checks };
    }

    const browser = aa.probes.find((p) => p.userAgent === "browser");
    const claudeUser = aa.probes.find((p) => p.userAgent === "claude-user");
    const charged = aa.probes.filter((p) => p.paymentRequired);

    if (charged.length === 0) {
      // Absent = the normal case; stay quiet, no noise.
      checks.push({
        name: "pay-per-crawl",
        status: "info",
        message: "No monetized agent access (pay-per-crawl / x402) detected",
        value: "absent",
      });
      return { checks };
    }

    const mechanisms = [...new Set(charged.map((p) => mechanismFor(p.paymentSignal)))];
    checks.push({
      name: "pay-per-crawl",
      status: "info",
      message: `Monetized agent access configured via ${mechanisms.join(" and ")} for ${charged
        .map((p) => p.userAgent)
        .join(", ")}`,
      value: "configured",
      details: {
        mechanisms,
        chargedUserAgents: charged.map((p: AgentAccessProbe) => p.userAgent),
      },
    });

    // A real person's in-the-moment AI-assistant request being the thing that
    // gets billed, while a normal browser sails through, is the harmful case.
    const browserOk = browser != null && browser.status >= 200 && browser.status < 300;
    if (claudeUser?.paymentRequired && browserOk) {
      checks.push({
        name: "pay-per-crawl-user-action",
        status: "warn",
        message:
          "Claude-User (a live user-action fetch) is charged HTTP 402 while browsers get a normal 2xx response — this bills a real person's in-the-moment question, not a background crawl",
        value: "user-action-charged",
        details: { claudeUserStatus: claudeUser.status, browserStatus: browser?.status ?? null },
      });
    }

    return { checks };
  },
};
