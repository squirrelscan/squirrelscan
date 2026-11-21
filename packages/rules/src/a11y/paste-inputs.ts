// a11y/paste-inputs - Detect authentication fields that block paste (WCAG 3.3.8, squirrelscan/squirrelscan#2106)

import { wcag } from "@squirrelscan/core-contracts/wcag";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

/** The autocomplete tokens that mark a field as a password or one-time-code entry. */
export const AUTH_AUTOCOMPLETE_TOKENS: ReadonlySet<string> = new Set([
  "current-password",
  "new-password",
  "one-time-code",
]);

/** Input types that take no typed value, so cannot be an authentication field. */
const NON_TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  "hidden",
  "checkbox",
  "radio",
  "submit",
  "button",
  "reset",
  "image",
  "file",
  "range",
  "color",
]);

/** Inline handler values that cancel the event. */
const BLOCKING_PATTERNS = [
  "return false",
  "return!1",
  "preventdefault",
  "event.returnvalue=false",
  "event.returnvalue=!1",
];

/** Why a field counts as an authentication field, or null when it does not. */
export function authFieldReason(el: Element): string | null {
  const tag = el.tagName.toLowerCase();
  if (tag !== "input" && tag !== "textarea") return null;
  const type = (el.getAttribute("type") ?? "").trim().toLowerCase();
  if (tag === "input" && NON_TEXT_INPUT_TYPES.has(type)) return null;
  if (tag === "input" && type === "password") return "type=password";
  const tokens = (el.getAttribute("autocomplete") ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/);
  const token = tokens.find((t) => AUTH_AUTOCOMPLETE_TOKENS.has(t));
  return token ? `autocomplete=${token}` : null;
}

/** True when an inline `onpaste` handler cancels the paste. */
export function blocksPaste(el: Element): boolean {
  const onpaste = el.getAttribute("onpaste");
  if (!onpaste) return false;
  const value = onpaste.toLowerCase();
  return BLOCKING_PATTERNS.some((p) => value.includes(p));
}

export const pasteInputsRule: Rule = {
  meta: {
    id: "a11y/paste-inputs",
    name: "Paste Inputs",
    description:
      "Detects password and one-time-code fields that prevent pasting",
    solution:
      "Remove any JavaScript that prevents pasting into password and one-time-code fields. Blocking paste forces users to transcribe a password from a password manager or a code from another device by hand, which WCAG 2.2 success criterion 3.3.8 Accessible Authentication (Minimum) treats as a cognitive function test. Remove onpaste='return false', event.preventDefault() on paste events, and similar anti-paste code.",
    category: "a11y",
    wcag: [wcag("3.3.8")],
    scope: "page",
    findingScope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const authFields: { el: Element; reason: string }[] = [];
    for (const el of doc.querySelectorAll("input, textarea")) {
      const reason = authFieldReason(el);
      if (reason) authFields.push({ el, reason });
    }

    const blocking = authFields
      .filter(({ el }) => blocksPaste(el))
      .map(({ el, reason }) => {
        const name =
          el.getAttribute("name") ||
          el.getAttribute("id") ||
          el.getAttribute("placeholder") ||
          reason;
        return `${name} (${reason})`;
      });

    if (blocking.length > 0) {
      checks.push({
        name: "paste-inputs",
        status: "fail",
        message: `${blocking.length} authentication field(s) prevent paste`,
        items: blocking.map((id) => ({ id })),
      });
    } else if (authFields.length > 0) {
      checks.push({
        name: "paste-inputs",
        status: "pass",
        message: "No paste-blocking authentication fields detected",
        details: { inputsChecked: authFields.length },
      });
    } else {
      checks.push({
        name: "paste-inputs",
        status: "info",
        message: "No password or one-time-code fields found",
      });
    }

    return { checks };
  },
};
