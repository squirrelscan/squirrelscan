// Rule registry tools — deterministic, free, no auth.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { type Rule, getDocsUrl, loadAllRules } from "@squirrelscan/rules";
import { z } from "zod";

import { errorResult, jsonResult } from "../result";

// Memoize the registry — the built-in rule set is static for the process lifetime.
let rulesCache: Map<string, Rule> | null = null;
function getRules(): Map<string, Rule> {
  if (!rulesCache) rulesCache = loadAllRules();
  return rulesCache;
}

// Serializable rule view — drops optionsSchema (a Zod object) so it JSON-encodes.
function serializeRule(rule: Rule) {
  const {
    id,
    name,
    description,
    solution,
    category,
    subcategory,
    scope,
    severity,
    weight,
  } = rule.meta;
  return {
    id,
    name,
    description,
    solution,
    category,
    subcategory,
    scope,
    severity,
    weight,
    docsUrl: getDocsUrl(id),
  };
}

export function registerRuleTools(server: McpServer): void {
  server.registerTool(
    "list_rules",
    {
      title: "List audit rules",
      description:
        "List every built-in audit rule (id, name, category, severity, scope). Deterministic and free; no login required.",
      inputSchema: {},
    },
    async () => {
      const rules = [...getRules().values()].map((rule) => {
        const { id, name, category, subcategory, scope, severity } = rule.meta;
        return { id, name, category, subcategory, scope, severity };
      });
      return jsonResult({ count: rules.length, rules });
    }
  );

  server.registerTool(
    "get_rule",
    {
      title: "Get an audit rule",
      description:
        "Fetch the full definition of one audit rule by id (e.g. core/meta-title): description, solution, category, severity, weight, docs URL. Deterministic and free.",
      inputSchema: {
        id: z.string().describe("The rule id (e.g. core/meta-title)"),
      },
    },
    async ({ id }) => {
      const rule = getRules().get(id);
      if (!rule)
        return errorResult(
          `Unknown rule id: ${id}. Use list_rules to see all rule ids.`
        );
      return jsonResult(serializeRule(rule));
    }
  );
}
