// security/password-form-get - password forms must not submit by GET

import type { CheckItem } from "@squirrelscan/core-contracts";

import { formSelector } from "../shared/form-fields";
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

/** One way of submitting a form: the method it would use, and whether markup SAID so. */
export interface Submission {
  method: Method;
  /** A `method` (or the control's `formmethod`) attribute is present: the author chose it, even to an invalid value. */
  explicit: boolean;
}

/**
 * The method each way of submitting this form would use: one entry per submit
 * control (its `formmethod`, else the form's `method`), or the form's own
 * method when there is no submit control and only Enter submits it. `explicit`
 * is false when neither attribute is there and GET is only the default: that is
 * the shape of a React, Vue or Svelte form, whose script submits it.
 */
export function submissions(form: Element, controls: Element[]): Submission[] {
  const formMethod: Submission = {
    method: methodOf(form.getAttribute("method")),
    explicit: form.hasAttribute("method"),
  };
  const submitters = controls.filter(isSubmitControl);
  if (submitters.length === 0) return [formMethod];
  return submitters.map((el) =>
    el.hasAttribute("formmethod")
      ? { method: methodOf(el.getAttribute("formmethod")), explicit: true }
      : formMethod,
  );
}

/** The method each way of submitting this form would use (see {@link submissions}). */
export function submitMethods(form: Element, controls: Element[]): Method[] {
  return submissions(form, controls).map((entry) => entry.method);
}

/**
 * True when the form leaves the network submission to a script squirrel cannot
 * see: no usable `action` plus an inline handler. Handlers added with
 * addEventListener are not visible in markup, so those forms are assessed on
 * their attributes.
 */
function scriptSubmits(form: Element, controls: Element[]): boolean {
  if (!hasNoUsableAction(form)) return false;
  return form.hasAttribute("onsubmit") || controls.some((el) => el.hasAttribute("onclick"));
}

/** No `action`, an empty one, or a `javascript:` one (what React puts there for a form action function). */
function hasNoUsableAction(form: Element): boolean {
  const action = (form.getAttribute("action") ?? "").trim();
  return action === "" || /^javascript:/i.test(action);
}

/**
 * The action as the finding shows it: without its credentials, query and fragment. An action can
 * carry a token (`/login?token=...`), and the label and meta are stored and sent on.
 */
export function describeAction(form: Element): string {
  const raw = (form.getAttribute("action") ?? "").trim();
  if (raw === "") return "(no action)";
  const bare = raw
    .replace(/^([a-z][a-z0-9+.-]*:)?\/\/[^/?#]*@/i, "$1//")
    .split(/[?#]/)[0]!
    .slice(0, 120);
  return bare === "" ? "(this page)" : bare;
}

/**
 * The form's opening tag as the finding stores it, with its `action` cut to {@link describeAction}:
 * the shared snippet helper prints every attribute whole, and the action is the one that can carry a
 * token. Same cap and whitespace handling as that helper.
 */
function safeFormSnippet(form: Element, max: number): string {
  let out = "<form";
  for (const attr of form.attributes) {
    const value =
      attr.name.toLowerCase() === "action"
        ? describeAction(form)
        : attr.value.slice(0, max).replace(/\s+/g, " ").trim();
    out += ` ${attr.name}="${value}"`;
    if (out.length >= max) break;
  }
  out += ">";
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/** The form's selector, with an `action`-based one carrying the bare action, never its query or credentials. */
function safeFormSelector(form: Element, index: number): string {
  const selector = formSelector(form, index);
  const action = form.getAttribute("action");
  return action && selector === `form[action="${action}"]`
    ? `form[action="${describeAction(form)}"]`
    : selector;
}

export const passwordFormGetRule: Rule = {
  meta: {
    id: "security/password-form-get",
    name: "Password form method",
    description: "Checks that forms with a password field do not submit by GET",
    solution:
      'A form with a password field and method="get", or no method (GET is the default), puts the password in the URL when it is submitted. From there it lands in browser history, server and proxy logs, analytics and the Referer header sent to other sites. Set method="post" on the form, and check formmethod on every submit button, because one GET button is enough to expose the password. A form with no method and no action, which is how a script-driven login form (React, Vue, Svelte) looks in the DOM, is a warning: it falls back to GET if its script has not loaded or fails, and method="post" removes that risk. A form whose submit is handled by an inline handler and has no action is reported as not determined, not as a failure.',
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
    const noMethod: CheckItem[] = [];
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

      const ways = submissions(form, controls);
      const getWays = ways.filter((way) => way.method === "get");
      if (getWays.length === 0) return;

      const action = describeAction(form);
      const position = `form ${index + 1} of ${forms.length}`;
      const item = (label: string, reason: string): CheckItem => ({
        id: safeFormSelector(form, index),
        label,
        snippet: safeFormSnippet(form, 240),
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
      // GET only because nothing said otherwise, and nothing says where it goes: the shape of a
      // script-driven form (React, Vue, Svelte), which the script submits. It is GET only if that
      // script has not loaded or fails, so it is a warning, not a failure.
      const onlyByDefault = getWays.every((way) => !way.explicit);
      if (onlyByDefault && hasNoUsableAction(form)) {
        noMethod.push(
          item(
            `${position} (${action}) has a password field and no method: it falls back to GET, putting the password in the URL, if its script has not loaded or fails; method="post" removes the risk`,
            "no-method",
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
    if (noMethod.length > 0) {
      checks.push({
        name: "password-form-get-no-method",
        status: "warn",
        message: `${noMethod.length} password form(s) with no method and no action fall back to GET if their script fails`,
        items: noMethod,
        details: { formsChecked: forms.length, passwordForms: assessed },
      });
    }
    if (
      failing.length === 0 &&
      undetermined.length === 0 &&
      noMethod.length === 0 &&
      assessed > 0
    ) {
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
