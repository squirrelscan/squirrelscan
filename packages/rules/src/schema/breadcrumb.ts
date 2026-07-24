// schema/breadcrumb - BreadcrumbList schema validation

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const breadcrumbSchemaRule: Rule = {
  meta: {
    id: "schema/breadcrumb",
    name: "Breadcrumb Schema",
    description: "Checks for BreadcrumbList schema on non-homepage",
    solution:
      "BreadcrumbList schema shows navigation path in search results. Structure: BreadcrumbList with itemListElement array of ListItem. Each ListItem needs position (1, 2, 3...), name, and item (URL). The last item (current page) doesn't need a URL. Breadcrumbs help users understand site structure and improve click-through rates.",
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

    // Skip homepage
    if (url.pathname === "/" || url.pathname === "") {
      checks.push({
        name: "breadcrumb-schema",
        status: "info",
        message: "Homepage - breadcrumbs not typically needed",
      });
      return { checks };
    }

    const schemaScripts = doc.querySelectorAll(
      'script[type="application/ld+json"]'
    );
    let breadcrumbSchema: Record<string, unknown> | null = null;

    for (const script of schemaScripts) {
      try {
        const data = JSON.parse(script.textContent || "");
        const schemas = Array.isArray(data) ? data : [data];

        for (const schema of schemas) {
          const type = schema["@type"];
          if (
            type === "BreadcrumbList" ||
            (Array.isArray(type) && type.includes("BreadcrumbList"))
          ) {
            breadcrumbSchema = schema;
            break;
          }
        }
      } catch {
        // Invalid JSON
      }
    }

    if (!breadcrumbSchema) {
      checks.push({
        name: "breadcrumb-schema",
        status: "info",
        message: "No BreadcrumbList schema found",
        value: "Consider adding for non-homepage",
      });
      return { checks };
    }

    // Check itemListElement
    const items = breadcrumbSchema["itemListElement"];
    if (!items || !Array.isArray(items) || items.length === 0) {
      checks.push({
        name: "breadcrumb-items",
        status: "warn",
        message: "BreadcrumbList has no items",
      });
      return { checks };
    }

    // Validate items
    let hasValidItems = true;
    let lastPosition = 0;

    for (const item of items) {
      const position = item["position"];
      const name = item["name"];

      if (!position || !name) {
        hasValidItems = false;
      }

      if (typeof position === "number" && position !== lastPosition + 1) {
        checks.push({
          name: "breadcrumb-order",
          status: "warn",
          message: "Breadcrumb positions not sequential",
        });
      }
      lastPosition = position;
    }

    if (hasValidItems) {
      checks.push({
        name: "breadcrumb-valid",
        status: "pass",
        message: `BreadcrumbList has ${items.length} item(s)`,
      });
    } else {
      checks.push({
        name: "breadcrumb-items",
        status: "warn",
        message: "Some breadcrumb items missing position or name",
      });
    }

    return { checks };
  },
};
