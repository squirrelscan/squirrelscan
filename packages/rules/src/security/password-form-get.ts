// security/password-form-get - password forms must not submit by GET

import type { CheckItem } from "@squirrelscan/core-contracts";

import { fieldSnippet, formSelector } from "../shared/form-fields";
import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

type Method = "get" | "post" | "dialog";

/**
 * A `method` or `formmethod` value, read like the HTML spec: case-insensitive,
 * and anything that is not `post` or `dialog` is GET (the invalid value default).
 */
export function methodOf(raw: string | null): Method {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "post") return "post";
  if (value === "dialog") return "dialog";
  return "get";
}

/** The controls that submit a form: a button of type submit (the default), or an input submit/image. */
function isSubmitControl(el: Element): boolean {
  if (el.hasAttribute("disabled")) return false;
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute("type") ?? "").trim().toLowerCase();
  if (tag === "button") return type !== "button" && type !== "reset" && type !== "menu";
  if (tag === "input") return type === "submit" || type === "image";
  return false;
}

/** A control belongs to its `form` attribute's form, else to its nearest form ancestor. */
function belongsTo(el: Element, form: Element): boolean {
  const owner = el.getAttribute("form");
  if (owner !== null) {
    const id = form.getAttribute("id");
    return id !== null && id !== "" && owner === id;
  }
  return el.closest("form") === form;
}

/**
 * The method each way of submitting this form would use: one entry per submit
 * control (its `formmethod`, else the form's `method`), or the form's own
 * method when there is no submit control and only Enter submits it.
 */
export function submitMethods(form: Element, controls: Element[]): Method[] {
  const formMethod = methodOf(form.getAttribute("method"));
  const submitters = controls.filter(isSubmitControl);
  if (submitters.length === 0) return [formMethod];
  return submitters.map((el) =>
    el.hasAttribute("formmethod") ? methodOf(el.getAttribute("formmethod")) : formMethod,
  );
}

/**
 * True when the form leaves the network submission to a script squirrel cannot
 * see: no usable `action` plus an inline handler. Handlers added with
 * addEventListener are not visible in markup, so those forms are assessed on
 * their attributes.
 */
function scriptSubmits(form: Element, controls: Element[]): boolean {
  const action = (form.getAttribute("action") ?? "").trim();
  const noAction = action === "" || /^javascript:/i.test(action);
  if (!noAction) return false;
  return form.hasAttribute("onsubmit") || controls.some((el) => el.hasAttribute("onclick"));
}

function describeAction(form: Element): string {
  const action = (form.getAttribute("action") ?? "").trim().slice(0, 120);
  return action === "" ? "(no action)" : action;
}

export const passwordFormGetRule: Rule = {
  meta: {
    id: "security/password-form-get",
    name: "Password form method",
    description: "Checks that forms with a password field do not submit by GET",
    solution:
      'A form with a password field and method="get", or no method (GET is the default), puts the password in the URL when it is submitted. From there it lands in browser history, server and proxy logs, analytics and the Referer header sent to other sites. Set method="post" on the form, and check formmethod on every submit button, because one GET button is enough to expose the password. A form whose submit is handled by script and has no action is reported as not determined, not as a failure.',
    category: "security",
    scope: "page",
    verdictScope: "page",
    severity: "error",
    weight: 8,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const forms = [...doc.querySelectorAll("form")];
    const allControls = [...doc.querySelectorAll("button, input")];
    const failing: CheckItem[] = [];
    const undetermined: CheckItem[] = [];
    let assessed = 0;

    forms.forEach((form, index) => {
      const controls = allControls.filter((el) => belongsTo(el, form));
      const hasPassword = controls.some(
        (el) =>
          el.tagName.toLowerCase() === "input" &&
          (el.getAttribute("type") ?? "").trim().toLowerCase() === "password" &&
          !el.hasAttribute("disabled"),
      );
      if (!hasPassword) return;
      assessed++;

      const methods = submitMethods(form, controls);
      if (!methods.includes("get")) return;

      const action = describeAction(form);
      const position = `form ${index + 1} of ${forms.length}`;
      const item = (label: string, reason: string): CheckItem => ({
        id: formSelector(form, index),
        label,
        snippet: fieldSnippet(form, 240),
        meta: { reason, action, position: index + 1, forms: forms.length },
      });

      if (scriptSubmits(form, controls)) {
        undetermined.push(
          item(
            `${position} (${action}) has a password field and no action, and a script may submit it: not determined`,
            "script-submit",
          ),
        );
        return;
      }
      failing.push(
        item(
          `${position} (${action}) sends its password field by GET, in the URL`,
          "get-method",
        ),
      );
    });

    const checks: CheckResult[] = [];
    if (failing.length > 0) {
      checks.push({
        name: "password-form-get",
        status: "fail",
        message: `${failing.length} form(s) with a password field submit by GET`,
        items: failing,
        details: { formsChecked: forms.length, passwordForms: assessed },
      });
    }
    if (undetermined.length > 0) {
      checks.push({
        name: "password-form-get-undetermined",
        status: "info",
        message: `${undetermined.length} password form(s) submitted by script: method not determined`,
        items: undetermined,
        details: { formsChecked: forms.length, passwordForms: assessed },
      });
    }
    if (failing.length === 0 && undetermined.length === 0 && assessed > 0) {
      checks.push({
        name: "password-form-get",
        status: "pass",
        message: "Every form with a password field submits by POST",
        details: { formsChecked: forms.length, passwordForms: assessed },
      });
    }
    return { checks };
  },
};
