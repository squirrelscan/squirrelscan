// a11y/aria-hidden-focus: controls hidden by markup or a plain inline style
// are not focusable, pub#664.
//
// squirrel 0.0.108 reported `1 focusable element(s) inside aria-hidden` for a
// button inside a container that is not rendered. The rule now asks the shared
// check in src/shared/static-hidden.ts, which reads markup, inline `style`
// attributes and the `<style>` rules shared/page-styles.ts can decide
// (pub#678). External stylesheets are not read.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { ariaHiddenFocusRule } from "../src/a11y/aria-hidden-focus";
import type { ParsedPage, RuleContext } from "../src/types";

function run(html: string): CheckResult[] {
  const url = "https://example.com/";
  const ctx: RuleContext = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url) as ParsedPage,
    options: {},
  };
  return ariaHiddenFocusRule.run(ctx).checks as CheckResult[];
}

function check(checks: CheckResult[], name: string): CheckResult | undefined {
  return checks.find((c) => c.name === name);
}

/** The issue's page shell, byte for byte. */
function fixture(variant: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Hidden focus fixture</title></head><body><h1>Fixture</h1>${variant}</body></html>`;
}

function statuses(html: string): Record<string, string> {
  return Object.fromEntries(run(html).map((c) => [c.name, c.status]));
}

/** The repro's six variants (pub#664). */
const VARIANTS = {
  bad: '<div aria-hidden="true"><button>Close</button></div>',
  "display-none":
    '<style>.modal{display:none}</style><div class="modal" aria-hidden="true"><button>Close</button></div>',
  hidden: '<div hidden aria-hidden="true"><button>Close</button></div>',
  "visibility-hidden":
    '<style>.modal{visibility:hidden}</style><div class="modal" aria-hidden="true"><button>Close</button></div>',
  inert: '<div inert aria-hidden="true"><button>Close</button></div>',
  disabled: '<div aria-hidden="true"><button disabled>Close</button></div>',
};

describe("a11y/aria-hidden-focus: the six repro fixtures (pub#664)", () => {
  test("bad: a visible button inside aria-hidden still fails", () => {
    expect(run(fixture(VARIANTS.bad))).toEqual([
      expect.objectContaining({
        name: "aria-hidden-focus",
        status: "fail",
        message: "1 focusable element(s) inside aria-hidden",
        items: [{ id: "button" }],
      }),
    ]);
  });

  for (const name of ["hidden", "inert", "disabled"] as const) {
    test(`${name}: passes`, () => {
      expect(statuses(fixture(VARIANTS[name]))).toEqual({ "aria-hidden-focus": "pass" });
    });
  }

  test("display-none and visibility-hidden come from a <style> block: pass (pub#678)", () => {
    for (const name of ["display-none", "visibility-hidden"] as const) {
      expect(statuses(fixture(VARIANTS[name]))).toEqual({ "aria-hidden-focus": "pass" });
    }
  });

  test("with an external stylesheet, which could show the button again: unconfirmed", () => {
    const external = '<link rel="stylesheet" href="/site.css">';
    for (const name of ["display-none", "visibility-hidden"] as const) {
      expect(statuses(fixture(external + VARIANTS[name]))).toEqual({ "aria-hidden-focus-unconfirmed": "warn" });
    }
  });

  test("written as inline styles: display:none passes, inherited visibility:hidden too unless a stylesheet could undo it", () => {
    expect(
      statuses(
        fixture('<div style="display:none" aria-hidden="true"><button>Close</button></div>'),
      ),
    ).toEqual({ "aria-hidden-focus": "pass" });
    // With every stylesheet read, inherited visibility is settled.
    expect(
      statuses(
        fixture('<div style="visibility:hidden" aria-hidden="true"><button>Close</button></div>'),
      ),
    ).toEqual({ "aria-hidden-focus": "pass" });
    // An external stylesheet could make the button visible again
    // (`button{visibility:visible}`), so then it is not settled.
    expect(
      statuses(
        fixture(
          '<link rel="stylesheet" href="/site.css"><div style="visibility:hidden" aria-hidden="true"><button>Close</button></div>',
        ),
      ),
    ).toEqual({ "aria-hidden-focus-unconfirmed": "warn" });
  });
});

describe("a11y/aria-hidden-focus: markup and inline styles", () => {
  test("a closed dialog, an ancestor with an inline display:none, or !important", () => {
    for (const variant of [
      '<dialog aria-hidden="true"><button>b</button></dialog>',
      '<div style="display:none"><div aria-hidden="true"><button>b</button></div></div>',
      '<div style="DISPLAY: NONE !important" aria-hidden="true"><a href="/x">x</a></div>',
    ]) {
      expect(statuses(fixture(variant))).toEqual({ "aria-hidden-focus": "pass" });
    }
  });

  test("a child that sets visibility:visible inside a visibility:hidden container is still focusable", () => {
    const checks = run(
      fixture(
        `<div style="visibility:hidden" aria-hidden="true"><a href="/x" id="back" style="visibility:visible">x</a></div>`,
      ),
    );
    expect(check(checks, "aria-hidden-focus")?.items).toEqual([{ id: "a#back" }]);
  });

  test("a focusable container an inline style hides still has its visible descendants checked", () => {
    const checks = run(
      fixture(
        `<div aria-hidden="true" tabindex="0" style="visibility:hidden"><button id="open" style="visibility:visible">Open</button></div>`,
      ),
    );
    expect(check(checks, "aria-hidden-focus")?.items).toEqual([{ id: "button#open" }]);
  });

  test("off-screen, transparent or clipped content is still reported", () => {
    for (const style of [
      "position:absolute;left:-9999px",
      "opacity:0",
      "width:0;height:0;overflow:hidden",
      "clip:rect(0 0 0 0);position:absolute",
    ]) {
      const checks = run(
        fixture(`<div aria-hidden="true" style="${style}"><a href="/x">x</a></div>`),
      );
      expect(check(checks, "aria-hidden-focus")?.status).toBe("fail");
    }
  });

  test("a region under the hidden attribute is skipped as before, whatever its inline style", () => {
    // The rule only ever moves a finding to pass or to unconfirmed: the plain
    // `hidden` skip it always had is not handed to the new check.
    for (const variant of [
      `<div hidden style="display:block" aria-hidden="true"><button>b</button></div>`,
      `<div hidden style="display:var(--d)" aria-hidden="true"><button>b</button></div>`,
    ]) {
      expect(statuses(fixture(variant))).toEqual({ "aria-hidden-focus": "pass" });
    }
  });
});

describe("a11y/aria-hidden-focus: inline styles the check cannot read exactly", () => {
  test("are reported as unconfirmed, not as a failure", () => {
    for (const style of [
      "display:var(--d)",
      "display:/*x*/none",
      "display:n\\6f ne",
      "all:unset",
    ]) {
      const checks = run(
        fixture(`<div style="${style}" aria-hidden="true"><a href="/x">x</a></div>`),
      );
      expect(check(checks, "aria-hidden-focus")).toBeUndefined();
      expect(check(checks, "aria-hidden-focus-unconfirmed")).toMatchObject({
        status: "warn",
        message:
          "1 focusable element(s) inside aria-hidden may be hidden by a style (unconfirmed)",
        items: [{ id: "a" }],
      });
    }
  });

  test("confirmed and unconfirmed findings are reported side by side", () => {
    const checks = run(
      fixture(
        `<div aria-hidden="true"><a href="/a" id="seen">a</a></div><div aria-hidden="true" style="display:var(--d)"><a href="/b" id="maybe">b</a></div>`,
      ),
    );
    expect(check(checks, "aria-hidden-focus")?.items).toEqual([{ id: "a#seen" }]);
    expect(check(checks, "aria-hidden-focus-unconfirmed")?.items?.map((i) => i.id)).toEqual([
      "a#maybe",
    ]);
  });
});
