// ax/agent-blocking - behavioral probe: does the homepage answer AI user-agents
// the way it answers a browser? robots.txt says what a site *claims* to allow;
// this compares the actual browser / GPTBot / Claude-User homepage fetches.

import type { AgentAccessData, AgentAccessProbe } from "@squirrelscan/core-contracts";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

/** Fraction of the browser body below which a same-status AI response reads as a
 * soft-block / interstitial rather than the real page. */
const SOFT_BLOCK_BODY_RATIO = 0.2;

function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

/** How an AI-UA probe compares against the (2xx) browser baseline. */
type Verdict =
  | { kind: "ok" }
  | { kind: "payment"; signal: string | null }
  | { kind: "blocked"; reason: string }
  | { kind: "soft-block"; ratioPct: number }
  | { kind: "inconclusive"; reason: string };

function classifyProbe(probe: AgentAccessProbe, browserBodySize: number): Verdict {
  // Pay-per-crawl is a deliberate wall, not access-blocking — leave it to ax/pay-per-crawl.
  if (probe.paymentRequired || probe.status === 402) {
    return { kind: "payment", signal: probe.paymentSignal };
  }
  if (probe.challenged) {
    return { kind: "blocked", reason: `bot challenge (${probe.challengeSignal ?? "challenge"})` };
  }
  if (probe.status === 401 || probe.status === 403) {
    return { kind: "blocked", reason: `HTTP ${probe.status}` };
  }
  if (probe.status >= 500) {
    return { kind: "blocked", reason: `HTTP ${probe.status}` };
  }
  if (probe.status === 0) {
    return { kind: "inconclusive", reason: probe.error ?? "network error" };
  }
  if (is2xx(probe.status) && browserBodySize > 0 && probe.bodySize < browserBodySize * SOFT_BLOCK_BODY_RATIO) {
    return {
      kind: "soft-block",
      ratioPct: Math.round((probe.bodySize / browserBodySize) * 100),
    };
  }
  return { kind: "ok" };
}

const UA_LABEL: Record<AgentAccessProbe["userAgent"], string> = {
  browser: "browser",
  gptbot: "GPTBot",
  "claude-user": "Claude-User",
};

export const agentBlockingRule: Rule = {
  meta: {
    id: "ax/agent-blocking",
    name: "Agent Blocking",
    description:
      "Probes whether the homepage serves AI user-agents (GPTBot, Claude-User) the same as a browser, catching WAF / bot-challenge blocks robots.txt can't reveal",
    solution:
      "A site can allow an AI user-agent in robots.txt and still block it at the edge via a WAF / bot-management 'block AI bots' toggle. Check that toggle is scoped to the crawler classes you actually mean to block. Blocking a training crawler like GPTBot is often intentional; blocking Claude-User — a live fetch a real person triggered inside an assistant — breaks a request someone is waiting on, so allow-list ChatGPT-User, Claude-User, and Perplexity-User in your edge rules if you want assistant users to reach your site. Re-run this probe after any WAF / CDN / bot-management change.",
    category: "ax",
    scope: "site",
    // "error" so a blocked user-action fetcher (fail check) badges as an
    // error; blocking only training crawlers emits warn checks, which the
    // report's effective severity automatically downgrades to a warning.
    severity: "error",
    weight: 3,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const agentAccess: AgentAccessData | null | undefined = ctx.site?.agentAccess;

    // Prefetch didn't run → behave as if the rule wasn't there.
    if (!agentAccess || agentAccess.probes.length === 0) {
      checks.push({
        name: "agent-blocking",
        status: "skipped",
        message: "Agent-access probe data not available",
        skipReason: "No agentAccess prefetch for this crawl",
      });
      return { checks };
    }

    const browser = agentAccess.probes.find((p) => p.userAgent === "browser");
    const aiProbes = agentAccess.probes.filter((p) => p.userAgent !== "browser");

    // Without a healthy browser baseline the comparison is meaningless (the site
    // may be down for everyone) — skip rather than blame the agents.
    if (!browser || !is2xx(browser.status)) {
      checks.push({
        name: "agent-blocking",
        status: "skipped",
        message: `Browser baseline did not return 2xx (status ${browser?.status ?? "n/a"}) — cannot compare agent access`,
        skipReason: "No 2xx browser baseline",
      });
      return { checks };
    }

    let cleanCount = 0;
    for (const probe of aiProbes) {
      const label = UA_LABEL[probe.userAgent];
      const isUserAction = probe.userAgent === "claude-user";
      const verdict = classifyProbe(probe, browser.bodySize);

      switch (verdict.kind) {
        case "ok":
          cleanCount++;
          break;
        case "payment":
          checks.push({
            name: "agent-access-payment",
            status: "info",
            message: `${label} hit a pay-per-crawl wall${verdict.signal ? ` (${verdict.signal})` : ""} — reported by ax/pay-per-crawl, not a block`,
            value: label,
            details: { userAgent: probe.userAgent, paymentSignal: verdict.signal },
          });
          break;
        case "inconclusive":
          checks.push({
            name: "agent-access",
            status: "info",
            message: `${label} probe was inconclusive (${verdict.reason})`,
            value: label,
            details: { userAgent: probe.userAgent, status: probe.status, error: probe.error },
          });
          break;
        case "soft-block":
          checks.push({
            name: "agent-access",
            status: "warn",
            message: `${label} got the same status as the browser but only ${verdict.ratioPct}% of the body — likely a soft-block / interstitial served to the agent`,
            value: label,
            details: {
              userAgent: probe.userAgent,
              browserBodySize: browser.bodySize,
              agentBodySize: probe.bodySize,
            },
          });
          break;
        case "blocked":
          checks.push({
            name: "agent-access",
            // Claude-User is a live user-action fetcher — blocking it breaks a
            // request a real person made inside an assistant (worst case, fail).
            // GPTBot is a training crawler — often blocked on purpose (warn).
            status: isUserAction ? "fail" : "warn",
            message: isUserAction
              ? `Claude-User is blocked (${verdict.reason}) while the browser gets 200 — this breaks a live fetch a real user triggered inside an assistant, the worst case for agent access`
              : `${label} is blocked (${verdict.reason}) while the browser gets 200 — often an intentional training opt-out, but confirm it was deliberate`,
            value: `${label} blocked`,
            details: {
              userAgent: probe.userAgent,
              userAgentString: probe.userAgentString,
              browserStatus: browser.status,
              agentStatus: probe.status,
              challenged: probe.challenged,
              challengeSignal: probe.challengeSignal,
            },
          });
          break;
      }
    }

    // All AI UAs matched the browser → a clean pass keeps the rule's denominator honest.
    if (cleanCount === aiProbes.length) {
      checks.push({
        name: "agent-blocking",
        status: "pass",
        message: `${aiProbes.map((p) => UA_LABEL[p.userAgent]).join(" and ")} reached the homepage like a browser`,
        value: "no blocking",
      });
    }

    return { checks };
  },
};
