// schema/json-ld-valid - Validates JSON-LD structured data

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const jsonLdValidRule: Rule = {
  meta: {
    id: "schema/json-ld-valid",
    name: "JSON-LD Valid",
    description: "Validates JSON-LD structured data",
    solution:
      "JSON-LD structured data helps search engines understand your content and can unlock rich results. Validate against schema.org rules (headline, author, datePublished for articles, name/url for organizations, etc.) and keep the JSON well-formed. Use SquirrelScan's built-in schema validator to expose the exact missing property path before verifying on Google's Rich Results Test, and ensure each required field points to a canonical resource.",
    category: "schema",
    scope: "page",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const { schema, schemas } = ctx.parsed;
    const checks: CheckResult[] = [];

    if (!schema?.raw) {
      checks.push({
        name: "json-ld",
        status: "info",
        message: "No JSON-LD structured data found",
        value: null,
      });
      return { checks };
    }

    // Defensive: parser can occasionally return undefined validation metadata on malformed pages
    if (!schemas) {
      checks.push({
        name: "json-ld",
        status: "info",
        message: "JSON-LD detected but schema metadata unavailable",
      });
      return { checks };
    }

    const validationIssues = schemas.validationIssues ?? [];
    const parseErrors = schema.errors ?? [];

    if (
      !schemas.valid ||
      parseErrors.length > 0 ||
      validationIssues.length > 0
    ) {
      const failureMessage =
        parseErrors.length > 0
          ? "Invalid JSON-LD syntax"
          : "Schema.org validation errors detected";

      const items = [
        ...parseErrors.map((err, index) => ({
          id: `parse-${index}`,
          label: err,
        })),
        ...validationIssues.map((issue) => ({
          id: `${issue.type}:${issue.property}`,
          label: `${issue.type} missing ${issue.property}`,
          meta: {
            message: issue.message,
            severity: issue.severity,
            path: issue.path,
          },
        })),
      ];

      checks.push({
        name: "json-ld-valid",
        status: "fail",
        message: failureMessage,
        items,
      });
      return { checks };
    }

    if (schemas.types.length === 0) {
      checks.push({
        name: "json-ld-types",
        status: "warn",
        message: "JSON-LD present but no @type found",
      });
    } else {
      checks.push({
        name: "json-ld",
        status: "pass",
        message: `Valid JSON-LD with ${schemas.types.length} type(s)`,
        items: schemas.types.map((type) => ({ id: type })),
      });
    }

    return { checks };
  },
};
