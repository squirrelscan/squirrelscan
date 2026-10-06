// a11y/aria-dialog-name - Dialog elements have accessible names

import type { CheckItem, CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { fieldSnippet } from "../shared/form-fields";

// Classes kept in an id-less dialog's descriptor: enough to tell a page's
// drawers and popups apart without echoing a utility-class soup.
const MAX_DESCRIPTOR_CLASSES = 3;

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

/**
 * A selector-like handle for an unnamed dialog, in the a11y rules' `tag#id` /
 * `tag.class` style. `withId` is the form used when the element has an id
 * (kept as it was, so those items read the same as before); `withoutId` is
 * the base the classes are appended to.
 */
function describeDialog(el: Element, withId: string, withoutId: string): string {
  const id = el.getAttribute("id");
  if (id) return `${withId}#${id}`;
  const classes = (el.getAttribute("class") || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_DESCRIPTOR_CLASSES);
  return withoutId + classes.map((cls) => `.${cls}`).join("");
}

/**
 * One item per unnamed dialog, with its start tag as the snippet. The item id
 * is the finding's identity across rescans, so it depends only on the markup:
 * a descriptor two dialogs share gets an ordinal from the second one on, in
 * document order, counted over EVERY dialog of the kind, named or not. Naming
 * one drawer then leaves the other drawers' ids alone. An ordinal that would
 * repeat an id already given out is skipped.
 */
function unnamedDialogItems(
  dialogs: Iterable<Element>,
  describe: (el: Element) => string,
  isNamed: (el: Element) => boolean
): CheckItem[] {
  const seen = new Map<string, number>();
  const used = new Set<string>();
  const items: CheckItem[] = [];
  for (const el of dialogs) {
    const descriptor = describe(el);
    let count = seen.get(descriptor) ?? 0;
    let id: string;
    do {
      count++;
      id = count === 1 ? descriptor : `${descriptor} (${count})`;
    } while (used.has(id));
    seen.set(descriptor, count);
    used.add(id);
    if (!isNamed(el)) items.push({ id, snippet: fieldSnippet(el) });
  }
  return items;
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
    verdictScope: "page",
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

    const isNamed = (el: Element) => hasAccessibleName(el, doc);

    // Check ARIA dialogs — fail if unnamed
    const unnamed = unnamedDialogItems(
      ariaDialogs,
      (dialog) => {
        const role = dialog.getAttribute("role") || "dialog";
        return describeDialog(dialog, role, `${dialog.tagName.toLowerCase()}[role="${role}"]`);
      },
      isNamed
    );

    if (unnamed.length > 0) {
      checks.push({
        name: "aria-dialog-name",
        status: "fail",
        message: `${unnamed.length} ARIA dialog(s) without accessible names`,
        items: unnamed.slice(0, 10),
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
    const unnamedNative = unnamedDialogItems(
      nativeDialogs,
      (dialog) => describeDialog(dialog, "dialog", "dialog"),
      isNamed
    );

    if (unnamedNative.length > 0) {
      checks.push({
        name: "dialog-name",
        status: "warn",
        message: `${unnamedNative.length} native <dialog>(s) without accessible names`,
        items: unnamedNative.slice(0, 10),
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
