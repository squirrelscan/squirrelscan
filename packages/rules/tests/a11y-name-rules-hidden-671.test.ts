// pub#671: five accessible-name rules skip controls out of the accessibility
// tree, the way a11y/button-name does since pub#665.
//
// squirrel 0.0.108 reported unnamed dialogs, commands, input fields, buttons
// and form fields inside `hidden`, `aria-hidden="true"` and CSS-hidden
// ancestors. None of them is in the accessibility tree, so the naming rules do
// not apply to them while hidden (WAI-ARIA 1.2 tree exclusion). Each rule now
// asks the shared check in src/shared/static-hidden.ts, which reads markup and
// inline `style` attributes only: hiding by a `<style>` block is not read yet
// (pub#678), so those fixtures still fail.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { ariaCommandNameRule } from "../src/a11y/aria-command-name";
import { ariaDialogNameRule } from "../src/a11y/aria-dialog-name";
import { ariaInputFieldNameRule } from "../src/a11y/aria-input-field-name";
import { ariaLabelsRule } from "../src/a11y/aria-labels";
import { formLabelsRule } from "../src/a11y/form-labels";
import type { ParsedPage, Rule, RuleContext } from "../src/types";

function run(rule: Rule, body: string): CheckResult[] {
  const url = "https://example.com/";
  // The issue's page shell.
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Applicability fixture</title></head><body><main><h1>Applicability fixture</h1>${body}</main></body></html>`;
  const ctx: RuleContext = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url) as ParsedPage,
    options: {},
  };
  return rule.run(ctx).checks as CheckResult[];
}

const statuses = (rule: Rule, body: string): Record<string, string> =>
  Object.fromEntries(run(rule, body).map((c) => [c.name, c.status]));

/** The issue's fixtures (pub#671). */
const BAD =
  '<div role="dialog">Dialog body</div><span role="button" tabindex="0"></span><div role="textbox" tabindex="0"></div><input type="text"><button></button>';
const NAMED =
  '<div role="dialog" aria-label="Example dialog">Dialog body</div><span role="button" tabindex="0" aria-label="Example command"></span><div role="textbox" tabindex="0" aria-label="Example textbox"></div><input type="text" aria-label="Example input"><button aria-label="Example button"></button>';

/** Each rule, the check its failure is filed under, and its unconfirmed check. */
const RULES: Array<{ rule: Rule; check: string }> = [
  { rule: ariaDialogNameRule, check: "aria-dialog-name" },
  { rule: ariaCommandNameRule, check: "aria-command-name" },
  { rule: ariaInputFieldNameRule, check: "aria-input-field-name" },
  { rule: ariaLabelsRule, check: "aria-buttons" },
  { rule: formLabelsRule, check: "form-labels" },
];

for (const { rule, check } of RULES) {
  describe(`${rule.meta.id}: controls out of the accessibility tree (pub#671)`, () => {
    test("bad: a visible unnamed control still fails", () => {
      expect(statuses(rule, BAD)[check]).toBe("fail");
    });

    test("named: the named variant passes", () => {
      expect(statuses(rule, NAMED)[check]).toBe("pass");
    });

    for (const [name, body] of [
      ["the hidden attribute", `<div hidden>${BAD}</div>`],
      ['aria-hidden="true"', `<div aria-hidden="true">${BAD}</div>`],
      ["an inline display:none", `<div style="display:none">${BAD}</div>`],
    ] as const) {
      test(`${name} on an ancestor: not reported`, () => {
        const result = statuses(rule, body);
        expect(Object.values(result)).not.toContain("fail");
        expect(Object.values(result)).not.toContain("warn");
        expect(result[check]).toBe("pass");
      });
    }

    test("an inline visibility:hidden ancestor, or an inline style it cannot read: unconfirmed, not a failure", () => {
      for (const body of [
        `<div style="visibility:hidden">${BAD}</div>`,
        `<div style="display:var(--d)">${BAD}</div>`,
      ]) {
        expect(statuses(rule, body)).toEqual({ [`${check}-unconfirmed`]: "warn" });
      }
    });

    test("hiding by a <style> block is not read yet (pub#678): still fails", () => {
      expect(
        statuses(rule, `<style>.closed{display:none}</style><div class="closed">${BAD}</div>`)[check],
      ).toBe("fail");
    });

    test("off-screen and transparent controls are not treated as hidden", () => {
      for (const style of ["position:absolute;left:-9999px", "opacity:0"]) {
        expect(statuses(rule, `<div style="${style}">${BAD}</div>`)[check]).toBe("fail");
      }
    });
  });
}

describe("details and messages", () => {
  test("a hidden unnamed control is counted, and the pass says it covers the accessibility tree", () => {
    const [checked] = run(ariaInputFieldNameRule, `<div hidden><input type="text"></div>`);
    expect(checked).toMatchObject({
      name: "aria-input-field-name",
      status: "pass",
      message: "All input fields in the accessibility tree have accessible names",
      details: { hiddenWithoutName: 1 },
    });
  });

  test("a hidden and a visible unnamed field: only the visible one fails", () => {
    expect(
      run(formLabelsRule, '<div hidden><input name="zoom"></div><input name="email">'),
    ).toEqual([expect.objectContaining({ status: "fail", items: [{ id: "email" }] })]);
  });

  test("unconfirmed items say why", () => {
    const rows = run(ariaCommandNameRule, '<div style="display:var(--d)"><button class="zoom-in"></button></div>');
    expect(rows).toEqual([
      expect.objectContaining({
        name: "aria-command-name-unconfirmed",
        status: "warn",
        message:
          "1 command element(s) without accessible names may be hidden by an inline style (unconfirmed)",
        items: [expect.objectContaining({ id: 'button[type="submit"]' })],
      }),
    ]);
  });
});

describe("a11y/aria-dialog-name: the reporter's closed modal (pub#671)", () => {
  test("a role=dialog modal marked aria-hidden while closed is not reported", () => {
    const modal =
      '<div class="modal fade" id="configurator-modal" role="dialog" aria-modal="true" aria-hidden="true" aria-labelledby="configurator-modal-title"><div class="modal-dialog"><div class="modal-content"></div></div></div>';
    expect(statuses(ariaDialogNameRule, modal)).toEqual({ "aria-dialog-name": "pass" });
  });

  test("a native <dialog> is checked closed or open, since script opens it; hidden another way it is out", () => {
    for (const body of ["<dialog>Body</dialog>", "<dialog open>Body</dialog>"]) {
      expect(statuses(ariaDialogNameRule, body)).toEqual({ "dialog-name": "warn" });
    }
    for (const body of [
      "<div hidden><dialog>Body</dialog></div>",
      '<dialog aria-hidden="true">Body</dialog>',
      '<dialog style="display:none">Body</dialog>',
      // A role=dialog inside a closed native dialog is out of the tree.
      '<dialog aria-label="Shell"><div role="dialog">Body</div></dialog>',
    ]) {
      const result = statuses(ariaDialogNameRule, body);
      expect(Object.values(result)).not.toContain("fail");
      expect(Object.values(result)).not.toContain("warn");
    }
  });

  test("a native <dialog> with an explicit dialog role is checked closed too, on the ARIA path", () => {
    expect(statuses(ariaDialogNameRule, '<dialog role="dialog">Body</dialog>')).toEqual({
      "aria-dialog-name": "fail",
    });
    expect(statuses(ariaDialogNameRule, '<div hidden><dialog role="dialog">Body</dialog></div>')).toEqual({
      "aria-dialog-name": "pass",
    });
  });

  test("an item keeps its ordinal id when an earlier same-named dialog is hidden", () => {
    const rows = run(
      ariaDialogNameRule,
      '<div role="dialog" class="drawer" hidden></div><div role="dialog" class="drawer"></div>',
    );
    expect(rows).toEqual([
      expect.objectContaining({
        name: "aria-dialog-name",
        status: "fail",
        items: [expect.objectContaining({ id: 'div[role="dialog"].drawer (2)' })],
      }),
    ]);
  });
});
