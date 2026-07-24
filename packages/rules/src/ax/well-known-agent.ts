// ax/well-known-agent - detect MCP server cards, A2A agent cards, and agent-skills manifests

import type { WellKnownProbe } from "@squirrelscan/core-contracts";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

const MCP_PATHS: readonly string[] = [
  "/.well-known/mcp/server-card.json",
  "/.well-known/mcp.json",
  "/.well-known/mcp",
  "/.well-known/mcp-server",
];
const A2A_PATH = "/.well-known/agent-card.json";
const AGENT_SKILLS_PATH = "/.well-known/agent-skills/index.json";
const DEPRECATED_PATHS: readonly string[] = ["/ai-plugin.json", "/.well-known/ai-plugin.json"];

// Fields that plausibly indicate a real MCP/A2A manifest rather than an
// unrelated JSON document that happened to 200 at the path.
const PLAUSIBLE_KEYS = ["url", "name", "transport", "endpoint", "version"];

function isRealHit(p: WellKnownProbe): boolean {
  return p.status === 200 && p.jsonValid && !p.looksHtml;
}

function looksPlausible(p: WellKnownProbe): boolean {
  return p.jsonKeys.some((k) => PLAUSIBLE_KEYS.includes(k.toLowerCase()));
}

interface ManifestHit {
  kind: string;
  probe: WellKnownProbe;
}

export const wellKnownAgentRule: Rule = {
  meta: {
    id: "ax/well-known-agent",
    name: "Well-Known Agent Files",
    description:
      "Detects MCP server cards, A2A agent cards, and agent-skills manifests under .well-known — machine-readable descriptors that let an agent discover an MCP endpoint or A2A-compatible agent without a human in the loop",
    solution:
      "If the site backs an MCP server, an A2A-compatible agent, or a packaged skill set, publish the corresponding manifest at its .well-known path. This is detect-and-inform only: adoption is still under 0.01% of sites, so absence is never penalized. Remove any leftover /.well-known/ai-plugin.json from the ChatGPT-plugins era — it's stale and more likely to confuse a modern agent than help it.",
    category: "ax",
    scope: "site",
    severity: "info",
    weight: 1,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const wk = ctx.site?.wellKnown;

    if (!wk) {
      checks.push({ name: "well-known-agent", status: "info", message: "well-known probe data not available" });
      return { checks };
    }

    const mcpHit = wk.probes.find((p) => MCP_PATHS.includes(p.path) && isRealHit(p));
    const a2aHit = wk.probes.find((p) => p.path === A2A_PATH && isRealHit(p));
    const skillsHit = wk.probes.find((p) => p.path === AGENT_SKILLS_PATH && isRealHit(p));

    const hits: ManifestHit[] = [
      ...(mcpHit ? [{ kind: "MCP server card", probe: mcpHit }] : []),
      ...(a2aHit ? [{ kind: "A2A agent card", probe: a2aHit }] : []),
      ...(skillsHit ? [{ kind: "agent-skills manifest", probe: skillsHit }] : []),
    ];

    if (hits.length === 0) {
      // Detect-and-inform only — absence stays a single quiet info, never a warning.
      checks.push({
        name: "well-known-agent",
        status: "info",
        message: "No MCP server card, A2A agent card, or agent-skills manifest found",
        value: "absent",
      });
    } else {
      for (const hit of hits) {
        const plausible = looksPlausible(hit.probe);
        checks.push({
          name: "well-known-agent-present",
          status: "info",
          message: `${hit.kind} found at ${hit.probe.path}${
            plausible ? "" : " (JSON present, but no plausible manifest fields recognized)"
          }`,
          value: "present",
          details: {
            kind: hit.kind,
            path: hit.probe.path,
            jsonKeys: hit.probe.jsonKeys,
            plausible,
          },
        });
      }
    }

    const deprecatedHit = wk.probes.find((p) => DEPRECATED_PATHS.includes(p.path) && isRealHit(p));
    if (deprecatedHit) {
      checks.push({
        name: "well-known-agent-deprecated",
        status: "warn",
        message: `Found deprecated OpenAI plugin manifest at ${deprecatedHit.path} — this format was retired; remove it to avoid confusing modern agents`,
        value: "deprecated",
        details: { path: deprecatedHit.path },
      });
    }

    return { checks };
  },
};
