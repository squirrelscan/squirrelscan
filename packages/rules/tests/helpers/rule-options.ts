import type { Rule } from "../../src/types";

// The runner parses a rule's options through its schema, so defaults apply. A clean-run test that passes
// a raw `{}` skips them and makes rules with a required-by-default option throw.
export function parsedOptions(rule: Rule): Record<string, unknown> {
  const schema = rule.meta.optionsSchema;
  if (!schema) return {};
  const parsed = schema.safeParse({});
  return parsed.success ? (parsed.data as Record<string, unknown>) : {};
}
