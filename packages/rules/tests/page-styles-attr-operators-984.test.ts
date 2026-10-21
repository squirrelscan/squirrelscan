// pub#984: an attribute selector with an operator (`^=`, `$=`, `*=`, `~=`,
// `|=`) keeps its attribute in the rule's subject, so it reaches only elements
// that have the attribute (and a value that could satisfy it), not every
// element. Chromium verdicts for the shapes are rows in
// static-hidden-chromium.json.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { ariaCommandNameRule } from "../src/a11y/aria-command-name";
import { formLabelsRule } from "../src/a11y/form-labels";
import { parseSelector } from "../src/shared/page-styles";
import { createStaticVisibility } from "../src/shared/static-hidden";
import type { ParsedPage, RuleContext } from "../src/types";

const BODY =
  '<div class="nav"><button type="button"></button></div><form><input type="text" id="q"></form>';

function statuses(
  rule: { run: (ctx: RuleContext) => { checks: unknown } },
  css: string,
): Record<string, string> {
  const url = "https://example.com/";
  const html = `<!doctype html><html lang="en"><head><title>t</title><style>${css}</style></head><body><main>${BODY}</main></body></html>`;
  const checks = rule.run({
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url) as ParsedPage,
    options: {},
  }).checks as CheckResult[];
  return Object.fromEntries(checks.map((c) => [c.name, c.status]));
}

function state(css: string, el: string): string {
  const { document } = parsePage(
    `<!doctype html><html><head><style>${css}</style></head><body><div class="o">${el}</div></body></html>`,
    "https://example.com/",
  ) as unknown as { document: Document };
  return createStaticVisibility({ ariaHidden: true }).visibility(
    document.getElementById("t") as Element,
  ).state;
}

describe("parseSelector keeps an operator attribute in the subject", () => {
  const cases: Array<[string, string, string | undefined]> = [
    ['[id$="-x"]', "id", "$="],
    ['[href^="#"]', "href", "^="],
    ['[data-a*="b"]', "data-a", "*="],
    ['[class~="a"]', "class", "~="],
    ['[lang|="en"]', "lang", "|="],
    ["[lang|=en i]", "lang", "|="],
    ["[DATA-A$='x' s]", "data-a", "$="],
  ];
  for (const [sel, name, op] of cases) {
    test(sel, () => {
      const parsed = parseSelector(sel);
      expect(parsed).toMatchObject({ kind: "complex" });
      const subject = (parsed as { subject: { attrs: Array<{ name: string; op?: string }> } })
        .subject;
      expect(subject.attrs).toEqual([expect.objectContaining({ name, op })]);
    });
  }

  test("an unread value form still requires the attribute", () => {
    expect(parseSelector('[data-a="\\\\"]')).toMatchObject({
      kind: "complex",
      subject: { attrs: [{ name: "data-a" }] },
    });
    expect(parseSelector("[data-a=1]")).toMatchObject({ subject: { attrs: [{ name: "data-a" }] } });
  });

  test("a namespaced or escaped name narrows nothing", () => {
    expect(parseSelector("[ns|a]")).toMatchObject({ subject: { attrs: [] } });
    expect(parseSelector("[*|a]")).toMatchObject({ subject: { attrs: [] } });
  });
});

describe("the issue's repro table: nothing on the page can match", () => {
  for (const css of [
    '.is-open [id="drawer"]{display:none !important}',
    '.is-open [id$="-drawer"]{display:none !important}',
    '.is-open [href^="#modal"]{display:none !important}',
    '.is-open [data-state*="closed"]{display:none !important}',
    '.is-open [class~="gone"]{display:none !important}',
    '.is-open [lang|="fr"]{display:none !important}',
    '[id$="-drawer"]{display:none}',
  ]) {
    test(css, () => {
      expect(statuses(ariaCommandNameRule, css)).toEqual({ "aria-command-name": "fail" });
      expect(statuses(formLabelsRule, css)).toEqual({ "form-labels": "fail" });
    });
  }

  test("the combined selector list with a plain id part", () => {
    expect(
      statuses(
        ariaCommandNameRule,
        '.is-x #drawer, .is-x [id$="-drawer"]{display:none !important}',
      ),
    ).toEqual({ "aria-command-name": "fail" });
  });
});

describe("an element the operator could match stays unknown", () => {
  const cases: Record<string, [string, string]> = {
    "$=": ['.o [data-a$="-drawer"]{display:none}', 'data-a="cart-drawer"'],
    "^=": ['.o [data-a^="#modal"]{display:none}', 'data-a="#modal-1"'],
    "*=": ['.o [data-a*="closed"]{display:none}', 'data-a="is-closed-x"'],
    "~=": ['.o [data-a~="b"]{display:none}', 'data-a="a b c"'],
    "|=": ['.o [data-a|="en"]{display:none}', 'data-a="en-US"'],
    "i flag": ['.o [data-a$="DRAWER" i]{display:none}', 'data-a="cart-drawer"'],
    "plain =": ['.o [data-a="drawer"]{display:none}', 'data-a="drawer"'],
    "case-insensitive value": ['.o [data-a$="DRAWER"]{display:none}', 'data-a="cart-drawer"'],
  };
  for (const [name, [css, attrs]] of Object.entries(cases)) {
    test(name, () => expect(state(css, `<b id="t" ${attrs}></b>`)).toBe("unknown"));
  }
});

describe("an element whose value cannot satisfy the operator is shown", () => {
  const cases: Record<string, [string, string]> = {
    "$=": ['.o [data-a$="-drawer"]{display:none}', 'data-a="cart"'],
    "^=": ['.o [data-a^="#modal"]{display:none}', 'data-a="x#modal"'],
    "*=": ['.o [data-a*="closed"]{display:none}', 'data-a="open"'],
    "~= a substring": ['.o [data-a~="b"]{display:none}', 'data-a="ab c"'],
    "|= a longer word": ['.o [data-a|="en"]{display:none}', 'data-a="eng"'],
    "empty ^=": ['.o [data-a^=""]{display:none}', 'data-a="x"'],
    "plain =": ['.o [data-a="drawer"]{display:none}', 'data-a="other"'],
    "no attribute": ['.o [data-a$="x"]{display:none}', ""],
  };
  for (const [name, [css, attrs]] of Object.entries(cases)) {
    test(name, () => expect(state(css, `<b id="t" ${attrs}></b>`)).toBe("shown"));
  }
});

describe("edge shapes where this DOM differs from a browser's", () => {
  test("aK and ak are separate attributes: either may satisfy the test", () => {
    expect(state('[ak$="x"]{display:none}', '<b id="t" aK="z" ak="x"></b>')).toBe("unknown");
  });

  test("a NUL in the value is U+FFFD in a browser: not ruled out", () => {
    expect(state('[data-a$="\ufffd"]{display:none}', '<b id="t" data-a="\u0000"></b>')).toBe(
      "unknown",
    );
  });
});
