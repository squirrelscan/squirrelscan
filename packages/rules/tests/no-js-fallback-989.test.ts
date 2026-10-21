// pub#989: on a page whose stylesheets were not all read, a control that
// carries the `no-js` class (itself or a non-root ancestor) may be hidden by
// the theme once scripts run, so it is unconfirmed with a script-state reason,
// never decided as shown. A page whose styles are complete keeps its verdict.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { ariaInputFieldNameRule } from "../src/a11y/aria-input-field-name";
import { ariaHiddenFocusRule } from "../src/a11y/aria-hidden-focus";
import { buttonNameRule } from "../src/a11y/button-name";
import { formLabelsRule } from "../src/a11y/form-labels";
import { SCRIPT_STATE_LABEL, UNCONFIRMED_LABEL } from "../src/shared/static-hidden";
import type { ParsedPage, RuleContext } from "../src/types";

type AnyRule = { run: (ctx: RuleContext) => { checks: unknown } };

function checks(rule: AnyRule, html: string): CheckResult[] {
  const url = "https://example.com/";
  return rule.run({
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url) as ParsedPage,
    options: {},
  }).checks as CheckResult[];
}

function statuses(rule: AnyRule, html: string): Record<string, string> {
  return Object.fromEntries(checks(rule, html).map((c) => [c.name, c.status]));
}

const LINK = '<link rel="stylesheet" href="/theme.css">';
const ICON = '<style>[class^="icon-"]{display:inline-block}</style>';
const SELECT = '<form><select name="id" class="no-js"><option>Small</option></select></form>';

function page(head: string, body: string, htmlClass = "js"): string {
  return `<!doctype html><html lang="en" class="${htmlClass}"><head><title>t</title>${head}</head><body>${body}</body></html>`;
}

const RULES: Array<[string, AnyRule, string]> = [
  ["aria-input-field-name", ariaInputFieldNameRule, "aria-input-field-name"],
  ["form-labels", formLabelsRule, "form-labels"],
];

for (const [name, rule, check] of RULES) {
  describe(`${name} and a no-js fallback`, () => {
    test("A: external sheet + show-only rule: unconfirmed with the script-state reason", () => {
      const out = checks(rule, page(LINK + ICON, SELECT));
      expect(out.map((c) => [c.name, c.status])).toEqual([[`${check}-unconfirmed`, "warn"]]);
      expect(out[0]?.items?.[0]).toMatchObject({ label: SCRIPT_STATE_LABEL });
    });

    test("B: external sheet alone: unconfirmed", () => {
      expect(statuses(rule, page(LINK, SELECT))).toEqual({ [`${check}-unconfirmed`]: "warn" });
    });

    test("D: an unrendered fetch with <html class=no-js>: unconfirmed", () => {
      expect(statuses(rule, page(LINK + ICON, SELECT, "no-js"))).toEqual({
        [`${check}-unconfirmed`]: "warn",
      });
    });

    test("C: a readable .js .no-js hide stays unconfirmed (generic reason)", () => {
      const out = checks(rule, page(`${LINK}<style>.js .no-js{display:none}</style>`, SELECT));
      expect(out.map((c) => c.status)).toEqual(["warn"]);
      expect(out[0]?.items?.[0]).toMatchObject({ label: UNCONFIRMED_LABEL });
    });

    test("a non-root ancestor wrapper carries the marker", () => {
      const body =
        '<div class="variant no-js"><form><select name="id"><option>S</option></select></form></div>';
      expect(statuses(rule, page(LINK, body))).toEqual({ [`${check}-unconfirmed`]: "warn" });
    });

    test("complete styles (no external sheet): unchanged, a fail", () => {
      expect(statuses(rule, page(ICON, SELECT))).toEqual({ [check]: "fail" });
      expect(statuses(rule, page("", SELECT))).toEqual({ [check]: "fail" });
    });

    test("no marker, or a different token (no-js-hidden), keeps failing", () => {
      const plain = '<form><select name="id"><option>S</option></select></form>';
      const other =
        '<form><select name="id" class="no-js-hidden"><option>S</option></select></form>';
      expect(statuses(rule, page(LINK + ICON, plain))).toEqual({ [check]: "fail" });
      expect(statuses(rule, page(LINK + ICON, other))).toEqual({ [check]: "fail" });
    });

    test("only <html class=no-js> carries it: the root is not a marker", () => {
      expect(
        statuses(
          rule,
          page(LINK, '<form><select name="id"><option>S</option></select></form>', "no-js"),
        ),
      ).toEqual({
        [check]: "fail",
      });
    });
  });
}

describe("the other naming rules apply the same marker", () => {
  test("button-name", () => {
    const html = page(LINK, '<button class="no-js"></button>');
    const out = checks(buttonNameRule, html);
    expect(out.map((c) => c.name)).toEqual(["button-name-unconfirmed"]);
    expect(out[0]?.items?.[0]).toMatchObject({ label: SCRIPT_STATE_LABEL });
    expect(statuses(buttonNameRule, page("", '<button class="no-js"></button>'))).toEqual({
      "button-name": "fail",
    });
  });

  test("aria-hidden-focus", () => {
    const body = '<div aria-hidden="true"><a href="/x" class="no-js">x</a></div>';
    const out = checks(ariaHiddenFocusRule, page(LINK, body));
    expect(out.map((c) => c.name)).toEqual(["aria-hidden-focus-unconfirmed"]);
    expect(out[0]?.items?.[0]).toMatchObject({ label: SCRIPT_STATE_LABEL });
    expect(statuses(ariaHiddenFocusRule, page("", body))).toEqual({ "aria-hidden-focus": "fail" });
  });
});

describe("what is not a marker", () => {
  test("NO-JS is not no-js in standards mode", () => {
    expect(statuses(buttonNameRule, page(LINK, '<button class="NO-JS"></button>'))).toEqual({
      "button-name": "fail",
    });
  });

  test("a stray second <html> class is not a marker", () => {
    const html = `<!doctype html><html lang="en"><head><title>t</title>${LINK}</head><body><html class="no-js"><button></button></html></body></html>`;
    expect(statuses(buttonNameRule, html)).toEqual({ "button-name": "fail" });
  });
});
