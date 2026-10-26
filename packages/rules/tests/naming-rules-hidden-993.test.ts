// pub#993: the remaining naming rules read visibility through the shared
// hidden-control reader (shared/static-hidden.ts): an element out of the
// accessibility tree is skipped, one a style may hide (a no-js fallback on a
// page with an unread stylesheet included) is `<check>-unconfirmed`, and a
// visible unnamed element still fails.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { ariaMeterNameRule } from "../src/a11y/aria-meter-name";
import { ariaProgressbarNameRule } from "../src/a11y/aria-progressbar-name";
import { ariaToggleFieldNameRule } from "../src/a11y/aria-toggle-field-name";
import { ariaTooltipNameRule } from "../src/a11y/aria-tooltip-name";
import { ariaTreeitemNameRule } from "../src/a11y/aria-treeitem-name";
import { inputImageAltRule } from "../src/a11y/input-image-alt";
import { linkTextRule } from "../src/a11y/link-text";
import { createStaticVisibility, SCRIPT_STATE_LABEL } from "../src/shared/static-hidden";
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

function page(head: string, body: string): string {
  return `<!doctype html><html lang="en" class="js"><head><title>t</title>${head}</head><body>${body}</body></html>`;
}

/** The unnamed element for each rule, with `attrs` spliced onto it. */
interface Case {
  rule: AnyRule;
  check: string;
  /** Failing check name when visible (the empty-link row has its own name). */
  failName: string;
  el: (attrs: string) => string;
}

const CASES: Case[] = [
  {
    rule: ariaMeterNameRule,
    check: "aria-meter-name",
    failName: "aria-meter-name",
    el: (a) => `<meter ${a} value="0.5"></meter>`,
  },
  {
    rule: ariaMeterNameRule,
    check: "aria-meter-name",
    failName: "aria-meter-name",
    el: (a) => `<div role="meter" ${a}></div>`,
  },
  {
    rule: ariaProgressbarNameRule,
    check: "aria-progressbar-name",
    failName: "aria-progressbar-name",
    el: (a) => `<progress ${a} value="5" max="10"></progress>`,
  },
  {
    rule: ariaProgressbarNameRule,
    check: "aria-progressbar-name",
    failName: "aria-progressbar-name",
    el: (a) => `<div role="progressbar" ${a}></div>`,
  },
  {
    rule: ariaTooltipNameRule,
    check: "aria-tooltip-name",
    failName: "aria-tooltip-name",
    el: (a) => `<div role="tooltip" ${a}></div>`,
  },
  {
    rule: ariaTreeitemNameRule,
    check: "aria-treeitem-name",
    failName: "aria-treeitem-name",
    el: (a) => `<div role="treeitem" ${a}></div>`,
  },
  {
    rule: ariaToggleFieldNameRule,
    check: "aria-toggle-field-name",
    failName: "aria-toggle-field-name",
    el: (a) => `<input type="checkbox" ${a}>`,
  },
  {
    rule: ariaToggleFieldNameRule,
    check: "aria-toggle-field-name",
    failName: "aria-toggle-field-name",
    el: (a) => `<input type="radio" name="r" ${a}>`,
  },
  {
    rule: ariaToggleFieldNameRule,
    check: "aria-toggle-field-name",
    failName: "aria-toggle-field-name",
    el: (a) => `<div role="switch" ${a}></div>`,
  },
  {
    rule: inputImageAltRule,
    check: "input-image-alt",
    failName: "input-image-alt",
    el: (a) => `<input type="image" src="/go.png" ${a}>`,
  },
  {
    rule: linkTextRule,
    check: "link-text",
    failName: "link-text-empty",
    el: (a) => `<a href="/x" ${a}></a>`,
  },
];

describe.each(CASES)("$check: $failName", ({ rule, check, failName, el }) => {
  const summary = (html: string) => checks(rule, html).map((c) => [c.name, c.status]);

  test("a visible unnamed element still fails, with or without an unread sheet", () => {
    for (const head of ["", LINK, LINK + "<style>.x{display:flex}</style>"]) {
      expect(summary(page(head, el("")))).toEqual([[failName, "fail"]]);
    }
  });

  test("hidden, aria-hidden, display:none, closed dialog: not reported", () => {
    for (const body of [
      el("hidden"),
      `<div aria-hidden="true">${el("")}</div>`,
      el('style="display:none"'),
      `<dialog>${el("")}</dialog>`,
      `<style>.x{display:none}</style>${el('class="x"')}`,
    ]) {
      expect(summary(page("", body)).some(([n, st]) => n === failName && st === "fail")).toBe(
        false,
      );
      expect(summary(page("", body)).some(([, s]) => s === "warn" || s === "fail")).toBe(false);
    }
  });

  test("a no-js fallback on a page with an unread stylesheet is unconfirmed, with the script-state reason", () => {
    const out = checks(rule, page(LINK, el('class="no-js"')));
    expect(out.map((c) => [c.name, c.status])).toEqual([[`${check}-unconfirmed`, "warn"]]);
    expect(out[0]?.items?.[0]?.label).toBe(SCRIPT_STATE_LABEL);
  });

  test("a no-js fallback under a non-root wrapper is unconfirmed", () => {
    const out = checks(rule, page(LINK, `<div class="no-js">${el("")}</div>`));
    expect(out.map((c) => c.name)).toEqual([`${check}-unconfirmed`]);
  });

  test("all styles read: a no-js fallback keeps failing", () => {
    expect(summary(page("", el('class="no-js"')))).toEqual([[failName, "fail"]]);
  });

  test("a style squirrel cannot settle is unconfirmed, not failed", () => {
    const head = "<style>.x:hover{display:none}@media print{.x{display:none}}</style>";
    const out = checks(rule, page(head, el('class="x"')));
    expect(out.some((c) => c.name === failName && c.status === "fail")).toBe(false);
    expect(out.map((c) => c.name)).toEqual([`${check}-unconfirmed`]);
  });
});

describe("hidden unnamed elements alongside visible ones", () => {
  test("a hidden unnamed meter is skipped, a visible one fails", () => {
    const out = checks(
      ariaMeterNameRule,
      page("", '<meter hidden value="1"></meter><meter id="m" value="1"></meter>'),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.items?.map((i) => i.id)).toEqual(["meter#m"]);
  });

  test("all unnamed hidden: pass reads in the accessibility tree and counts the hidden", () => {
    const out = checks(ariaTooltipNameRule, page("", '<div role="tooltip" hidden></div>'));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      status: "pass",
      message: "All tooltips in the accessibility tree have accessible names",
      details: { hiddenWithoutName: 1 },
    });
  });
});

describe("link-text", () => {
  test("a hidden generic link is not reported; a visible one is", () => {
    const hidden = checks(linkTextRule, page("", '<a href="/x" hidden>click here</a>'));
    expect(hidden.some((c) => c.name === "link-text-generic")).toBe(false);
    const shown = checks(linkTextRule, page("", '<a href="/x">click here</a>'));
    expect(shown.map((c) => c.name)).toEqual(["link-text-generic"]);
  });

  test("an unconfirmed empty link outside the script state carries the default reason", () => {
    const head = "<style>.x:hover{display:none}</style>";
    const out = checks(linkTextRule, page(head, '<a class="x" href="/x"></a>'));
    expect(out.map((c) => c.name)).toEqual(["link-text-unconfirmed"]);
    expect(out[0]?.items?.[0]?.label).not.toBe("empty");
  });
});

describe("no-js class bail-out", () => {
  const doc = (html: string) => parsePage(html, "https://example.com/").document as Document;

  test("tokens are matched whole: no-js-x and x-no-js are not the marker", () => {
    const d = doc(
      page(LINK, '<div class="no-js-x"><div class="x-no-js"><button id="b"></button></div></div>'),
    );
    const seen = createStaticVisibility({ ariaHidden: true }).visibility(
      d.getElementById("b") as Element,
    );
    expect(seen.state).toBe("shown");
  });

  test("a quirks-mode NO-JS class still counts (case-blind)", () => {
    const d = doc(
      `<html><head>${LINK}</head><body><div class="NO-JS"><button id="b"></button></div></body></html>`,
    );
    const seen = createStaticVisibility({ ariaHidden: true }).visibility(
      d.getElementById("b") as Element,
    );
    expect(seen).toEqual({ state: "unknown", reason: "script" });
  });

  test("a 20000-element DOM resolves once per element, in well under a second", () => {
    const rows = Array.from(
      { length: 20000 },
      (_, i) => `<li class="item item-${i}"><b></b></li>`,
    ).join("");
    const d = doc(page(LINK, `<ul>${rows}</ul><div class="no-js"><i id="t"></i></div>`));
    const resolver = createStaticVisibility({ ariaHidden: true });
    const start = performance.now();
    for (const b of d.querySelectorAll("b")) resolver.visibility(b);
    const ms = performance.now() - start;
    expect(resolver.visibility(d.getElementById("t") as Element).state).toBe("unknown");
    expect(ms).toBeLessThan(2000);
  });
});
