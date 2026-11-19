// ax/agent-blocking - behavioral probe: does the homepage answer AI user-agents
// the way it answers a browser? robots.txt says what a site *claims* to allow;
// this compares the actual browser / GPTBot / Claude-User homepage fetches (or,
// opt-in, every probeable AI token, #3788). Every AI probe is a UA probe: a
// spoofed User-Agent, not the real bot (no vendor source IP, no signature).

import type { AgentAccessData, AgentAccessProbe } from "@squirrelscan/core-contracts";
import { AGENT_ACCESS_BOTS, DEFAULT_AGENT_ACCESS_BOT_IDS } from "@squirrelscan/core-contracts/storage";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { NOT_CHECKED, wasSent } from "./discovery-probe-state";

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
  | { kind: "inconclusive"; reason: string }
  | { kind: "not-checked" };

function classifyProbe(probe: AgentAccessProbe, browserBodySize: number): Verdict {
  if (!wasSent(probe)) return { kind: "not-checked" };
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

const BOT_BY_ID = new Map<string, (typeof AGENT_ACCESS_BOTS)[number]>(
  AGENT_ACCESS_BOTS.map((b) => [b.id, b]),
);

function labelFor(userAgent: AgentAccessProbe["userAgent"]): string {
  return BOT_BY_ID.get(userAgent)?.token ?? userAgent;
}

/** "A", "A and B", "A, B and C". */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export const agentBlockingRule: Rule = {
  meta: {
    id: "ax/agent-blocking",
    name: "Agent Blocking",
    description:
      "Probes whether the homepage serves AI user-agents (GPTBot and Claude-User by default, every AI token with [crawler] agent_access_all_tokens) the same as a browser, catching WAF / bot-challenge blocks robots.txt can't reveal. Results are UA probes: a spoofed user agent, not the real bot",
    solution:
      "A site can allow an AI user-agent in robots.txt and still block it at the edge via a WAF / bot-management 'block AI bots' toggle. Check that toggle is scoped to the crawler classes you actually mean to block. Blocking a training crawler like GPTBot is often intentional; blocking Claude-User (a live fetch a real person triggered inside an assistant) breaks a request someone is waiting on, so allow-list ChatGPT-User, Claude-User, and Perplexity-User in your edge rules if you want assistant users to reach your site. These are UA probes: the request carries the bot's User-Agent but not its source IP or signature, so a WAF that verifies real bots may answer the real one differently. Set `[crawler] agent_access_all_tokens = true` to probe every AI token and record each one's status and X-Robots-Tag. Re-run this probe after any WAF / CDN / bot-management change.",
    category: "ax",
    scope: "site",
    findingScope: "page",
    // "error" so a blocked user-action fetcher (fail check) badges as an
    // error; blocking only training crawlers emits warn checks, which the
    // report's effective severity automatically downgrades to a warning.
    severity: "error",
    weight: 3,
    discoveryProbes: ["agent-access"],
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const agentAccess: AgentAccessData | null | undefined = ctx.site?.agentAccess;

    // Prefetch didn't run → behave as if the rule wasn't there.
    if (!agentAccess || agentAccess.probes.length === 0) {
      checks.push({
        name: "agent-blocking",
        status: "skipped",
        message: "Agent access not checked: the discovery probe was not sent",
        value: NOT_CHECKED,
        skipReason: "discovery-probe-not-sent",
      });
      return { checks };
    }

    const browser = agentAccess.probes.find((p) => p.userAgent === "browser");
    const aiProbes = agentAccess.probes.filter((p) => p.userAgent !== "browser");

    if (browser && !wasSent(browser)) {
      checks.push({
        name: "agent-blocking",
        status: "skipped",
        message: "Agent access not checked: the discovery probe was not sent",
        value: NOT_CHECKED,
        skipReason: "discovery-probe-not-sent",
      });
      return { checks };
    }

    // Without a healthy browser baseline the comparison is meaningless (the site
    // may be down for everyone) — skip rather than blame the agents.
    if (!browser || !is2xx(browser.status)) {
      checks.push({
        name: "agent-blocking",
        status: "skipped",
        message: `Browser baseline did not return 2xx (status ${browser?.status ?? "n/a"}): cannot compare agent access`,
        skipReason: "No 2xx browser baseline",
      });
      return { checks };
    }

    let cleanCount = 0;
    for (const probe of aiProbes) {
      const label = labelFor(probe.userAgent);
      const probeName = `${label} UA probe`;
      const isUserAction = BOT_BY_ID.get(probe.userAgent)?.userAction === true;
      const verdict = classifyProbe(probe, browser.bodySize);
      const evidence = { status: probe.status, xRobotsTag: probe.xRobotsTag ?? null };

      switch (verdict.kind) {
        case "ok":
          cleanCount++;
          break;
        case "not-checked":
          checks.push({
            name: "agent-access",
            status: "skipped",
            skipReason: "discovery-probe-not-sent",
            message: `${probeName} not checked: the discovery probe was not sent`,
            value: NOT_CHECKED,
            details: { userAgent: probe.userAgent, ...evidence },
          });
          break;
        case "payment":
          checks.push({
            name: "agent-access-payment",
            status: "info",
            message: `${probeName} hit a pay-per-crawl wall${verdict.signal ? ` (${verdict.signal})` : ""}: reported by ax/pay-per-crawl, not a block`,
            value: label,
            details: { userAgent: probe.userAgent, paymentSignal: verdict.signal, ...evidence },
          });
          break;
        case "inconclusive":
          checks.push({
            name: "agent-access",
            status: "info",
            message: `${probeName} was inconclusive (${verdict.reason})`,
            value: label,
            details: { userAgent: probe.userAgent, ...evidence, error: probe.error },
          });
          break;
        case "soft-block":
          checks.push({
            name: "agent-access",
            status: "warn",
            message: `${probeName} got the same status as the browser but only ${verdict.ratioPct}% of the body: likely a soft-block / interstitial served to the agent`,
            value: label,
            details: {
              userAgent: probe.userAgent,
              ...evidence,
              browserBodySize: browser.bodySize,
              agentBodySize: probe.bodySize,
            },
          });
          break;
        case "blocked":
          checks.push({
            name: "agent-access",
            // A user-action fetcher (Claude-User, ChatGPT-User, ...) is a live fetch:
            // blocking it breaks a request a real person made inside an assistant
            // (worst case, fail). A training or search crawler is often blocked
            // on purpose (warn).
            status: isUserAction ? "fail" : "warn",
            message: isUserAction
              ? `${probeName} is blocked (${verdict.reason}) while the browser gets 200: this would break a live fetch a real user triggers inside an assistant, the worst case for agent access`
              : `${probeName} is blocked (${verdict.reason}) while the browser gets 200: often an intentional opt-out, but confirm it was deliberate`,
            value: `${label} blocked`,
            details: {
              userAgent: probe.userAgent,
              userAgentString: probe.userAgentString,
              ...evidence,
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
      const names = aiProbes.map((p) => labelFor(p.userAgent));
      checks.push({
        name: "agent-blocking",
        status: "pass",
        message:
          names.length > 4
            ? `All ${names.length} AI UA probes (${joinNames(names)}) reached the homepage like a browser`
            : `${joinNames(names)} UA probes reached the homepage like a browser`,
        value: "no blocking",
        details: {
          probes: aiProbes.map((p) => ({
            userAgent: p.userAgent,
            status: p.status,
            xRobotsTag: p.xRobotsTag ?? null,
          })),
        },
      });
    }

    // Opt-in all-token mode (#3788): one info check carries every probe's evidence.
    // The mode is read off the probes themselves (a bot outside the default pair was
    // probed), so it survives any storage round trip without a flag of its own.
    const allTokens = aiProbes.some(
      (p) => !(DEFAULT_AGENT_ACCESS_BOT_IDS as readonly string[]).includes(p.userAgent),
    );
    if (allTokens) {
      const entries = aiProbes.map((p) => ({
        userAgent: p.userAgent,
        token: labelFor(p.userAgent),
        userAgentString: p.userAgentString,
        status: p.status,
        xRobotsTag: p.xRobotsTag ?? null,
        verdict: classifyProbe(p, browser.bodySize).kind,
      }));
      const matched = entries.filter((e) => e.verdict === "ok").length;
      checks.push({
        name: "agent-access-probes",
        status: "info",
        message: `Probed ${entries.length} AI user agents (UA probe, not the real bots): ${matched} matched the browser`,
        value: `${matched}/${entries.length}`,
        details: { probes: entries, browserXRobotsTag: browser.xRobotsTag ?? null },
      });
    }

    return { checks };
  },
};
