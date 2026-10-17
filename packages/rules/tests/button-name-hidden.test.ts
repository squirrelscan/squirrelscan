// a11y/button-name: buttons hidden by markup or a plain inline style are out
// of the accessibility tree, pub#665.
//
// squirrel 0.0.108 reported `Buttons without accessible names` for empty
// buttons inside hidden ancestors. None of them is in the accessibility tree,
// so the rule does not apply (W3C ACT 97a4e1, Inapplicable Example 2). The
// rule now asks the shared check in src/shared/static-hidden.ts, which reads
// markup and inline `style` attributes only. The issue's `css` fixture hides
// with a `<style>` block, which is not read, so it still fails (a follow-up).

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { buttonNameRule } from "../src/a11y/button-name";
import type { ParsedPage, RuleContext } from "../src/types";

function run(html: string): CheckResult[] {
  const url = "https://example.com/";
  const ctx: RuleContext = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url) as ParsedPage,
    options: {},
  };
  return buttonNameRule.run(ctx).checks as CheckResult[];
}

/** The issue's page shell, byte for byte. */
function fixture(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Button name control</title></head><body><main>${body}</main></body></html>`;
}

function statuses(html: string): Record<string, string> {
  return Object.fromEntries(run(html).map((c) => [c.name, c.status]));
}

/** The repro's six cases (pub#665). */
const CASES = {
  bad: "<button></button>",
  title: '<button title="Zoom in"></button>',
  named: '<button aria-label="Zoom in"></button>',
  css: '<style>.closed{display:none}</style><div class="closed"><button></button></div>',
  hidden: "<div hidden><button></button></div>",
  aria: '<div aria-hidden="true"><button></button></div>',
};

describe("a11y/button-name: the six repro fixtures (pub#665)", () => {
  test("bad: a visible unnamed button still fails", () => {
    expect(run(fixture(CASES.bad))).toEqual([
      expect.objectContaining({
        name: "button-name",
        status: "fail",
        message: "Buttons without accessible names",
        items: [{ id: "button" }],
      }),
    ]);
  });

  for (const name of ["title", "named"] as const) {
    test(`${name}: a named button passes`, () => {
      expect(run(fixture(CASES[name]))).toEqual([
        expect.objectContaining({
          status: "pass",
          message: "All buttons have accessible names",
          details: { buttonsChecked: 1 },
        }),
      ]);
    });
  }

  for (const name of ["hidden", "aria"] as const) {
    test(`${name}: an unnamed button in a hidden ancestor is not reported`, () => {
      expect(run(fixture(CASES[name]))).toEqual([
        expect.objectContaining({
          status: "pass",
          message: "All buttons in the accessibility tree have accessible names",
          details: { buttonsChecked: 1, hiddenWithoutName: 1 },
        }),
      ]);
    });
  }

  test("css hides with a <style> block: not reported (pub#678)", () => {
    expect(statuses(fixture(CASES.css))).toEqual({ "button-name": "pass" });
    // The same hiding written inline is read.
    expect(statuses(fixture('<div style="display:none"><button></button></div>'))).toEqual({
      "button-name": "pass",
    });
  });
});

describe("a11y/button-name: what counts as hidden", () => {
  test("an inline display:none on the button or an ancestor, or visibility:hidden on the button", () => {
    for (const body of [
      '<div style="display:none"><span><button></button></span></div>',
      '<button style="display: none"></button>',
      '<input type="submit" value="" style="visibility:collapse">',
    ]) {
      expect(statuses(fixture(body))).toEqual({ "button-name": "pass" });
    }
    // Inherited visibility is settled when the page loads no stylesheet this
    // check does not read; with one, an external rule could undo it.
    expect(statuses(fixture('<div style="visibility:hidden"><button></button></div>'))).toEqual({
      "button-name": "pass",
    });
    expect(
      statuses(fixture('<link rel="stylesheet" href="/site.css"><div style="visibility:hidden"><button></button></div>')),
    ).toEqual({ "button-name-unconfirmed": "warn" });
  });

  test("off-screen, transparent, sr-only and disabled buttons are not treated as hidden", () => {
    for (const body of [
      // The hidden attribute and popover rules are HTML-only: an SVG button stays rendered.
      '<svg role="button" hidden width="9" height="9"></svg>',
      '<svg><g role="button" popover></g></svg>',
      '<button style="position:absolute;left:-9999px"></button>',
      '<button style="opacity:0"></button>',
      '<button class="sr-only" style="position:absolute;width:1px;height:1px;overflow:hidden"></button>',
      "<button disabled></button>",
      '<input type="button" disabled>',
    ]) {
      expect(statuses(fixture(body))).toEqual({ "button-name": "fail" });
    }
  });

  test("a hidden and a visible unnamed button: only the visible one fails", () => {
    expect(
      run(fixture('<div hidden><button id="zoom-in"></button></div><button id="cart"></button>')),
    ).toEqual([expect.objectContaining({ status: "fail", items: [{ id: "button#cart" }] })]);
  });
});

describe("a11y/button-name: inline styles the check cannot read exactly", () => {
  test("are reported as unconfirmed, not as a failure", () => {
    expect(
      run(fixture('<div style="display:var(--d)"><button class="zoom-in"></button></div>')),
    ).toEqual([
      expect.objectContaining({
        name: "button-name-unconfirmed",
        status: "warn",
        message:
          "1 button(s) without accessible names may be hidden by a style (unconfirmed)",
        items: [expect.objectContaining({ id: "button.zoom-in" })],
      }),
    ]);
  });
});
