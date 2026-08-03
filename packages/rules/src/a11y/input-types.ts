// a11y/input-types - Typed inputs, keyboard hints, and native validation
//
// Three ways markup opts out of help the browser would give for free:
// the wrong `type`, no `enterkeyhint` on a long form, and `novalidate` on a
// form that still declares constraints and ships no validation of its own.

import type { CheckItem } from "@squirrelscan/core-contracts";

import {
  buildLabelIndex,
  fieldSelector,
  fieldSnippet,
  formDataFields,
  formSelector,
  inferExpectedInputType,
  inferFieldPurpose,
  inputType,
  isDataField,
  isNumberHostile,
} from "../shared/form-fields";
import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

/** Below this a form is a search box or a login, not a form worth a hint. */
const MULTI_FIELD_THRESHOLD = 3;

/** `inputmode` values that already deliver the keyboard a given `type` would. */
const EQUIVALENT_INPUTMODE: Record<string, string[]> = {
  email: ["email"],
  tel: ["tel"],
  url: ["url"],
  number: ["numeric", "decimal"],
};

/** Attributes that ask the browser to enforce something. */
const CONSTRAINT_ATTRIBUTES = [
  "required",
  "pattern",
  "min",
  "max",
  "minlength",
  "maxlength",
  "step",
];

/** Input types with built-in validation of their own. */
const VALIDATING_TYPES = new Set(["email", "url", "number", "date", "time", "month", "week"]);

/**
 * Markup that says "this form validates itself in JavaScript". Any one of
 * these makes `novalidate` a deliberate choice rather than a mistake.
 */
const CUSTOM_VALIDATION_SELECTORS = [
  "[oninvalid]",
  "[aria-invalid]",
  "[aria-errormessage]",
  '[role="alert"]',
  "[aria-live]",
  "[data-error]",
  "[data-validate]",
  "[data-val]",
  "[data-rules]",
];

/** Script text that only appears when a page drives validation itself. */
const CUSTOM_VALIDATION_SCRIPT_HINTS = [
  "checkvalidity",
  "reportvalidity",
  "setcustomvalidity",
  "react-hook-form",
  "useform(",
  "formik",
  "jquery.validate",
  "parsley",
  "just-validate",
];

function hasConstraints(fields: Element[]): boolean {
  for (const field of fields) {
    if (CONSTRAINT_ATTRIBUTES.some((attr) => field.hasAttribute(attr))) return true;
    if (VALIDATING_TYPES.has(inputType(field))) return true;
  }
  return false;
}

function hasCustomValidation(form: Element, scriptText: string): boolean {
  if (form.hasAttribute("onsubmit") || form.hasAttribute("oninvalid")) return true;
  for (const selector of CUSTOM_VALIDATION_SELECTORS) {
    if (form.querySelector(selector)) return true;
  }
  return CUSTOM_VALIDATION_SCRIPT_HINTS.some((hint) => scriptText.includes(hint));
}

export const inputTypesRule: Rule = {
  meta: {
    id: "a11y/input-types",
    name: "Input Types",
    description:
      "Checks that fields use the right input type and keyboard hint, and that forms keep native validation",
    solution:
      "Use the input type that matches the data: type='email', type='tel', type='url' and type='number' each summon the right mobile keyboard and bring free browser validation with them, while type='text' gives users the full QWERTY keyboard and no help at all. Never use type='number' for a digit string such as a postal code, phone number or card number: it strips leading zeros, adds a spinner, and silently discards anything that is not a valid float. If you need a numeric keypad without those side effects, keep type='text' and add inputmode='numeric'. On forms with several fields, set enterkeyhint='next' on each field and enterkeyhint='send' or 'done' on the last one so the mobile return key says what it does. Only add novalidate when your own JavaScript takes over validation: on a form that still declares required or pattern and ships no replacement, it removes the browser's error messages and hands users nothing back.",
    category: "a11y",
    scope: "page",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const labels = buildLabelIndex(doc);

    // --- Input types -------------------------------------------------------
    const wrongType: CheckItem[] = [];
    const hostileNumber: CheckItem[] = [];
    let typedFieldsChecked = 0;

    for (const el of doc.querySelectorAll("input")) {
      if (!isDataField(el)) continue;
      const type = inputType(el);
      const purpose = inferFieldPurpose(el, labels);
      const expected = inferExpectedInputType(el, labels);
      const hostile = type === "number" && isNumberHostile(purpose);

      // Nothing to say about a field whose purpose implies no particular type.
      if (!expected && !hostile) continue;
      typedFieldsChecked++;

      if (hostile) {
        hostileNumber.push({
          id: fieldSelector(el),
          label: `${purpose?.label ?? "This"} field uses type="number", which strips leading zeros and drops non-numeric input`,
          snippet: fieldSnippet(el),
          meta: {
            reason: "number-hostile",
            purpose: purpose?.label,
            actual: "number",
            expected: 'text with inputmode="numeric"',
          },
        });
        continue;
      }

      // Already carries a specific type — that is the fix, whatever it is.
      if (type !== "text") continue;

      // inputmode already delivers the keyboard; a deliberate, documented choice.
      const mode = (el.getAttribute("inputmode") || "").trim().toLowerCase();
      if (expected && EQUIVALENT_INPUTMODE[expected]?.includes(mode)) continue;

      wrongType.push({
        id: fieldSelector(el),
        label: `type="text" where type="${expected}" is correct`,
        snippet: fieldSnippet(el),
        meta: { reason: "wrong-type", actual: "text", expected },
      });
    }

    if (typedFieldsChecked === 0) {
      checks.push({
        name: "input-types",
        status: "skipped",
        message: "No inputs with an evident type found",
        skipReason: "no-typed-inputs",
      });
    } else if (hostileNumber.length > 0) {
      checks.push({
        name: "input-types",
        status: "fail",
        message: `${hostileNumber.length} digit-string field(s) use type="number"${
          wrongType.length > 0 ? `, ${wrongType.length} other field(s) use the wrong type` : ""
        }`,
        items: [...hostileNumber, ...wrongType],
        details: { fieldsChecked: typedFieldsChecked },
      });
    } else if (wrongType.length > 0) {
      checks.push({
        name: "input-types",
        status: "warn",
        message: `${wrongType.length} field(s) use type="text" where a specific type is correct`,
        items: wrongType,
        details: { fieldsChecked: typedFieldsChecked },
      });
    } else {
      checks.push({
        name: "input-types",
        status: "pass",
        message: `${typedFieldsChecked} field(s) use the correct input type`,
        details: { fieldsChecked: typedFieldsChecked },
      });
    }

    // --- Enter key hint ----------------------------------------------------
    const forms = [...doc.querySelectorAll("form")];
    const withoutHint: CheckItem[] = [];
    let multiFieldForms = 0;

    forms.forEach((form, index) => {
      const fields = formDataFields(form);
      if (fields.length < MULTI_FIELD_THRESHOLD) return;
      multiFieldForms++;
      if (fields.some((field) => (field.getAttribute("enterkeyhint") || "").trim() !== "")) return;
      withoutHint.push({
        id: formSelector(form, index),
        label: `${fields.length}-field form, no field sets enterkeyhint`,
        snippet: fieldSnippet(form, 240),
        meta: { reason: "missing-enterkeyhint", fields: fields.length },
      });
    });

    if (multiFieldForms === 0) {
      checks.push({
        name: "enterkeyhint",
        status: "skipped",
        message: `No forms with ${MULTI_FIELD_THRESHOLD} or more fields found`,
        skipReason: "no-multi-field-forms",
      });
    } else if (withoutHint.length > 0) {
      checks.push({
        name: "enterkeyhint",
        status: "warn",
        message: `${withoutHint.length} multi-field form(s) set no enterkeyhint`,
        items: withoutHint,
        details: { formsChecked: multiFieldForms },
      });
    } else {
      checks.push({
        name: "enterkeyhint",
        status: "pass",
        message: `${multiFieldForms} multi-field form(s) set enterkeyhint`,
        details: { formsChecked: multiFieldForms },
      });
    }

    // --- novalidate intent mismatch ---------------------------------------
    const novalidateForms = forms.filter((form) => form.hasAttribute("novalidate"));
    const mismatches: CheckItem[] = [];

    if (novalidateForms.length > 0) {
      const scriptText = [...doc.querySelectorAll("script")]
        .map((script) => script.textContent ?? "")
        .join("\n")
        .toLowerCase();

      for (const form of novalidateForms) {
        const index = forms.indexOf(form);
        const fields = formDataFields(form);
        // Only a mismatch when the form still asks the browser to enforce
        // something AND ships nothing of its own to replace it.
        if (!hasConstraints(fields)) continue;
        if (hasCustomValidation(form, scriptText)) continue;
        mismatches.push({
          id: formSelector(form, index),
          label: "novalidate disables the browser's error messages, but the form still declares constraints and no custom validation",
          snippet: fieldSnippet(form, 240),
          meta: { reason: "novalidate-mismatch", fields: fields.length },
        });
      }
    }

    if (novalidateForms.length === 0) {
      checks.push({
        name: "form-novalidate",
        status: "skipped",
        message: "No forms set novalidate",
        skipReason: "no-novalidate-forms",
      });
    } else if (mismatches.length > 0) {
      checks.push({
        name: "form-novalidate",
        status: "warn",
        message: `${mismatches.length} form(s) set novalidate but still rely on browser constraints`,
        items: mismatches,
        details: { formsChecked: novalidateForms.length },
      });
    } else {
      checks.push({
        name: "form-novalidate",
        status: "pass",
        message: `${novalidateForms.length} form(s) set novalidate deliberately`,
        details: { formsChecked: novalidateForms.length },
      });
    }

    return { checks };
  },
};
