// security/get-state-change - forms that change state must not submit by GET (#2337)

import type { CheckItem } from "@squirrelscan/core-contracts";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import {
  belongsTo,
  describeAction,
  hasNoUsableAction,
  safeFormSelector,
  safeFormSnippet,
  scriptSubmits,
  submissions,
} from "./password-form-get";

/** Whole-word verbs that mean a request changes something. */
const STATE_VERBS = new Set([
  "delete",
  "remove",
  "destroy",
  "erase",
  "logout",
  "logoff",
  "signout",
  "create",
  "update",
  "save",
  "pay",
  "checkout",
  "purchase",
  "transfer",
  "cancel",
  "confirm",
  "unsubscribe",
  "subscribe",
  "approve",
  "reject",
  "revoke",
]);

/** Two-word verbs, matched on adjacent tokens ("Sign out", "Log out"). */
const STATE_PHRASES: [string, string][] = [
  ["sign", "out"],
  ["log", "out"],
  ["check", "out"],
  ["opt", "out"],
];

/** Field names a read-only filter or search form is made of. */
const READ_ONLY_FIELDS = new Set([
  "q",
  "s",
  "query",
  "search",
  "keyword",
  "keywords",
  "term",
  "filter",
  "sort",
  "order",
  "orderby",
  "page",
  "category",
  "tag",
  "lang",
  "year",
  "month",
  "min",
  "max",
  "per_page",
  "limit",
]);

const MAX_TEXT = 200;
const MAX_FIELDS = 200;

/** Lowercase tokens split on non-alphanumerics and camelCase, so `deleteAccount` reads as delete, account. */
function tokens(text: string): string[] {
  return text
    .slice(0, MAX_TEXT)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t !== "");
}

/** The first state-changing verb among the tokens, or null. */
export function findVerb(list: string[]): string | null {
  for (let i = 0; i < list.length; i++) {
    const t = list[i]!;
    if (STATE_VERBS.has(t)) return t;
    for (const [a, b] of STATE_PHRASES) {
      if (t === a && list[i + 1] === b) return `${a} ${b}`;
    }
  }
  return null;
}

/** The action's path only: query and fragment are not part of what the form does. */
function actionPath(form: Element): string {
  const raw = (form.getAttribute("action") ?? "").trim();
  if (/^javascript:/i.test(raw)) return "";
  const noOrigin = raw.replace(/^([a-z][a-z0-9+.-]*:)?\/\/[^/?#]*/i, "");
  return noOrigin.split(/[?#]/)[0]!.slice(0, MAX_TEXT);
}

function submitText(controls: Element[]): string[] {
  const out: string[] = [];
  for (const el of controls) {
    if (el.hasAttribute("disabled")) continue;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") ?? "").trim().toLowerCase();
    if (tag === "button" && type !== "button" && type !== "reset") {
      out.push(
        el.getAttribute("aria-label") ??
          (el.textContent ?? "").slice(0, MAX_TEXT)
      );
    } else if (tag === "input" && (type === "submit" || type === "image")) {
      out.push(el.getAttribute("value") ?? el.getAttribute("alt") ?? "");
    }
  }
  return out;
}

function fieldType(el: Element): string {
  return (el.getAttribute("type") ?? "text").trim().toLowerCase();
}

function isSearchForm(
  form: Element,
  fields: Element[],
  named: string[]
): boolean {
  if ((form.getAttribute("role") ?? "").trim().toLowerCase() === "search") {
    return true;
  }
  if (fields.some((el) => fieldType(el) === "search")) return true;
  return named.length > 0 && named.every((n) => READ_ONLY_FIELDS.has(n));
}

/** An email or username field: the form collects who someone is. */
function credentialField(fields: Element[]): string | null {
  for (const el of fields) {
    if (fieldType(el) === "email") return "email";
    const auto = (el.getAttribute("autocomplete") ?? "").toLowerCase();
    if (/\b(username|email)\b/.test(auto)) return "username or email";
    const ids = tokens(
      `${el.getAttribute("name") ?? ""} ${el.getAttribute("id") ?? ""}`
    );
    if (ids.some((t) => t === "email" || t === "username" || t === "login")) {
      return "login or email";
    }
  }
  return null;
}

export const getStateChangeRule: Rule = {
  meta: {
    id: "security/get-state-change",
    name: "State-changing form submitted by GET",
    description:
      "Checks that forms that delete, pay, log out or sign someone in do not submit by GET",
    solution:
      'GET requests must be safe: browsers prefetch them, crawlers follow them and chat apps preview them. A form that deletes, pays or logs out over GET can be triggered by any of those, and one that submits an email or username by GET puts it in the URL, history and logs. Set method="post" on the form (and check formmethod on its buttons) and make the server reject GET on that endpoint. Search and filter forms are not flagged.',
    category: "security",
    scope: "page",
    findingScope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 6,
    checks: [
      { name: "get-state-change", outcome: "problem" },
      { name: "get-credential-form", outcome: "problem" },
      {
        name: "get-state-change",
        outcome: "clean",
        clears: ["get-state-change", "get-credential-form"],
      },
    ],
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const forms = [...doc.querySelectorAll("form")];
    const allControls = [
      ...doc.querySelectorAll("button, input, select, textarea"),
    ];
    const stateful: CheckItem[] = [];
    const credential: CheckItem[] = [];
    let assessed = 0;

    forms.forEach((form, index) => {
      const controls = allControls
        .filter((el) => belongsTo(el, form))
        .slice(0, MAX_FIELDS);
      const hasPassword = controls.some(
        (el) =>
          el.tagName.toLowerCase() === "input" && fieldType(el) === "password"
      );
      // security/password-form-get owns every form with a password field.
      if (hasPassword) return;

      const ways = submissions(form, controls);
      const getWays = ways.filter((way) => way.method === "get");
      if (getWays.length === 0) return;
      // A script-driven form (no method, no action) is submitted by its script, not by GET.
      if (
        hasNoUsableAction(form) &&
        (getWays.every((way) => !way.explicit) || scriptSubmits(form, controls))
      ) {
        return;
      }
      assessed++;

      const fields = controls.filter((el) => {
        if (el.hasAttribute("disabled")) return false;
        const tag = el.tagName.toLowerCase();
        return tag === "input"
          ? fieldType(el) !== "hidden" &&
              !/^(submit|image|button|reset)$/.test(fieldType(el))
          : tag !== "button";
      });
      const named = fields
        .map((el) => (el.getAttribute("name") ?? "").trim().toLowerCase())
        .filter((n) => n !== "");
      const searchLike = isSearchForm(form, fields, named);
      const action = describeAction(form);
      const position = `form ${index + 1} of ${forms.length}`;
      const item = (
        label: string,
        reason: string,
        detail: string
      ): CheckItem => ({
        id: safeFormSelector(form, index),
        label,
        snippet: safeFormSnippet(form, 240),
        meta: {
          reason,
          detail,
          action,
          position: index + 1,
          forms: forms.length,
        },
      });

      if ((form.getAttribute("role") ?? "").trim().toLowerCase() === "search") {
        return;
      }

      const pathVerb = findVerb(tokens(actionPath(form)));
      const textVerb = searchLike
        ? null
        : findVerb(submitText(controls).flatMap((t) => tokens(t)));
      const verb = pathVerb ?? textVerb;
      if (verb !== null) {
        const where =
          pathVerb !== null ? `its action path` : `its submit button text`;
        stateful.push(
          item(
            `${position} (${action}) submits by GET but looks state-changing: ${where} says "${verb}"`,
            pathVerb !== null ? "action-verb" : "submit-text-verb",
            verb
          )
        );
        return;
      }
      if (searchLike) return;
      const cred = credentialField(fields);
      if (cred !== null) {
        credential.push(
          item(
            `${position} (${action}) submits a ${cred} field by GET, which puts it in the URL`,
            "credential-field",
            cred
          )
        );
      }
    });

    const checks: CheckResult[] = [];
    const details = { formsChecked: forms.length, getForms: assessed };
    if (stateful.length > 0) {
      checks.push({
        name: "get-state-change",
        status: "fail",
        message: `${stateful.length} form(s) that look state-changing submit by GET`,
        items: stateful,
        details,
      });
    }
    if (credential.length > 0) {
      checks.push({
        name: "get-credential-form",
        status: "warn",
        message: `${credential.length} form(s) submit a login or email field by GET`,
        items: credential,
        details,
      });
    }
    if (checks.length === 0) {
      checks.push({
        name: "get-state-change",
        status: "pass",
        message: "No form that looks state-changing submits by GET",
        details,
      });
    }
    return { checks };
  },
};
