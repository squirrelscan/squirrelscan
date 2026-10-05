// a11y/aria-hidden-focus — what counts as focusable, pub#456.
//
// A form builder's honeypot (tabindex="-1" inputs inside an aria-hidden, inert
// container) was reported as "2 focusable element(s) inside aria-hidden" on 135
// URLs of one site. Neither input can be reached with Tab: the negative tabindex
// takes each out of the tab order and `inert` takes the whole subtree out of
// focus. axe-core passes the markup. The rule now counts an element as focusable
// only when it is not a disabled form control, has no negative tabindex and has
// no inert (or hidden) ancestor, while a link or button a keyboard user can
// still reach keeps failing.

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

function body(inner: string): string {
  return `<!doctype html><html lang="en"><body><main>${inner}</main></body></html>`;
}

/** Item ids of the error check, or [] when it did not fail. */
function failingItems(html: string): string[] {
  const fail = check(run(html), "aria-hidden-focus");
  if (fail?.status !== "fail") return [];
  return (fail.items ?? []).map((i) => i.id);
}

describe("a11y/aria-hidden-focus — focusability (pub#456)", () => {
  test("the issue's repro page: tabindex=-1 honeypot inside an inert aria-hidden container passes", () => {
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>aria-hidden-focus inert repro page</title><meta name="description" content="Minimal repro: honeypot inputs with tabindex=-1 inside an inert aria-hidden container."></head><body><main><h1>Repro</h1>
<form><label>Email <input type="email" name="email"></label>
<div aria-hidden="true" inert role="presentation" class="honform"><input id="honey-name-field" name="hn" tabindex="-1" autocomplete="off"><input id="honey-mail-field" name="hm" tabindex="-1" autocomplete="off"></div>
<button type="submit">Send</button></form></main></body></html>`;
    const checks = run(html);

    expect(checks).toHaveLength(1);
    expect(checks[0]?.name).toBe("aria-hidden-focus");
    expect(checks[0]?.status).toBe("pass");
  });

  test("a focusable link and button inside aria-hidden (no inert) still fail", () => {
    expect(
      failingItems(
        body(
          `<div aria-hidden="true"><a href="/promo" id="promo">Promo</a><button id="go">Go</button></div>`,
        ),
      ),
    ).toEqual(["a#promo", "button#go"]);
  });

  test("a negative tabindex alone takes an element out of the tab order", () => {
    for (const tabindex of ["-1", "-2", " -1", "-1abc"]) {
      expect(
        failingItems(
          body(`<div aria-hidden="true"><a href="/x" tabindex="${tabindex}">x</a></div>`),
        ),
      ).toEqual([]);
    }
  });

  test("React's camelCase tabIndex=-1 is read too", () => {
    expect(
      failingItems(body(`<div aria-hidden="true"><input name="q" tabIndex="-1"></div>`)),
    ).toEqual([]);
  });

  test("tabindex of 0 or more still makes an element focusable, an unparseable one is ignored", () => {
    expect(
      failingItems(
        body(`<div aria-hidden="true">
          <div id="zero" tabindex="0">a</div>
          <span id="plus" tabindex="+2">b</span>
          <div id="junk" tabindex="abc">c</div>
          <a href="/y" id="junk-link" tabindex="abc">d</a>
        </div>`),
      ),
    ).toEqual(["div#zero", "span#plus", "a#junk-link"]);
  });

  test("inert on the aria-hidden container hides even natively focusable content", () => {
    expect(
      failingItems(
        body(`<div aria-hidden="true" inert><a href="/x">x</a><button>b</button></div>`),
      ),
    ).toEqual([]);
  });

  test("inert on an ancestor of the container, or on a wrapper inside it, counts", () => {
    expect(
      failingItems(
        body(`<section inert><div aria-hidden="true"><a href="/x">x</a></div></section>`),
      ),
    ).toEqual([]);
    expect(
      failingItems(
        body(
          `<div aria-hidden="true"><div inert><a href="/x">x</a></div><a href="/y" id="live">y</a></div>`,
        ),
      ),
    ).toEqual(["a#live"]);
  });

  test("an inert attribute in uppercase is still read", () => {
    expect(failingItems(body(`<div aria-hidden="true" INERT><a href="/x">x</a></div>`))).toEqual(
      [],
    );
  });

  test("the hidden attribute removes a subtree from focus, hidden=until-found does not", () => {
    expect(failingItems(body(`<div aria-hidden="true" hidden><a href="/x">x</a></div>`))).toEqual(
      [],
    );
    expect(
      failingItems(
        body(`<div aria-hidden="true" hidden="until-found"><a href="/x" id="found">x</a></div>`),
      ),
    ).toEqual(["a#found"]);
  });

  test("disabled form controls are not focusable, even with a tabindex", () => {
    expect(
      failingItems(
        body(`<div aria-hidden="true">
          <button disabled tabindex="0">b</button>
          <input name="i" DISABLED>
          <select name="s" disabled></select>
          <textarea name="t" disabled></textarea>
        </div>`),
      ),
    ).toEqual([]);
  });

  test("disabled only applies to form controls", () => {
    expect(
      failingItems(body(`<div aria-hidden="true"><a href="/x" id="link" disabled>x</a></div>`)),
    ).toEqual(["a#link"]);
  });

  test("hidden inputs are never focusable, whatever the tabindex or type casing", () => {
    expect(
      failingItems(
        body(
          `<div aria-hidden="true"><input type="hidden" name="a" tabindex="0"><input type="HIDDEN" name="b"></div>`,
        ),
      ),
    ).toEqual([]);
  });

  test("a focusable aria-hidden element is still reported, a tabindex=-1 one is not", () => {
    expect(failingItems(body(`<div aria-hidden="true" tabindex="0"><p>x</p></div>`))).toEqual([
      "div (self is focusable)",
    ]);
    expect(failingItems(body(`<a href="/x" aria-hidden="true" tabindex="-1">x</a>`))).toEqual([]);
  });

  test("only ASCII whitespace may precede a tabindex, as in the HTML integer rules", () => {
    // A leading NBSP makes the value invalid: the link keeps native focusability
    // and the div gains none.
    expect(
      failingItems(
        body(
          `<div aria-hidden="true"><a href="/x" id="nbsp-link" tabindex="&#160;-1">x</a><div id="nbsp-div" tabindex="&#160;0">y</div><a href="/z" id="tab-ws" tabindex="&#9;-1">z</a></div>`,
        ),
      ),
    ).toEqual(["a#nbsp-link"]);
  });

  test("keyword attributes are matched without trimming", () => {
    // type=" hidden " is not the hidden keyword, so the input is a text field.
    expect(
      failingItems(body(`<div aria-hidden="true"><input id="padded" type=" hidden "></div>`)),
    ).toEqual(["input#padded"]);
    // hidden=" until-found " is not until-found, so it hides the subtree.
    expect(
      failingItems(
        body(`<div aria-hidden="true" hidden=" until-found "><button id="b">b</button></div>`),
      ),
    ).toEqual([]);
    // UNTIL-FOUND in any case still leaves the subtree reachable.
    expect(
      failingItems(
        body(`<div aria-hidden="true" hidden="UNTIL-FOUND"><button id="b">b</button></div>`),
      ),
    ).toEqual(["button#b"]);
  });

  test("inert or hidden on the focusable element itself counts", () => {
    expect(
      failingItems(
        body(`<div aria-hidden="true"><a href="/x" inert>x</a><button hidden>b</button></div>`),
      ),
    ).toEqual([]);
  });

  test("a nested aria-hidden region under an inert wrapper is skipped too", () => {
    expect(
      failingItems(
        body(
          `<div aria-hidden="true"><div inert><div aria-hidden="true"><a href="/x">x</a></div></div></div>`,
        ),
      ),
    ).toEqual([]);
  });

  test("a negative tabindex on the container does not hide a reachable child", () => {
    expect(
      failingItems(
        body(`<div aria-hidden="true" tabindex="-1"><a href="/x" id="child">x</a></div>`),
      ),
    ).toEqual(["a#child"]);
  });

  test("an excluded honeypot is neither an error nor a honeypot warning", () => {
    const checks = run(
      body(
        `<form><div aria-hidden="true" inert><input type="text" id="contact-hp" name="contact-hp"></div></form>`,
      ),
    );
    expect(checks).toHaveLength(1);
    expect(check(checks, "aria-hidden-focus")?.status).toBe("pass");
  });

  test("a honeypot that follows the remedy (tabindex=-1) is no longer reported at all", () => {
    const checks = run(
      body(
        `<form><div aria-hidden="true"><input type="text" id="pp-contact-hp" name="pp-contact-hp" tabindex="-1" autocomplete="off"></div></form>`,
      ),
    );
    expect(check(checks, "aria-hidden-focus-honeypot")).toBeUndefined();
    expect(check(checks, "aria-hidden-focus")?.status).toBe("pass");
  });
});
