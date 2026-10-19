// pub#938: since pub#921 the hidden-control rules read the page's `<style>`
// blocks. A `:root` block of custom properties whose names or values mention
// `display` (`--font-display: swap`, WordPress's "Display" typography preset)
// beside a `calc()` or `var()` made every element "unknown", so every unnamed
// control went from its fail to `<check>-unconfirmed`. And a `<style>` rule
// that shows a `hidden` control overrode the `[hidden] { display: none
// !important }` an external stylesheet may hold, turning a skip into a fail.
//
// The issue's repro, the github.blog global styles shape (synthetic), and the
// Bootstrap `[hidden]` case, through each rule that reads hidden controls.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { ariaCommandNameRule } from "../src/a11y/aria-command-name";
import { ariaDialogNameRule } from "../src/a11y/aria-dialog-name";
import { ariaHiddenFocusRule } from "../src/a11y/aria-hidden-focus";
import { ariaInputFieldNameRule } from "../src/a11y/aria-input-field-name";
import { ariaLabelsRule } from "../src/a11y/aria-labels";
import { buttonNameRule } from "../src/a11y/button-name";
import { formLabelsRule } from "../src/a11y/form-labels";
import type { ParsedPage, Rule, RuleContext } from "../src/types";

function statuses(rule: Rule, head: string, body: string): Record<string, string> {
  const url = "https://example.com/";
  const html = `<!doctype html><html lang="en"><head><title>t</title>${head}</head><body><main>${body}</main></body></html>`;
  const ctx: RuleContext = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url) as ParsedPage,
    options: {},
  };
  const checks = rule.run(ctx).checks as CheckResult[];
  return Object.fromEntries(checks.map((c) => [c.name, c.status]));
}

/** The issue's repro head. */
const TOKENS = "<style>:root { --font-display: swap; --gap: calc(1rem + 2px) }</style>";

/** The WordPress global styles block github.blog serves, cut down, plus its theme sheet. */
const WORDPRESS =
  '<link rel="stylesheet" href="/wp-content/themes/github/style.css">' +
  '<style id="global-styles-inline-css">:root{--wp--preset--color--black: #000000;' +
  '--wp--preset--font-family--display: "Mona Sans", sans-serif;' +
  "--wp--custom--typography--presets--6--name: Display;" +
  "--wp--custom--typography--presets--6--size: clamp(2.5rem, 5vw, 4rem);" +
  "--font: var(--text-display-shorthand);--wp--style--global--content-size: 768px;}" +
  ".has-display-font-family{font-family: var(--wp--preset--font-family--display) !important;}</style>";

/** Rule, the check it fails, and a control it reports unnamed. */
const CASES: Array<[Rule, string, string]> = [
  [buttonNameRule, "button-name", '<button class="x"></button>'],
  [ariaLabelsRule, "aria-buttons", '<button class="x"></button>'],
  [ariaCommandNameRule, "aria-command-name", '<span role="button" tabindex="0"></span>'],
  [ariaInputFieldNameRule, "aria-input-field-name", '<div role="textbox"></div>'],
  [formLabelsRule, "form-labels", '<input type="text" name="q">'],
  [ariaDialogNameRule, "aria-dialog-name", '<div role="dialog"><p>x</p></div>'],
  [ariaHiddenFocusRule, "aria-hidden-focus", '<div aria-hidden="true"><button>x</button></div>'],
];

describe("a :root block of custom properties leaves unnamed controls failing (pub#938)", () => {
  for (const [rule, check, control] of CASES) {
    test(`${rule.meta.id} ${check}: the issue's repro fails, not unconfirmed`, () => {
      const seen = statuses(rule, TOKENS, control);
      expect(seen[check]).toBe("fail");
      expect(seen[`${check}-unconfirmed`]).toBeUndefined();
    });

    test(`${rule.meta.id} ${check}: the WordPress global styles shape fails, not unconfirmed`, () => {
      const seen = statuses(rule, WORDPRESS, control);
      expect(seen[check]).toBe("fail");
      expect(seen[`${check}-unconfirmed`]).toBeUndefined();
    });
  }

  test("a control a <style> rule really hides is still unconfirmed beside the tokens", () => {
    const head = `${WORDPRESS}<style>.drawer{display:none}</style>`;
    const seen = statuses(buttonNameRule, head, '<div class="drawer"><button></button></div>');
    expect(seen["button-name-unconfirmed"]).toBe("warn");
    expect(seen["button-name"]).not.toBe("fail");
  });
});

describe("a <style> show over a hidden control with an unread stylesheet (pub#938)", () => {
  const bootstrap = '<link rel="stylesheet" href="/bootstrap.css">';
  const show = "<style>button{display:inline-flex}</style>";

  test("button-name: unconfirmed, not a fail", () => {
    const seen = statuses(buttonNameRule, `${bootstrap}${show}`, "<button hidden></button>");
    expect(seen["button-name-unconfirmed"]).toBe("warn");
    expect(seen["button-name"]).not.toBe("fail");
  });

  test("button-name: with no external sheet the show is settled, and the button fails", () => {
    const seen = statuses(buttonNameRule, show, "<button hidden></button>");
    expect(seen["button-name"]).toBe("fail");
  });

  test("button-name: an inline !important show is settled whatever the sheets hold", () => {
    const body = '<button hidden style="display:inline-flex !important"></button>';
    expect(statuses(buttonNameRule, bootstrap, body)["button-name"]).toBe("fail");
  });

  test("button-name: a button in a closed dialog a <style> rule shows is unconfirmed", () => {
    const show = "<style>dialog{display:block}</style>";
    const body = "<dialog><button></button></dialog>";
    const seen = statuses(buttonNameRule, `${bootstrap}${show}`, body);
    expect(seen["button-name-unconfirmed"]).toBe("warn");
    expect(seen["button-name"]).not.toBe("fail");
    expect(statuses(buttonNameRule, show, body)["button-name"]).toBe("fail");
  });
});
