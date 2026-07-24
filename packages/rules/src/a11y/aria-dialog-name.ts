// a11y/aria-dialog-name - Dialog elements have accessible names

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

function hasAccessibleName(el: Element, doc: Document): boolean {
  if (el.getAttribute("aria-label")?.trim()) return true;
  if (el.getAttribute("title")?.trim()) return true;
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    for (const id of labelledBy.split(/\s+/)) {
      const ref = doc.getElementById(id);
      if (ref?.textContent?.trim()) return true;
    }
  }
  return false;
}

export const ariaDialogNameRule: Rule = {
  meta: {
    id: "a11y/aria-dialog-name",
    name: "ARIA Dialog Name",
    description: "Checks that dialog elements have accessible names",
    solution:
      "Elements with role='dialog' or role='alertdialog' (and native <dialog>) must have an accessible name. Add aria-label with a descriptive label, or use aria-labelledby pointing to a visible heading inside the dialog. A title attribute also works but is less preferred. Without a name, screen reader users won't know the purpose of the dialog.",
    category: "a11y",
    scope: "page",
    severity: "error",
    weight: 7,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    // ARIA dialogs: explicit role — require accessible name (fail)
    const ariaDialogs = doc.querySelectorAll(
      '[role="dialog"], [role="alertdialog"]'
    );

    // Native <dialog> without explicit ARIA role — browsers auto-announce,
    // so missing name is a recommendation (warn), not a hard fail
    const nativeDialogs = doc.querySelectorAll(
      'dialog:not([role="dialog"]):not([role="alertdialog"])'
    );

    if (ariaDialogs.length === 0 && nativeDialogs.length === 0) {
      checks.push({
        name: "aria-dialog-name",
        status: "info",
        message: "No dialog elements found",
      });
      return { checks };
    }

    // Check ARIA dialogs — fail if unnamed
    const unnamed: string[] = [];
    for (const dialog of ariaDialogs) {
      if (!hasAccessibleName(dialog, doc)) {
        const role = dialog.getAttribute("role") || "dialog";
        const id = dialog.getAttribute("id");
        unnamed.push(id ? `${role}#${id}` : role);
      }
    }

    if (unnamed.length > 0) {
      checks.push({
        name: "aria-dialog-name",
        status: "fail",
        message: `${unnamed.length} ARIA dialog(s) without accessible names`,
        items: unnamed.slice(0, 10).map((id) => ({ id })),
        details:
          unnamed.length > 10 ? { additional: unnamed.length - 10 } : undefined,
      });
    } else if (ariaDialogs.length > 0) {
      checks.push({
        name: "aria-dialog-name",
        status: "pass",
        message: `All ${ariaDialogs.length} ARIA dialog(s) have accessible names`,
        details: { dialogsChecked: ariaDialogs.length },
      });
    }

    // Check native <dialog> — warn if unnamed (browser provides implicit role)
    const unnamedNative: string[] = [];
    for (const dialog of nativeDialogs) {
      if (!hasAccessibleName(dialog, doc)) {
        const id = dialog.getAttribute("id");
        unnamedNative.push(id ? `dialog#${id}` : "dialog");
      }
    }

    if (unnamedNative.length > 0) {
      checks.push({
        name: "dialog-name",
        status: "warn",
        message: `${unnamedNative.length} native <dialog>(s) without accessible names`,
        items: unnamedNative.slice(0, 10).map((id) => ({ id })),
        details:
          unnamedNative.length > 10
            ? { additional: unnamedNative.length - 10 }
            : undefined,
      });
    } else if (nativeDialogs.length > 0) {
      checks.push({
        name: "dialog-name",
        status: "pass",
        message: `All ${nativeDialogs.length} native <dialog>(s) have accessible names`,
        details: { dialogsChecked: nativeDialogs.length },
      });
    }

    return { checks };
  },
};
