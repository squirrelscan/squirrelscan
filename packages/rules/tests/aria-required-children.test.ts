// a11y/aria-required-children counts a native element's implicit role as the
// required child: an <input type="radio"> inside role=radiogroup is a radio,
// with or without a wrapper (#435). An explicit role still replaces the
// implicit one, and groups that really lack the child still fail.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";
import { parseHTML } from "@squirrelscan/parser/dom";

import { ariaRequiredChildrenRule } from "../src/a11y/aria-required-children";
import { effectiveRole, implicitRole } from "../src/a11y/implicit-role";
import type { RuleContext } from "../src/types";

const URL = "https://example.com/";

function missing(body: string): string[] {
  const html = `<!DOCTYPE html><html lang="en"><head><title>t</title></head><body><main>${body}</main></body></html>`;
  const ctx = {
    page: { url: URL, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, URL),
    options: {},
  } as unknown as RuleContext;
  const result = ariaRequiredChildrenRule.run(ctx);
  if (result instanceof Promise) throw new Error("rule is async");
  const check = result.checks[0];
  return check?.status === "fail" ? (check.items ?? []).map((i) => i.id) : [];
}

describe("a11y/aria-required-children: implicit roles satisfy the requirement (#435)", () => {
  test("the issue's repro: native radios inside wrapper divs", () => {
    expect(
      missing(`<div role="radiogroup" aria-label="Size">
        <div><input type="radio" id="s" name="size" value="s"><label for="s">S</label></div>
        <div><input type="radio" id="m" name="size" value="m"><label for="m">M</label></div>
      </div>`)
    ).toEqual([]);
  });

  test.each([
    ["radiogroup > label > input[type=radio]", `<div role="radiogroup"><label><input type="radio" name="c"> Red</label></div>`],
    ["listbox > optgroup (group) > option", `<div role="listbox"><optgroup label="Citrus"><option>Lemon</option></optgroup></div>`],
    ["tree > fieldset > treeitem", `<div role="tree"><fieldset><legend>src</legend><div role="treeitem">a.ts</div></fieldset></div>`],
    ["tree > explicit group, as before", `<div role="tree"><div role="group">files</div></div>`],
    ["grid > table > thead (rowgroup)", `<div role="grid"><table><thead><tr><th>Name</th></tr></thead></table></div>`],
    ["row > th[scope=row] (rowheader)", `<table><tr role="row"><th scope="row">Total</th></tr></table>`],
    ["row > td (cell)", `<table><tr role="row"><td>3</td></tr></table>`],
    ["row > td in a grid (gridcell)", `<table role="grid"><tr role="row"><td>3</td></tr></table>`],
    ["list > li (listitem)", `<div role="list"><li>one</li></div>`],
    ["table > tbody (rowgroup)", `<div role="table"><tbody><tr><td>1</td></tr></tbody></div>`],
    ["feed > article", `<div role="feed"><article>post</article></div>`],
    ["explicit role in a fallback list, uppercase", `<div role="radiogroup"><span role="widget RADIO" aria-checked="false">A</span></div>`],
    ["role=none is ignored on a focusable element", `<ul role="list"><li role="none" tabindex="0">Item</li></ul>`],
    ["role=presentation is ignored with a global ARIA attribute", `<ul role="list"><li role="presentation" aria-label="Item">Item</li></ul>`],
    ["role=none is ignored on an editing host", `<ul role="list"><li role="none" contenteditable="true">Item</li></ul>`],
  ])("%s", (_name, body) => {
    expect(missing(body)).toEqual([]);
  });

  test("ownership follows aria-owns through a native wrapper", () => {
    expect(
      missing(`<div role="tree" aria-owns="g">Tree</div>
        <fieldset id="g" aria-owns="t"><legend>Group</legend></fieldset>
        <div role="treeitem" id="t">Item</div>`)
    ).toEqual([]);
  });

  test("an aria-owns cycle ends", () => {
    expect(
      missing(`<div role="radiogroup" id="a" aria-owns="b">A</div><div id="b" aria-owns="a">B</div>`)
    ).toEqual([`div[role="radiogroup"]: needs child with role=radio`]);
  });

  test("aria-owns brings the required children in from elsewhere", () => {
    expect(
      missing(`<div role="radiogroup" aria-owns="a b"><span>Pick one</span></div>
        <div><input type="radio" id="a" name="o"><input type="radio" id="b" name="o"></div>`)
    ).toEqual([]);
  });
});

describe("a11y/aria-required-children: groups missing their children still fail", () => {
  test.each([
    ["radiogroup with labels only", `<div role="radiogroup"><div><label>S</label></div></div>`, `div[role="radiogroup"]: needs child with role=radio`],
    ["radiogroup with checkboxes", `<div role="radiogroup"><label><input type="checkbox"> Wrong</label></div>`, `div[role="radiogroup"]: needs child with role=radio`],
    ["an explicit role replaces the implicit one", `<div role="radiogroup"><input type="radio" role="menuitemradio"></div>`, `div[role="radiogroup"]: needs child with role=radio`],
    ["role=none takes li out of the list", `<div role="list"><li role="none">not an item</li></div>`, `div[role="list"]: needs child with role=listitem`],
    ["tablist of plain buttons", `<div role="tablist"><button type="button">One</button></div>`, `div[role="tablist"]: needs child with role=tab`],
    ["menu of list items", `<ul role="menu"><li><a href="/a">A</a></li></ul>`, `ul[role="menu"]: needs child with role=menuitem|menuitemcheckbox|menuitemradio|group`],
    ["aria-owns pointing at nothing", `<div role="radiogroup" aria-owns="nope"><span>Pick</span></div>`, `div[role="radiogroup"]: needs child with role=radio`],
    ["a native group wraps items, it is not one", `<div role="tree"><fieldset><legend>src</legend>files</fieldset></div>`, `div[role="tree"]: needs child with role=treeitem|group`],
    ["details with no treeitem inside", `<div role="tree"><details><summary>src</summary>files</details></div>`, `div[role="tree"]: needs child with role=treeitem|group`],
    ["an empty tbody is no row", `<div role="table"><tbody></tbody></div>`, `div[role="table"]: needs child with role=row|rowgroup`],
    ["a padded type is not radio", `<div role="radiogroup"><input type=" radio "></div>`, `div[role="radiogroup"]: needs child with role=radio`],
    ["an invalid tabindex does not make role=none focusable", `<div role="list"><li role="none" tabindex="bogus">x</li></div>`, `div[role="list"]: needs child with role=listitem`],
    ["radios inside <noscript> do not exist with scripting on", `<div role="radiogroup">Choose<noscript><input type="radio"></noscript></div>`, `div[role="radiogroup"]: needs child with role=radio`],
  ])("%s", (_name, body, expected) => {
    expect(missing(body)).toEqual([expected]);
  });

  test("an empty group is skipped, as before (it may be filled in by script)", () => {
    expect(missing(`<div role="radiogroup"></div>`)).toEqual([]);
  });

  test("a container inside <noscript> is not checked", () => {
    expect(missing(`<noscript><div role="radiogroup"><label>S</label></div></noscript>`)).toEqual([]);
  });
});

describe("implicitRole / effectiveRole", () => {
  const { document } = parseHTML(`<!DOCTYPE html><html><body>
    <input id="radio" type="radio"><input id="check" type="CHECKBOX"><input id="text">
    <input id="email-list" type="email" list="l"><input id="search" type="search">
    <input id="hidden" type="hidden"><input id="password" type="password"><input id="weird" type="bogus">
    <select id="combo"></select><select id="multi" multiple></select><select id="sized" size="4"></select>
    <a id="link" href="/"></a><a id="anchor"></a><img id="img" alt="x"><img id="decor" alt="">
    <section id="plain"></section><section id="named" aria-label="n"></section>
    <header id="banner"></header><article><header id="article-header"></header></article>
    <constructor id="proto"></constructor><div id="div"></div>
    <span id="bogus-role" role="bogus"></span><span id="fallback" role="bogus tab"></span>
  </body></html>`);
  const el = (id: string) => {
    const found = document.getElementById(id);
    if (!found) throw new Error(`no #${id}`);
    return found;
  };

  test.each([
    ["radio", "radio"],
    ["check", "checkbox"],
    ["text", "textbox"],
    ["email-list", "combobox"],
    ["search", "searchbox"],
    ["hidden", null],
    ["password", null],
    ["weird", "textbox"],
    ["combo", "combobox"],
    ["multi", "listbox"],
    ["sized", "listbox"],
    ["link", "link"],
    ["anchor", null],
    ["img", "img"],
    ["decor", "presentation"],
    ["plain", null],
    ["named", "region"],
    ["banner", "banner"],
    ["article-header", null],
    ["proto", null],
    ["div", null],
  ])("#%s -> %s", (id, role) => {
    expect(implicitRole(el(id))).toBe(role);
  });

  test("a role with no valid token falls back to the implicit role; the first valid token wins", () => {
    expect(effectiveRole(el("bogus-role"))).toBe(null);
    expect(effectiveRole(el("fallback"))).toBe("tab");
    expect(effectiveRole(el("radio"))).toBe("radio");
  });
});
