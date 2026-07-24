// a11y/aria-valid-attr-value - Valid values for ARIA attributes

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

// ARIA attribute value types and valid values
const ariaAttributeValues: Record<string, { type: string; values?: string[] }> =
  {
    "aria-autocomplete": {
      type: "token",
      values: ["inline", "list", "both", "none"],
    },
    "aria-busy": { type: "boolean" },
    "aria-checked": { type: "tristate", values: ["true", "false", "mixed"] },
    "aria-current": {
      type: "token",
      values: ["page", "step", "location", "date", "time", "true", "false"],
    },
    "aria-disabled": { type: "boolean" },
    "aria-dropeffect": {
      type: "tokenlist",
      values: ["copy", "execute", "link", "move", "none", "popup"],
    },
    "aria-expanded": { type: "boolean-or-undefined" },
    "aria-grabbed": { type: "boolean-or-undefined" },
    "aria-haspopup": {
      type: "token",
      values: ["true", "false", "menu", "listbox", "tree", "grid", "dialog"],
    },
    "aria-hidden": { type: "boolean-or-undefined" },
    "aria-invalid": {
      type: "token",
      values: ["true", "false", "grammar", "spelling"],
    },
    "aria-level": { type: "integer" },
    "aria-live": { type: "token", values: ["off", "polite", "assertive"] },
    "aria-modal": { type: "boolean" },
    "aria-multiline": { type: "boolean" },
    "aria-multiselectable": { type: "boolean" },
    "aria-orientation": {
      type: "token",
      values: ["horizontal", "vertical", "undefined"],
    },
    "aria-pressed": { type: "tristate", values: ["true", "false", "mixed"] },
    "aria-readonly": { type: "boolean" },
    "aria-relevant": {
      type: "tokenlist",
      values: ["additions", "all", "removals", "text"],
    },
    "aria-required": { type: "boolean" },
    "aria-selected": { type: "boolean-or-undefined" },
    "aria-sort": {
      type: "token",
      values: ["none", "ascending", "descending", "other"],
    },
    "aria-valuemax": { type: "number" },
    "aria-valuemin": { type: "number" },
    "aria-valuenow": { type: "number" },
  };

function validateAriaValue(
  attr: string,
  value: string
): { valid: boolean; reason?: string } {
  const spec = ariaAttributeValues[attr];
  if (!spec) return { valid: true }; // Unknown attr validated elsewhere

  const trimmed = value.trim().toLowerCase();

  switch (spec.type) {
    case "boolean":
      if (trimmed !== "true" && trimmed !== "false") {
        return {
          valid: false,
          reason: `must be 'true' or 'false', got '${value}'`,
        };
      }
      break;

    case "boolean-or-undefined":
      if (
        trimmed !== "true" &&
        trimmed !== "false" &&
        trimmed !== "undefined" &&
        trimmed !== ""
      ) {
        return {
          valid: false,
          reason: `must be 'true', 'false', or 'undefined', got '${value}'`,
        };
      }
      break;

    case "tristate":
      if (!spec.values?.includes(trimmed)) {
        return {
          valid: false,
          reason: `must be 'true', 'false', or 'mixed', got '${value}'`,
        };
      }
      break;

    case "token":
      if (spec.values && !spec.values.includes(trimmed)) {
        return {
          valid: false,
          reason: `invalid value '${value}', expected: ${spec.values.join(", ")}`,
        };
      }
      break;

    case "tokenlist":
      if (spec.values) {
        const tokens = trimmed.split(/\s+/);
        for (const token of tokens) {
          if (!spec.values.includes(token)) {
            return {
              valid: false,
              reason: `invalid token '${token}' in '${value}'`,
            };
          }
        }
      }
      break;

    case "integer":
      if (!/^-?\d+$/.test(trimmed)) {
        return { valid: false, reason: `must be an integer, got '${value}'` };
      }
      break;

    case "number":
      if (!/^-?\d*\.?\d+$/.test(trimmed) && trimmed !== "") {
        return { valid: false, reason: `must be a number, got '${value}'` };
      }
      break;
  }

  return { valid: true };
}

export const ariaValidAttrValueRule: Rule = {
  meta: {
    id: "a11y/aria-valid-attr-value",
    name: "ARIA Valid Attribute Values",
    description: "Checks for valid values in ARIA attributes",
    solution:
      "Ensure ARIA attribute values match the expected type. Boolean attributes should be 'true' or 'false'. Enumerated attributes like aria-current have specific allowed values. Numeric attributes like aria-level must be numbers. Check the WAI-ARIA specification for valid values.",
    category: "a11y",
    scope: "page",
    severity: "error",
    weight: 8,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const allElements = doc.querySelectorAll("*");
    const invalidValues: string[] = [];

    for (const el of allElements) {
      const attrs = el.attributes;
      if (!attrs) continue;

      for (const attr of Array.from(attrs)) {
        const name = attr.name.toLowerCase();

        if (name.startsWith("aria-")) {
          const validation = validateAriaValue(name, attr.value);
          if (!validation.valid) {
            const tagName = el.tagName.toLowerCase();
            invalidValues.push(`${tagName}[${name}]: ${validation.reason}`);
          }
        }
      }
    }

    if (invalidValues.length > 0) {
      checks.push({
        name: "aria-valid-attr-value",
        status: "fail",
        message: `${invalidValues.length} ARIA attribute(s) with invalid values`,
        items: invalidValues.slice(0, 10).map((id) => ({ id })),
        details:
          invalidValues.length > 10
            ? { additional: invalidValues.length - 10 }
            : undefined,
      });
    } else {
      checks.push({
        name: "aria-valid-attr-value",
        status: "pass",
        message: "All ARIA attribute values are valid",
      });
    }

    return { checks };
  },
};
