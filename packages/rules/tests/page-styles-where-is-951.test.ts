// pub#951: a functional pseudo-class (`:where()`, `:is()`, `:has()`) only
// narrows a compound, so a rule such as Tailwind v4's preflight
// `[hidden]:where(:not([hidden="until-found"]))` reaches elements with the
// `hidden` attribute only, not every element on the page.

import type { CheckResult } from "@squirrelscan/core-contracts";

import { parsePage } from "@squirrelscan/parser";
import { describe, expect, test } from "bun:test";

import type { ParsedPage, RuleContext } from "../src/types";

import { buttonNameRule } from "../src/a11y/button-name";
import { parseSelector } from "../src/shared/page-styles";

function statuses(html: string): Record<string, string> {
  const url = "https://example.com/";
  const ctx: RuleContext = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url) as ParsedPage,
    options: {},
  };
  const checks = buttonNameRule.run(ctx).checks as CheckResult[];
  return Object.fromEntries(checks.map((c) => [c.name, c.status]));
}

function page(style: string, body: string): string {
  return `<!doctype html><html lang="en"><head><title>t</title><style>${style}</style></head><body><main>${body}</main></body></html>`;
}

const PREFLIGHT = '[hidden]:where(:not([hidden="until-found"])) { display: none !important }';

describe("parseSelector: functional pseudo-classes narrow the subject", () => {
  test("[hidden]:where(...) keeps its attribute test", () => {
    const parsed = parseSelector('[hidden]:where(:not([hidden="until-found"]))');
    expect(parsed).toEqual({
      kind: "complex",
      subject: {
        tag: null,
        id: null,
        classes: [],
        attrs: [{ name: "hidden", value: null }],
      },
    });
  });

  test("class, id and tag parts are kept beside :is() and :has()", () => {
    expect(parseSelector("div.a:is(.b, .c)")).toMatchObject({
      subject: { tag: "div", classes: ["a"] },
    });
    expect(parseSelector("#x:has(> img)")).toMatchObject({
      subject: { id: "x" },
    });
    expect(parseSelector("li:nth-child(2n)")).toMatchObject({
      subject: { tag: "li" },
    });
  });

  test("a bare :where() or :is() could match any element", () => {
    for (const sel of [":where(.a)", ":is(.a, .b)", "p :where(.a)", ":has(img)"]) {
      const parsed = parseSelector(sel);
      expect(parsed).toMatchObject({ kind: "complex" });
      const subject = (parsed as { subject: unknown }).subject as Record<string, unknown> | null;
      expect(subject === null || (subject.tag === null && subject.id === null)).toBe(true);
      if (subject) {
        expect(subject.classes).toEqual([]);
        expect(subject.attrs).toEqual([]);
      }
    }
  });
});

describe("a11y/button-name with Tailwind v4's preflight inlined (pub#951)", () => {
  test("a visible unnamed button fails, not unconfirmed", () => {
    expect(statuses(page(PREFLIGHT, '<button class="y"></button>'))).toEqual({
      "button-name": "fail",
    });
  });

  // The rule is undecidable for an element it can reach, so a button carrying
  // `hidden` stays unconfirmed (as before), never a failure.
  test("a button with the hidden attribute is never a failure", () => {
    expect(statuses(page(PREFLIGHT, "<button hidden></button>"))).toEqual({
      "button-name-unconfirmed": "warn",
    });
  });

  test("a button inside a hidden ancestor is never a failure", () => {
    expect(statuses(page(PREFLIGHT, "<div hidden><button></button></div>"))).toEqual({
      "button-name-unconfirmed": "warn",
    });
  });

  test("a bare :where() rule that can hide keeps every button unconfirmed", () => {
    expect(
      statuses(page(":where(.a, .b) { display: none }", '<button class="y"></button>')),
    ).toEqual({ "button-name-unconfirmed": "warn" });
  });

  test("a hiding rule narrowed to a class leaves other buttons failing", () => {
    expect(
      statuses(page("button.x:where(.open) { display: none }", '<button class="y"></button>')),
    ).toEqual({ "button-name": "fail" });
  });

  test("the same narrowed rule still makes a button it could reach unconfirmed", () => {
    expect(
      statuses(page("button.x:where(.open) { display: none }", '<button class="x"></button>')),
    ).toEqual({ "button-name-unconfirmed": "warn" });
  });
});

describe("parseSelector: a CRLF ends a hex escape as one whitespace", () => {
  test(".\\61\r\nb:is(*) is the class ab", () => {
    expect(parseSelector(".\\61\r\nb:is(*)")).toMatchObject({
      kind: "complex",
      subject: { tag: null, classes: ["ab"] },
    });
  });
});
