// schema/website-search - WebSite with SearchAction schema

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const websiteSearchSchemaRule: Rule = {
  meta: {
    id: "schema/website-search",
    name: "WebSite Search Schema",
    description: "Checks for WebSite schema with sitelinks searchbox",
    solution:
      "WebSite schema with SearchAction enables the sitelinks searchbox in Google results. Add to your homepage: WebSite with url, potentialAction (SearchAction with target URL using {search_term_string} placeholder, and query-input). This lets users search your site directly from Google results.",
    category: "schema",
    scope: "page",
    severity: "info",
    weight: 3,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const url = new URL(ctx.page.url);

    // This is typically on homepage
    const isHomepage = url.pathname === "/" || url.pathname === "";

    const schemaScripts = doc.querySelectorAll(
      'script[type="application/ld+json"]'
    );
    let websiteSchema: Record<string, unknown> | null = null;

    for (const script of schemaScripts) {
      try {
        const data = JSON.parse(script.textContent || "");
        const schemas = Array.isArray(data) ? data : [data];

        for (const schema of schemas) {
          const type = schema["@type"];
          if (
            type === "WebSite" ||
            (Array.isArray(type) && type.includes("WebSite"))
          ) {
            websiteSchema = schema;
            break;
          }
        }
      } catch {
        // Invalid JSON
      }
    }

    if (!websiteSchema) {
      if (isHomepage) {
        checks.push({
          name: "website-schema",
          status: "info",
          message: "No WebSite schema on homepage",
          value: "Consider adding for sitelinks searchbox",
        });
      }
      return { checks };
    }

    checks.push({
      name: "website-schema",
      status: "pass",
      message: "WebSite schema found",
    });

    // Check for SearchAction
    const potentialAction = websiteSchema["potentialAction"];
    if (!potentialAction) {
      checks.push({
        name: "website-search",
        status: "info",
        message: "WebSite has no potentialAction",
        value: "Add SearchAction for sitelinks searchbox",
      });
      return { checks };
    }

    const actions = Array.isArray(potentialAction)
      ? potentialAction
      : [potentialAction];
    const searchAction = actions.find((a) => a["@type"] === "SearchAction");

    if (!searchAction) {
      checks.push({
        name: "website-search",
        status: "info",
        message: "WebSite has no SearchAction",
      });
      return { checks };
    }

    // Validate SearchAction
    const target = searchAction["target"];
    const queryInput = searchAction["query-input"];

    if (!target) {
      checks.push({
        name: "search-action",
        status: "warn",
        message: "SearchAction missing target URL",
      });
    } else if (!queryInput) {
      checks.push({
        name: "search-action",
        status: "warn",
        message: "SearchAction missing query-input",
      });
    } else {
      checks.push({
        name: "search-action",
        status: "pass",
        message: "SearchAction properly configured",
      });
    }

    return { checks };
  },
};
