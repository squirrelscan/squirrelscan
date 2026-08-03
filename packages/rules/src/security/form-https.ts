// security/form-https - Form actions use HTTPS

import type { CheckItem } from "@squirrelscan/core-contracts";

import { fieldSnippet, formSelector } from "../shared/form-fields";
import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

/** `javascript:`, `mailto:` and friends never travel over the network. */
const NON_NETWORK_SCHEMES = /^(?:javascript|mailto|tel|sms|data|blob|about):/i;

/** An action that carries its own scheme, or a protocol-relative `//host/path`. */
const EXPLICIT_SCHEME = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i;

/** A literal http:// action, however malformed the rest of the URL is. */
const LITERAL_HTTP = /^http:\/\//i;

/**
 * `formaction` only overrides submission on a submit control. On anything else
 * it is an inert attribute, so flagging it would be a false positive.
 */
const FORMACTION_SUBMITTERS =
  'button[formaction]:not([type="button" i]):not([type="reset" i]), input[type="submit" i][formaction], input[type="image" i][formaction]';

interface Submitter {
  /** The element carrying the action, for the selector/snippet. */
  el: Element;
  /** Raw attribute value. */
  raw: string;
  attribute: "action" | "formaction";
  index: number;
}

export const formHttpsRule: Rule = {
  meta: {
    id: "security/form-https",
    name: "Form HTTPS",
    description: "Checks that form actions use HTTPS",
    solution:
      "Forms should always submit to HTTPS URLs to protect user data in transit. Update form action attributes from http:// to https://, and check formaction on any submit button that overrides the form. A form on an HTTPS page that posts to http:// is the worst case: the padlock tells the user they are safe while the submission itself travels in the clear, and browsers block or interstitial it. Be especially careful with login forms, payment forms, and any forms collecting personal data. For relative URLs, ensure the page itself is on HTTPS.",
    category: "security",
    scope: "page",
    // A fail only happens on the insecure-submission-from-a-secure-page case;
    // the report degrades this to "warning" when every check merely warned.
    severity: "error",
    weight: 6,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const pageUrl = ctx.page.finalUrl || ctx.page.url;
    let base: URL | null = null;
    try {
      base = new URL(pageUrl);
    } catch {
      base = null;
    }
    const pageIsHttps = base?.protocol === "https:";

    const forms = [...doc.querySelectorAll("form")];
    const submitters: Submitter[] = [];

    forms.forEach((form, index) => {
      const raw = form.getAttribute("action");
      if (raw !== null) submitters.push({ el: form, raw, attribute: "action", index });
    });
    for (const el of doc.querySelectorAll(FORMACTION_SUBMITTERS)) {
      const raw = el.getAttribute("formaction");
      if (raw === null) continue;
      // A formaction item is named by its own attribute, never by form index.
      submitters.push({ el, raw, attribute: "formaction", index: -1 });
    }

    const insecure: CheckItem[] = [];
    let onInsecurePage = 0;

    for (const { el, raw, attribute, index } of submitters) {
      const value = raw.trim();
      if (value === "" || value.startsWith("#")) continue;
      if (NON_NETWORK_SCHEMES.test(value)) continue;
      // A relative action inherits the page's scheme, so it can only be
      // insecure when the page is — which security/https already reports.
      if (!EXPLICIT_SCHEME.test(value)) continue;

      let resolved: URL | null = null;
      try {
        resolved = base ? new URL(value, base) : new URL(value);
      } catch {
        resolved = null;
      }
      // An unparseable action still submits in the clear when it literally
      // starts with http:// — the old rule caught those and so must this one.
      if (resolved ? resolved.protocol !== "http:" : !LITERAL_HTTP.test(value)) continue;
      const target = resolved?.href ?? value;

      if (!pageIsHttps) onInsecurePage++;
      insecure.push({
        id:
          attribute === "action"
            ? formSelector(el, index)
            : `${el.tagName.toLowerCase()}[formaction="${value}"]`,
        label: pageIsHttps
          ? `HTTPS page submits to ${target} in the clear`
          : `Form submits to ${target}`,
        snippet: fieldSnippet(el, 240),
        meta: {
          reason: pageIsHttps ? "https-page-http-action" : "http-action",
          action: target,
          attribute,
        },
      });
    }

    if (insecure.length > 0) {
      // An HTTPS page posting to http:// is an active downgrade, not a nit.
      const downgrades = insecure.length - onInsecurePage;
      checks.push({
        name: "form-https",
        status: downgrades > 0 ? "fail" : "warn",
        message:
          downgrades > 0
            ? `${downgrades} form(s) on this HTTPS page submit to HTTP`
            : `${insecure.length} form(s) submit to HTTP`,
        items: insecure,
        details: { formsChecked: forms.length, downgrades },
      });
    } else if (submitters.length > 0) {
      checks.push({
        name: "form-https",
        status: "pass",
        message: "All forms use secure submission",
        details: { formsChecked: forms.length },
      });
    } else {
      checks.push({
        name: "form-https",
        status: "info",
        message: "No forms detected",
      });
    }

    return { checks };
  },
};
