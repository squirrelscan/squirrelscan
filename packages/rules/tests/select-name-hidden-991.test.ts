// pub#991: a11y/select-name reads visibility through the shared hidden-control
// reader (shared/static-hidden.ts), like form-labels and aria-input-field-name:
// a select out of the accessibility tree is skipped, and one a style may hide
// (a no-js fallback on a page with an unread stylesheet included) is
// `select-name-unconfirmed`, not a failure.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { ariaInputFieldNameRule } from "../src/a11y/aria-input-field-name";
import { formLabelsRule } from "../src/a11y/form-labels";
import { selectNameRule } from "../src/a11y/select-name";
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

const LINK = '<link rel="stylesheet" href="/site.css">';
const SELECT = '<form><select class="no-js" name="sort"><option>a</option></select></form>';

function page(head: string, body: string): string {
  return `<!doctype html><html lang="en" class="js"><head><title>t</title>${head}</head><body>${body}</body></html>`;
}

describe("select-name and hidden selects", () => {
  test("a no-js select on a page with an external stylesheet is unconfirmed, with the script-state reason", () => {
    const out = checks(selectNameRule, page(LINK, SELECT));
    expect(out.map((c) => [c.name, c.status])).toEqual([["select-name-unconfirmed", "warn"]]);
    expect(out[0]?.items?.[0]).toMatchObject({
      id: 'select[name="sort"]',
      label: SCRIPT_STATE_LABEL,
    });
  });

  test("a select under a non-root no-js wrapper is unconfirmed", () => {
    const body =
      '<div class="no-js"><form><select name="sort"><option>a</option></select></form></div>';
    expect(checks(selectNameRule, page(LINK, body)).map((c) => c.name)).toEqual([
      "select-name-unconfirmed",
    ]);
  });

  test("all styles read: a no-js select keeps failing", () => {
    expect(checks(selectNameRule, page("", SELECT)).map((c) => [c.name, c.status])).toEqual([
      ["select-name", "fail"],
    ]);
  });

  test("no marker: a visible unnamed select fails, with or without an external sheet", () => {
    const body = '<form><select name="sort"><option>a</option></select></form>';
    for (const head of ["", LINK, LINK + "<style>.x{display:flex}</style>"]) {
      expect(checks(selectNameRule, page(head, body)).map((c) => [c.name, c.status])).toEqual([
        ["select-name", "fail"],
      ]);
    }
  });

  test("hidden, aria-hidden, display:none, closed dialog: not reported", () => {
    for (const body of [
      "<select hidden><option>a</option></select>",
      '<div aria-hidden="true"><select><option>a</option></select></div>',
      '<select style="display:none"><option>a</option></select>',
      "<dialog><select><option>a</option></select></dialog>",
      '<style>.x{display:none}</style><select class="x"><option>a</option></select>',
    ]) {
      const out = checks(selectNameRule, page("", body));
      expect(out.map((c) => [c.name, c.status])).toEqual([["select-name", "pass"]]);
      expect(out[0]?.details).toMatchObject({ hiddenWithoutName: 1 });
    }
  });

  test("a style squirrel cannot settle: unconfirmed with the generic reason", () => {
    const out = checks(
      selectNameRule,
      page(
        "<style>.a .b{display:none}</style>",
        '<div class="a"><select class="b"><option>a</option></select></div>',
      ),
    );
    expect(out.map((c) => c.name)).toEqual(["select-name-unconfirmed"]);
    expect(out[0]?.items?.[0]).toMatchObject({ label: UNCONFIRMED_LABEL });
  });

  test("a named select passes and a page without selects is info", () => {
    expect(
      checks(
        selectNameRule,
        page(LINK, '<select aria-label="Sort"><option>a</option></select>'),
      ).map((c) => [c.name, c.status]),
    ).toEqual([["select-name", "pass"]]);
    expect(checks(selectNameRule, page("", "<p>x</p>")).map((c) => c.status)).toEqual(["info"]);
  });
});

describe("parity: select-name, form-labels and aria-input-field-name agree", () => {
  const fixtures: Record<string, string> = {
    "no-js + external sheet": page(LINK, SELECT),
    "no-js, styles read": page("", SELECT),
    "plain visible": page("", '<select name="s"><option>a</option></select>'),
    hidden: page("", "<select hidden><option>a</option></select>"),
    "display:none class": page(
      "<style>.x{display:none}</style>",
      '<select class="x"><option>a</option></select>',
    ),
    "undecidable rule": page(
      "<style>.a .b{display:none}</style>",
      '<div class="a"><select class="b"><option>a</option></select></div>',
    ),
    "vendor display chain": page(
      "<style>.b{display:-webkit-box;display:flex}</style>",
      '<select class="b"><option>a</option></select>',
    ),
    "operator attribute, no match": page(
      '<style>.o [id$="-drawer"]{display:none}</style>',
      '<div class="o"><select><option>a</option></select></div>',
    ),
  };
  const kind = (rule: AnyRule, html: string): string => {
    const out = checks(rule, html);
    if (out.some((c) => c.name.endsWith("-unconfirmed"))) return "unconfirmed";
    if (out.some((c) => c.status === "fail")) return "fail";
    return out[0]?.status ?? "none";
  };
  for (const [name, html] of Object.entries(fixtures)) {
    test(name, () => {
      const base = kind(selectNameRule, html);
      expect(kind(formLabelsRule, html)).toBe(base);
      expect(kind(ariaInputFieldNameRule, html)).toBe(base);
    });
  }
});
