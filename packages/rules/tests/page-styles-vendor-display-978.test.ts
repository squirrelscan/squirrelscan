// pub#978: vendor-prefixed `display` keywords (the old flexbox fallback chain)
// are shown values, not an unreadable declaration. Chromium rows for them are
// in static-hidden-chromium.json.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { ariaCommandNameRule as aria } from "../src/a11y/aria-command-name";
import { buttonNameRule } from "../src/a11y/button-name";
import { readDeclarations } from "../src/shared/page-styles";
import type { ParsedPage, RuleContext } from "../src/types";

function statuses(
  rule: { run: (ctx: RuleContext) => { checks: unknown } },
  css: string,
): Record<string, string> {
  const url = "https://example.com/";
  const html = `<!doctype html><html lang="en"><head><title>t</title><style>${css}</style></head><body><main><div class="menu"><div class="item"><button type="button"></button></div></div></main></body></html>`;
  const checks = rule.run({
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url) as ParsedPage,
    options: {},
  }).checks as CheckResult[];
  return Object.fromEntries(checks.map((c) => [c.name, c.status]));
}

const SHOWN = [
  "-webkit-box",
  "-webkit-inline-box",
  "-webkit-flex",
  "-webkit-inline-flex",
  "-ms-flexbox",
  "-ms-inline-flexbox",
  "-ms-grid",
  "-ms-inline-grid",
  "-moz-box",
  "-moz-inline-box",
];
const CHAIN = "display:-webkit-box;display:-webkit-flex;display:-ms-flexbox;display:flex";

describe("readDeclarations: vendor-prefixed display", () => {
  test("the standard-last chain reads as shown", () => {
    expect(readDeclarations(CHAIN)).toEqual({ display: { value: "shown", important: false } });
  });

  test("-webkit-* values read as shown alone", () => {
    for (const v of SHOWN.filter((x) => x.startsWith("-webkit-"))) {
      expect(readDeclarations(`display:${v}`)).toEqual({
        display: { value: "shown", important: false },
      });
    }
  });

  test("-ms-* and -moz-* alone are engine-dependent: unknown", () => {
    for (const v of SHOWN.filter((x) => !x.startsWith("-webkit-"))) {
      expect(readDeclarations(`display:${v}`)).toBe("unknown");
    }
  });

  test("an engine-dependent value after display:none is unknown, not shown", () => {
    expect(readDeclarations("display:none;display:-ms-flexbox")).toBe("unknown");
    expect(readDeclarations("display:flex;display:-moz-box")).toBe("unknown");
  });

  test("a later standard value overrides an engine-dependent one everywhere", () => {
    expect(readDeclarations("display:none;display:-ms-flexbox;display:flex")).toEqual({
      display: { value: "shown", important: false },
    });
  });

  test("display:none after the chain still hides", () => {
    expect(readDeclarations(`${CHAIN};display:none`)).toEqual({
      display: { value: "none", important: false },
    });
  });

  test("an !important engine-dependent value is not overridden by a plain one", () => {
    expect(readDeclarations("display:-ms-flexbox!important;display:flex")).toBe("unknown");
  });

  test("unreadable values stay unknown", () => {
    // `ruby-base` is a spec value Chromium drops: not settled either.
    for (const v of [
      "ruby-base",
      "-webkit-bx",
      "-webkit-",
      "-ms-flexboxx",
      "var(--x)",
      "flex flow",
      "-ms-none",
    ]) {
      expect(readDeclarations(`display:${v}`)).toBe("unknown");
    }
  });
});

describe("the issue's repro table: an unnamed button under the rule fails", () => {
  const cases: Record<string, string> = {
    standard: ".menu .item{display:flex}",
    "four-value chain": `.menu .item{${CHAIN}}`,
    "webkit fallback": ".menu .item{display:-webkit-flex;display:flex}",
    "vendor only": ".menu .item{display:-webkit-inline-box}",
    "plain selector": ".item{display:-webkit-box;display:flex}",
  };
  for (const [name, css] of Object.entries(cases)) {
    test(name, () => {
      expect(statuses(buttonNameRule, css)).toEqual({ "button-name": "fail" });
      expect(statuses(aria, css)).toEqual({ "aria-command-name": "fail" });
    });
  }

  test("var(--x) stays unconfirmed", () => {
    expect(statuses(buttonNameRule, ".menu .item{display:var(--x)}")).toEqual({
      "button-name-unconfirmed": "warn",
    });
  });

  test("display:none last in a vendor chain still hides, or stays unconfirmed", () => {
    expect(statuses(buttonNameRule, ".item{display:-webkit-box;display:none}")).toEqual({
      "button-name": "pass",
    });
    expect(statuses(buttonNameRule, ".menu .item{display:-webkit-box;display:none}")).toEqual({
      "button-name-unconfirmed": "warn",
    });
  });
});
