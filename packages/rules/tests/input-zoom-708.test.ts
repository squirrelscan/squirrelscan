// #708 — mobile/input-zoom: a text field under 16px makes iOS Safari zoom the
// page in on focus. The rule judges a field only from inline styles and
// `<style>` blocks it can read plainly; anything else is "not read", never a
// guess.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import {
  fontShorthandSize,
  inputZoomRule,
  sizeToPx,
  splitSelectorList,
} from "../src/mobile/input-zoom";
import type { RuleContext } from "../src/types";

function run(head: string, body: string): CheckResult[] {
  const html = `<!doctype html><html lang="en"><head><title>Form</title>${head}</head><body><form>${body}</form></body></html>`;
  const url = "https://shop.example/checkout";
  const ctx = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    options: {},
  } as unknown as RuleContext;
  return (inputZoomRule.run(ctx) as { checks: CheckResult[] }).checks;
}

function only(checks: CheckResult[]): CheckResult {
  expect(checks).toHaveLength(1);
  return checks[0]!;
}

describe("mobile/input-zoom (#708)", () => {
  test("an inline 14px email field is a warning naming the field and its size", () => {
    const check = only(run("", '<input type="email" name="email" style="font-size:14px">'));
    expect(check.status).toBe("warn");
    expect(check.message).toBe("1 form field(s) under 16px make iOS Safari zoom in on focus.");
    expect(check.items).toEqual([
      { id: 'input type="email" name="email"', label: "14px (inline style)" },
    ]);
  });

  test("a <style> block at 0.875rem on a 16px root warns for each matching field", () => {
    const check = only(
      run(
        "<style>html { font-size: 16px } input, select { font-size: 0.875rem }</style>",
        '<input name="q"><select name="country"><option>AU</option></select>',
      ),
    );
    expect(check.status).toBe("warn");
    expect(check.items).toEqual([
      { id: 'input type="text" name="q"', label: "14px (<style>: input)" },
      { id: 'select name="country"', label: "14px (<style>: select)" },
    ]);
  });

  test("the same fields at 16px or 1rem pass", () => {
    for (const size of ["16px", "1rem", "medium", "12pt"]) {
      const check = only(
        run(
          `<style>input, select, textarea { font-size: ${size} }</style>`,
          "<input><select></select><textarea></textarea>",
        ),
      );
      expect([size, check.status]).toEqual([size, "pass"]);
    }
  });

  test("inputs that open no keyboard are never checked", () => {
    const types = [
      "checkbox",
      "radio",
      "range",
      "color",
      "file",
      "hidden",
      "submit",
      "button",
      "reset",
      "image",
    ];
    const body = types.map((t) => `<input type="${t}" style="font-size:12px">`).join("");
    expect(run("", body)).toEqual([]);
  });

  test("fields styled only by an external stylesheet are not warned about, and are reported as not read", () => {
    const check = only(
      run('<link rel="stylesheet" href="/app.css">', '<input class="text-sm" name="email">'),
    );
    expect(check.status).toBe("info");
    expect(check.message).toContain("1 more field(s) were not read");
    expect(check.details).toMatchObject({ under16px: 0, notRead: 1 });
  });

  test("a zoom-blocking viewport still gets the warning, and the finding names the workaround", () => {
    const check = only(
      run(
        '<meta name="viewport" content="width=device-width, maximum-scale=1">',
        '<input type="email" style="font-size:14px">',
      ),
    );
    expect(check.status).toBe("warn");
    expect(check.message).toContain("maximum-scale=1");
    expect(check.message).toContain("a 16px field size fixes both");
  });

  test("the solution recommends 16px fields and never disabling zoom", () => {
    const solution = inputZoomRule.meta.solution;
    expect(solution).toContain("at least 16px");
    expect(solution).toContain("Do not stop the zoom");
  });

  test("a size the audit cannot pin down is not read, not guessed", () => {
    // Inside a media query, from conflicting rules, from a relative unit, or
    // from a focus-state rule the selector engine cannot run.
    for (const [style, body] of [
      [
        "@media (max-width: 600px) { input { font-size: 16px } } input { font-size: 14px }",
        "<input>",
      ],
      ["input { font-size: 14px } .field { font-size: 16px }", '<input class="field">'],
      ["input { font-size: 0.875em }", "<input>"],
      ["input { font-size: var(--field) }", "<input>"],
      ["input:focus { font-size: 16px } input { font-size: 14px }", "<input>"],
    ] as const) {
      const check = only(run(`<style>${style}</style>`, body));
      expect([style, check.status]).toEqual([style, "info"]);
    }
  });

  test("a size reset to the parent's, or set in a media-scoped style block, is not read", () => {
    for (const [head, body] of [
      ["<style>input, select, textarea { font: inherit }</style>", "<input>"],
      ["<style>input { all: unset }</style>", "<input>"],
      ['<style media="print">input { font-size: 12px }</style>', "<input>"],
      ["<style>input { font-size: 100% }</style>", "<input>"],
    ] as const) {
      const check = only(run(head, body));
      expect([head, check.status]).toEqual([head, "info"]);
    }
  });

  test("the cascade order: !important rules beat inline, an !important inline size beats both", () => {
    expect(
      only(
        run(
          "<style>input { font-size: 16px !important }</style>",
          '<input style="font-size:14px">',
        ),
      ).status,
    ).toBe("pass");
    expect(
      only(
        run(
          "<style>input { font-size: 16px !important }</style>",
          '<input style="font-size:14px !important">',
        ),
      ).status,
    ).toBe("warn");
    // A plain media-query rule loses to the inline size, so it does not matter.
    expect(
      only(
        run(
          "<style>@media (max-width: 600px) { input { font-size: 16px } }</style>",
          '<input style="font-size:14px">',
        ),
      ).status,
    ).toBe("warn");
    // The later of `font` and `font-size` in one block wins.
    const later = only(run("<style>input { font: inherit; font-size: 14px }</style>", "<input>"));
    expect(later.items).toEqual([{ id: 'input type="text"', label: "14px (<style>: input)" }]);
  });

  test("rem resolves against the page's root size, and is not read when an external sheet may set it", () => {
    const tenPxRoot = only(
      run("<style>html { font-size: 62.5% } input { font-size: 1.4rem }</style>", "<input>"),
    );
    expect(tenPxRoot.items).toEqual([{ id: 'input type="text"', label: "14px (<style>: input)" }]);
    const unknownRoot = only(
      run(
        '<link rel="stylesheet" href="/app.css"><style>input { font-size: 0.875rem }</style>',
        "<input>",
      ),
    );
    expect(unknownRoot.status).toBe("info");
    const mediaRoot = only(
      run(
        "<style>@media (max-width: 600px) { html { font-size: 14px } } input { font-size: 1rem }</style>",
        "<input>",
      ),
    );
    expect(mediaRoot.status).toBe("info");
  });

  test("an unstyled field on a page with no external CSS gets iOS's own 11px and is reported", () => {
    const check = only(
      run(
        "<style>body { font-size: 18px }</style>",
        '<input name="q"><textarea name="msg"></textarea>',
      ),
    );
    expect(check.status).toBe("warn");
    expect(check.items).toEqual([
      { id: 'input type="text" name="q"', label: "11px (iOS default)" },
      { id: 'textarea name="msg"', label: "11px (iOS default)" },
    ]);
  });

  test("a stylesheet preloaded and switched on by script counts as external CSS", () => {
    const check = only(
      run(
        '<link rel="preload" as="style" href="/app.css" onload="this.rel=\'stylesheet\'">',
        "<input>",
      ),
    );
    expect(check.status).toBe("info");
  });

  test("a page with no text field gets no check", () => {
    expect(run("", '<input type="submit" value="Go">')).toEqual([]);
  });

  test("hidden and disabled fields cannot be focused and are not checked", () => {
    const body = [
      '<input hidden name="d">',
      '<div hidden><input name="a"></div>',
      '<input disabled name="b">',
      '<fieldset disabled><select name="c"></select></fieldset>',
      '<input inert name="e">',
      // The Mailchimp spam trap: off screen, aria-hidden, never focused by a visitor.
      '<div style="position: absolute; left: -5000px;" aria-hidden="true"><input name="b_123" tabindex="-1"></div>',
      '<div style="display:none"><input name="f"></div>',
      '<dialog><input style="font-size:14px" name="h"></dialog>',
      '<details><summary>More</summary><input style="font-size:14px" name="i"></details>',
      // A later invalid `display` does not undo the hiding.
      '<input style="display:none; display:bogus; font-size:12px" name="g">',
    ].join("");
    expect(run("", body)).toEqual([]);
  });

  test("a field a <style> rule hides is not read, and a hidden field part does not count", () => {
    const hidden = only(
      run(
        "<style>.hp { display: none }</style>",
        '<div class="hp"><input name="trap"></div><input style="font-size:14px">',
      ),
    );
    expect(hidden.details).toMatchObject({ fields: 2, under16px: 1, notRead: 1 });
    const part = only(
      run(
        "<style>input::-webkit-search-cancel-button { display: none } input { font-size: 14px }</style>",
        '<input type="search">',
      ),
    );
    expect(part.status).toBe("warn");
  });

  test("an external stylesheet may outrank a <style> rule, so only inline sizes are judged with one", () => {
    const styled = only(
      run(
        '<link rel="stylesheet" href="/app.css"><style>input { font-size: 14px }</style>',
        "<input>",
      ),
    );
    expect(styled.status).toBe("info");
    const inline = only(
      run('<link rel="stylesheet" href="/app.css">', '<input style="font-size:14px">'),
    );
    expect(inline.status).toBe("warn");
  });

  test("declarations are read in order with their own !important, past comments", () => {
    for (const [head, body, status] of [
      ["<style>input { /* brand */ font-size: 16px }</style>", "<input>", "pass"],
      ["<style>input { font-size: 16px !important; font-size: 12px }</style>", "<input>", "pass"],
      ["<style>input { font-size: 12px; font-size: 16px }</style>", "<input>", "pass"],
      // An incomplete shorthand is invalid in a browser; it is not read here.
      ["", '<input style="font-size:16px; font:12px">', "info"],
      ["", '<input style="font-size:16px; font:12px/banana sans-serif">', "info"],
      ["", '<input style="font-size:16px; font:italic italic 12px sans-serif">', "info"],
      // A comment separates tokens: this is not 12px.
      ["", '<input style="font-size:16px; font-size:1/**/2px">', "info"],
      // Nested rules are not followed, so no size or default is trusted next to one.
      ["<style>input { font-size: 14px; &:focus { font-size: 16px } }</style>", "<input>", "info"],
      [
        "<style>.wrapper { input { font-size: 16px } }</style>",
        '<div class="wrapper"><input></div>',
        "info",
      ],
      // `display` and `visibility` are separate: either one hides the field.
      [
        "<style>.x { display: none; visibility: visible; font-size: 12px }</style>",
        '<input class="x">',
        "info",
      ],
    ] as const) {
      const check = only(run(head, body));
      expect([head, body, check.status]).toEqual([head, body, status]);
    }
  });

  test("selectors the engine would run differently from a browser are not read", () => {
    for (const style of [
      // `:scope` in a stylesheet is the root, not each field.
      ":scope { font-size: 12px !important } input { font-size: 16px }",
      "[name=q]:focus { font-size: 16px } input { font-size: 14px }",
      // Relaxing a state inside `:not()` would invert it.
      "input:not(:scope) { font-size: 16px } input { font-size: 14px }",
      ":not(:scope) { font-size: 16px } input { font-size: 14px }",
      // The root size is decided by specificity this read does not compute.
      ":root { font-size: 32px } html { font-size: 16px } input { font-size: 0.5rem }",
    ]) {
      const check = only(run(`<style>${style}</style>`, '<input name="q">'));
      expect([style, check.status]).toEqual([style, "info"]);
    }
  });

  test("helpers", () => {
    expect(splitSelectorList("input, :is(select, textarea), [data-x='a,b']")).toEqual([
      "input",
      ":is(select, textarea)",
      "[data-x='a,b']",
    ]);
    expect(fontShorthandSize("italic 14px/1.4 Inter, sans-serif")).toBe("14px");
    expect(fontShorthandSize('400 1rem/normal "Helvetica Neue", system-ui')).toBe("1rem");
    expect(fontShorthandSize("inherit")).toBeNull();
    expect(fontShorthandSize("12px")).toBeNull();
    expect(fontShorthandSize("14px var(--font-sans)")).toBeNull();
    expect(sizeToPx("0.875rem", 16)).toBe(14);
    expect(sizeToPx("10.5pt", 16)).toBe(14);
    expect(sizeToPx("small", 16)).toBe(13);
    expect(sizeToPx("100%", 16)).toBe("relative-unit");
    expect(sizeToPx("1rem", null)).toBe("relative-unit");
    expect(sizeToPx("constructor", 16)).toBe("relative-unit");
  });

  test("a hostile stylesheet stays within budget", () => {
    const rules = Array.from(
      { length: 5000 },
      (_, i) => `.c${i} input, form .c${i} > select { font-size: 14px }`,
    ).join("\n");
    const fields = Array.from({ length: 300 }, (_, i) => `<input name="f${i}">`).join("");
    const started = performance.now();
    const check = only(run(`<style>${rules}</style>`, fields));
    expect(performance.now() - started).toBeLessThan(5000);
    expect(check.status).toBe("info");
  });
});
