// a11y/aria-dialog-name - Dialog elements have accessible names

import type { CheckItem, CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { fieldSnippet } from "../shared/form-fields";
import {
  createStaticVisibility,
  sortUnnamedControls,
  unconfirmedRow,
  type UnnamedControls,
} from "../shared/static-hidden";

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
 * One item per unnamed dialog, with its start tag as the snippet, filed into
 * `unnamed` by whether the dialog is in the accessibility tree (pub#671). The
 * item id is the finding's identity across rescans, so it depends only on the
 * markup: a descriptor two dialogs share gets an ordinal from the second one
 * on, in document order, counted over EVERY dialog of the kind, named or not,
 * hidden or not. Naming or opening one drawer then leaves the other drawers'
 * ids alone. An ordinal that would repeat an id already given out is skipped.
 */
function unnamedDialogItems(
  dialogs: Iterable<Element>,
  describe: (el: Element) => string,
  isNamed: (el: Element) => boolean,
  unnamed: UnnamedControls<CheckItem>
): void {
  const seen = new Map<string, number>();
  const used = new Set<string>();
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
    if (!isNamed(el)) unnamed.add(el, { id, snippet: fieldSnippet(el) });
  }
}

export const ariaDialogNameRule: Rule = {
  meta: {
    id: "a11y/aria-dialog-name",
    name: "ARIA Dialog Name",
    description: "Checks that dialog elements have accessible names",
    solution:
      "Elements with role='dialog' or role='alertdialog' (and native <dialog>) must have an accessible name. Add aria-label with a descriptive label, or use aria-labelledby pointing to a visible heading inside the dialog. A title attribute also works but is less preferred. Without a name, screen reader users won't know the purpose of the dialog. A dialog hidden by the hidden attribute, aria-hidden or an inline style='display:none' while closed is not reported, but it needs a name before it opens; a closed native <dialog> is still checked, since pages open it with script. squirrel does not read <style> blocks or stylesheets, so a dialog hidden only by a class rule is still reported.",
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
    // pub#671: a dialog out of the accessibility tree (marked aria-hidden or
    // hidden while closed, or inside a hidden ancestor) is not reported. It
    // needs a name when it opens. A native <dialog> is served closed and
    // opened by script, so its own closed state does not take it out of the
    // check (#462), whichever path it takes; hidden any other way, it is out.
    const visibility = createStaticVisibility({ ariaHidden: true });
    const nativeVisibility = createStaticVisibility({
      ariaHidden: true,
      closedDialogsShown: true,
    });
    const dialogVisibility = {
      visibility: (el: Element) =>
        (el.tagName.toLowerCase() === "dialog" ? nativeVisibility : visibility).visibility(el),
    };

    // Check ARIA dialogs — fail if unnamed
    const aria = sortUnnamedControls<CheckItem>(dialogVisibility);
    unnamedDialogItems(
      ariaDialogs,
      (dialog) => {
        const role = dialog.getAttribute("role") || "dialog";
        return describeDialog(dialog, role, `${dialog.tagName.toLowerCase()}[role="${role}"]`);
      },
      isNamed,
      aria
    );
    const unnamed = aria.failures;

    if (unnamed.length > 0) {
      checks.push({
        name: "aria-dialog-name",
        status: "fail",
        message: `${unnamed.length} ARIA dialog(s) without accessible names`,
        items: unnamed.slice(0, 10),
        details:
          unnamed.length > 10 ? { additional: unnamed.length - 10 } : undefined,
      });
    }
    if (aria.unconfirmed.length > 0) {
      checks.push(
        unconfirmedRow(
          "aria-dialog-name",
          "ARIA dialog(s) without accessible names",
          aria.unconfirmed
        )
      );
    }
    if (unnamed.length === 0 && aria.unconfirmed.length === 0 && ariaDialogs.length > 0) {
      checks.push({
        name: "aria-dialog-name",
        status: "pass",
        ...(aria.hidden > 0
          ? {
              message: "All ARIA dialogs in the accessibility tree have accessible names",
              details: { dialogsChecked: ariaDialogs.length, hiddenWithoutName: aria.hidden },
            }
          : {
              message: `All ${ariaDialogs.length} ARIA dialog(s) have accessible names`,
              details: { dialogsChecked: ariaDialogs.length },
            }),
      });
    }

    // Check native <dialog> — warn if unnamed (browser provides implicit role)
    const native = sortUnnamedControls<CheckItem>(nativeVisibility);
    unnamedDialogItems(
      nativeDialogs,
      (dialog) => describeDialog(dialog, "dialog", "dialog"),
      isNamed,
      native
    );
    const unnamedNative = native.failures;

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
    }
    if (native.unconfirmed.length > 0) {
      checks.push(
        unconfirmedRow(
          "dialog-name",
          "native <dialog>(s) without accessible names",
          native.unconfirmed
        )
      );
    }
    if (unnamedNative.length === 0 && native.unconfirmed.length === 0 && nativeDialogs.length > 0) {
      checks.push({
        name: "dialog-name",
        status: "pass",
        ...(native.hidden > 0
          ? {
              message: "All native <dialog>s in the accessibility tree have accessible names",
              details: { dialogsChecked: nativeDialogs.length, hiddenWithoutName: native.hidden },
            }
          : {
              message: `All ${nativeDialogs.length} native <dialog>(s) have accessible names`,
              details: { dialogsChecked: nativeDialogs.length },
            }),
      });
    }

    return { checks };
  },
};
