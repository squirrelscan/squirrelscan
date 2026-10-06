// schema/json-ld-valid - Validates JSON-LD structured data

import { validateSchemas } from "@squirrelscan/parser";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

// `schema.errors` carries the validator's messages after the JSON parse
// errors; they are reported once, as validation items.
const VALIDATION_MESSAGE_PREFIX = "Validation:";

export const jsonLdValidRule: Rule = {
  meta: {
    id: "schema/json-ld-valid",
    name: "JSON-LD Valid",
    description: "Validates JSON-LD structured data",
    solution:
      "JSON-LD structured data helps search engines understand your content and can unlock rich results. Validate against schema.org rules (headline, author, datePublished for articles, name/url for organizations, etc.) and keep the JSON well-formed. Use squirrelscan's built-in schema validator to expose the exact missing property path before verifying on Google's Rich Results Test, and ensure each required field points to a canonical resource.",
    category: "schema",
    scope: "page",
    verdictScope: "page",
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

    // Validated here rather than read from `schemas.validationIssues`: those
    // were computed when the page was crawled, and a page reused from the crawl
    // cache (304, hash match) keeps the stored verdicts of the release that
    // first fetched it. The stored issues are the fallback when the parsed
    // schemas themselves were not kept (rehydration then yields an empty list).
    const parsedSchemas = Array.isArray(schemas.all) ? schemas.all : [];
    const validationIssues =
      parsedSchemas.length > 0
        ? validateSchemas(parsedSchemas, schemas.untypedNodes ?? [])
        : (schemas.validationIssues ?? []);
    const parseErrors = (schema.errors ?? []).filter(
      (error) => !error.startsWith(VALIDATION_MESSAGE_PREFIX),
    );

    if (parseErrors.length > 0 || validationIssues.length > 0) {
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
          label:
            issue.severity === "invalid"
              ? `${issue.type} has an invalid ${issue.property}`
              : `${issue.type} missing ${issue.property}`,
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
