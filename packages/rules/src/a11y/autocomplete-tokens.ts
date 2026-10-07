// a11y/autocomplete-tokens - Identified fields carry the right autofill token

import type { CheckItem } from "@squirrelscan/core-contracts";

import {
  buildLabelIndex,
  fieldSelector,
  fieldSnippet,
  inferFieldPurpose,
  isDataField,
  type LabelIndex,
  parseAutocomplete,
  segmentsOf,
} from "../shared/form-fields";
import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

/** One field that carries the wrong token, or none at all. */
interface Offender {
  item: CheckItem;
  /** `incorrect` fails the check; `missing` only warns. */
  kind: "incorrect" | "missing";
}

/** Autofill tokens that describe a site preference, not the person. */
const NON_PERSONAL_TOKENS = new Set([
  "country",
  "country-name",
  "language",
  "transaction-currency",
  "transaction-amount",
]);

/**
 * True when the field collects something about the user other than a country:
 * a recognised purpose (name, email, phone, address, payment), a bare `name`
 * field, or a personal autocomplete token on a field the helper cannot name.
 */
function isOtherPersonalField(el: Element, labels: LabelIndex): boolean {
  const purpose = inferFieldPurpose(el, labels);
  if (purpose) return purpose.token !== "country";

  for (const attr of ["name", "id"]) {
    const segments = segmentsOf(el.getAttribute(attr) ?? "");
    if (segments.length === 1 && segments[0] === "name") return true;
  }

  const raw = el.getAttribute("autocomplete");
  if (raw === null) return false;
  const parsed = parseAutocomplete(raw);
  return parsed.kind === "field" && !NON_PERSONAL_TOKENS.has(parsed.token);
}

export const autocompleteTokensRule: Rule = {
  meta: {
    id: "a11y/autocomplete-tokens",
    name: "Autocomplete Tokens",
    description:
      "Checks that name, email, phone, address and payment fields carry the correct autocomplete token",
    solution:
      "Give every field that collects a person's own data the matching WHATWG autofill token, e.g. autocomplete='given-name', 'email', 'tel', 'address-line1', 'postal-code', 'cc-number'. Browsers and password managers fill those fields in one tap, which is the difference between a completed checkout and an abandoned one, and WCAG 2.1 success criterion 1.3.5 (Identify Input Purpose) requires it. Tokens may be prefixed with section-*, shipping/billing and home/work/mobile, e.g. autocomplete='shipping address-line1'. A token the browser does not recognise is ignored outright, so a typo like 'firstname' is worse than nothing: use 'given-name'. Avoid autocomplete='off' on personal data; it does not stop autofill in modern browsers, it only stops the accurate kind.",
    category: "a11y",
    scope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const labels = buildLabelIndex(doc);
    const offenders: Offender[] = [];
    let identified = 0;
    // Form -> does it hold a personal field other than a country? Country
    // selects in locale/market switchers are site preferences, not user data.
    const formHasPersonalField = new Map<Element, boolean>();
    const isLoneCountry = (el: Element): boolean => {
      const form = el.closest("form");
      if (!form) return false;
      let personal = formHasPersonalField.get(form);
      if (personal === undefined) {
        personal = [...form.querySelectorAll("input, select, textarea")].some(
          (f) => isDataField(f) && isOtherPersonalField(f, labels),
        );
        formHasPersonalField.set(form, personal);
      }
      return !personal;
    };

    for (const el of doc.querySelectorAll("input, select, textarea")) {
      if (!isDataField(el)) continue;
      const purpose = inferFieldPurpose(el, labels);
      if (!purpose) continue;

      const selector = fieldSelector(el);
      const snippet = fieldSnippet(el);
      const raw = el.getAttribute("autocomplete");

      // A lone country field with no token (or on/off) is left alone. A token
      // that is present is still validated.
      if (
        purpose.token === "country" &&
        (raw === null || ["", "on", "off"].includes(raw.trim().toLowerCase())) &&
        isLoneCountry(el)
      ) {
        continue;
      }
      identified++;

      if (raw === null || raw.trim() === "") {
        offenders.push({
          kind: "missing",
          item: {
            id: selector,
            label: `${purpose.label} field has no autocomplete token (expected "${purpose.token}")`,
            snippet,
            meta: { reason: "missing", purpose: purpose.label, expected: purpose.token },
          },
        });
        continue;
      }

      const parsed = parseAutocomplete(raw);

      if (parsed.kind === "off" || parsed.kind === "on") {
        offenders.push({
          kind: "missing",
          item: {
            id: selector,
            label: `${purpose.label} field sets autocomplete="${parsed.kind}" instead of "${purpose.token}"`,
            snippet,
            meta: {
              reason: "disabled",
              purpose: purpose.label,
              expected: purpose.token,
              actual: raw.trim(),
            },
          },
        });
        continue;
      }

      if (parsed.kind === "invalid") {
        offenders.push({
          kind: "incorrect",
          item: {
            id: selector,
            label: `autocomplete="${raw.trim()}" is not a valid token (expected "${purpose.token}")`,
            snippet,
            meta: {
              reason: "invalid-token",
              purpose: purpose.label,
              expected: purpose.token,
              actual: raw.trim(),
            },
          },
        });
        continue;
      }

      const accepted = [purpose.token, ...purpose.alternatives];
      if (!accepted.includes(parsed.token)) {
        offenders.push({
          kind: "incorrect",
          item: {
            id: selector,
            label: `${purpose.label} field is tagged autocomplete="${parsed.token}" (expected "${purpose.token}")`,
            snippet,
            meta: {
              reason: "wrong-token",
              purpose: purpose.label,
              expected: purpose.token,
              actual: parsed.token,
            },
          },
        });
      }
    }

    if (identified === 0) {
      checks.push({
        name: "autocomplete-tokens",
        status: "skipped",
        message: "No name, email, phone, address or payment fields found",
        skipReason: "no-identifiable-fields",
      });
      return { checks };
    }

    const incorrect = offenders.filter((o) => o.kind === "incorrect").length;
    const missing = offenders.length - incorrect;

    if (offenders.length === 0) {
      checks.push({
        name: "autocomplete-tokens",
        status: "pass",
        message: `${identified} identified field(s) carry the correct autocomplete token`,
        details: { fieldsChecked: identified },
      });
    } else if (incorrect > 0) {
      checks.push({
        name: "autocomplete-tokens",
        status: "fail",
        message: `${incorrect} field(s) carry the wrong autocomplete token${
          missing > 0 ? `, ${missing} carry none` : ""
        }`,
        items: offenders.map((o) => o.item),
        details: { fieldsChecked: identified, incorrect, missing },
      });
    } else {
      checks.push({
        name: "autocomplete-tokens",
        status: "warn",
        message: `${missing} identified field(s) missing an autocomplete token`,
        items: offenders.map((o) => o.item),
        details: { fieldsChecked: identified, incorrect, missing },
      });
    }

    return { checks };
  },
};
