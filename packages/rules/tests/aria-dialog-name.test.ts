// a11y/aria-dialog-name names each unnamed dialog well enough to find it (#462).
//
// An id-less dialog used to be reported as a bare `dialog`, so a page with
// several (a Shopify theme's cart, menu and newsletter drawers) gave no way to
// tell which one lacked a name. Items now read `dialog.newsletter-popup`, carry
// the start tag as a snippet, and keep `dialog#id` when there is an id.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { ariaDialogNameRule } from "../src/a11y/aria-dialog-name";
import type { CheckResult, RuleContext } from "../src/types";

function run(body: string): CheckResult[] {
  const html = `<!doctype html><html lang="en"><head><title>t</title></head><body><h1>Repro</h1>${body}</body></html>`;
  const url = "https://example.com/";
  const ctx = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    options: {},
  } as unknown as RuleContext;
  const result = ariaDialogNameRule.run(ctx);
  if (result instanceof Promise) throw new Error("aria-dialog-name is async");
  return result.checks;
}

function check(checks: CheckResult[], name: string): CheckResult | undefined {
  return checks.find((c) => c.name === name);
}

describe("native <dialog>", () => {
  test("the #462 repro: the unnamed id-less dialog is identified by its class", () => {
    const native = check(
      run(
        `<dialog class="cart-drawer" aria-label="Cart"></dialog>` +
          `<dialog class="menu-drawer" aria-label="Menu"></dialog>` +
          `<dialog class="newsletter-popup"></dialog>`
      ),
      "dialog-name"
    );
    expect(native?.status).toBe("warn");
    expect(native?.message).toBe("1 native <dialog>(s) without accessible names");
    expect(native?.items).toEqual([
      { id: "dialog.newsletter-popup", snippet: `<dialog class="newsletter-popup">` },
    ]);
  });

  test("a dialog with an id keeps dialog#id", () => {
    const native = check(run(`<dialog id="promo" class="popup"></dialog>`), "dialog-name");
    expect(native?.items?.map((i) => i.id)).toEqual(["dialog#promo"]);
  });

  test("up to three classes are kept, in source order", () => {
    const native = check(
      run(`<dialog class="  drawer  drawer--right is-open js-hook "></dialog>`),
      "dialog-name"
    );
    expect(native?.items?.map((i) => i.id)).toEqual(["dialog.drawer.drawer--right.is-open"]);
  });

  test("a dialog with no id and no class is still a bare dialog", () => {
    const native = check(run(`<dialog></dialog>`), "dialog-name");
    expect(native?.items).toEqual([{ id: "dialog", snippet: "<dialog>" }]);
  });

  test("dialogs that share a descriptor get an ordinal from the second on", () => {
    const native = check(
      run(
        `<dialog class="drawer" data-section="cart"></dialog>` +
          `<dialog class="drawer" data-section="menu"></dialog>` +
          `<dialog class="drawer" data-section="search"></dialog>`
      ),
      "dialog-name"
    );
    expect(native?.items).toEqual([
      { id: "dialog.drawer", snippet: `<dialog class="drawer" data-section="cart">` },
      { id: "dialog.drawer (2)", snippet: `<dialog class="drawer" data-section="menu">` },
      { id: "dialog.drawer (3)", snippet: `<dialog class="drawer" data-section="search">` },
    ]);
  });

  test("naming one of two same-class dialogs leaves the other's id alone", () => {
    // The id is the finding's identity in the cloud: if the menu drawer became
    // `dialog.drawer` once the cart drawer was named, it would take over the
    // cart's finding and leave its own `(2)` finding behind.
    const before = check(
      run(`<dialog class="drawer" data-section="cart"></dialog><dialog class="drawer" data-section="menu"></dialog>`),
      "dialog-name"
    );
    const after = check(
      run(
        `<dialog class="drawer" data-section="cart" aria-label="Cart"></dialog><dialog class="drawer" data-section="menu"></dialog>`
      ),
      "dialog-name"
    );
    expect(before?.items?.map((i) => i.id)).toEqual(["dialog.drawer", "dialog.drawer (2)"]);
    expect(after?.items?.map((i) => i.id)).toEqual(["dialog.drawer (2)"]);
  });

  test("an ordinal never repeats an id given out already", () => {
    const native = check(
      run(`<dialog id="x"></dialog><dialog id="x"></dialog><dialog id="x (2)"></dialog>`),
      "dialog-name"
    );
    const ids = native?.items?.map((i) => i.id) ?? [];
    expect(ids).toEqual(["dialog#x", "dialog#x (2)", "dialog#x (2) (2)"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("the same markup gives the same items on every scan", () => {
    const body = `<dialog class="a"></dialog><dialog class="a"></dialog><dialog id="x"></dialog>`;
    expect(check(run(body), "dialog-name")?.items).toEqual(check(run(body), "dialog-name")?.items);
  });

  test("named dialogs still pass", () => {
    const native = check(
      run(
        `<h2 id="t">Title</h2><dialog aria-labelledby="t"></dialog><dialog aria-label="Cart"></dialog><dialog title="Menu"></dialog>`
      ),
      "dialog-name"
    );
    expect(native?.status).toBe("pass");
  });

  test("the snippet is the start tag only, capped", () => {
    const native = check(
      run(`<dialog class="popup" data-blob="${"x".repeat(1000)}"><p>${"Long content. ".repeat(200)}</p></dialog>`),
      "dialog-name"
    );
    const snippet = native?.items?.[0]?.snippet ?? "";
    expect(snippet.startsWith(`<dialog class="popup"`)).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(200);
    expect(snippet).not.toContain("Long content");
  });
});

describe("ARIA dialogs", () => {
  test("an id-less role dialog is identified by tag, role and class", () => {
    const aria = check(
      run(`<div role="dialog" class="modal modal--wide"></div><section role="alertdialog"></section>`),
      "aria-dialog-name"
    );
    expect(aria?.status).toBe("fail");
    expect(aria?.items).toEqual([
      { id: `div[role="dialog"].modal.modal--wide`, snippet: `<div role="dialog" class="modal modal--wide">` },
      { id: `section[role="alertdialog"]`, snippet: `<section role="alertdialog">` },
    ]);
  });

  test("a role dialog with an id keeps role#id", () => {
    const aria = check(run(`<div role="alertdialog" id="confirm" class="modal"></div>`), "aria-dialog-name");
    expect(aria?.items?.map((i) => i.id)).toEqual(["alertdialog#confirm"]);
  });

  test("more than ten are capped with a remainder count", () => {
    const body = Array.from({ length: 12 }, (_, i) => `<div role="dialog" class="m${i}"></div>`).join("");
    const aria = check(run(body), "aria-dialog-name");
    expect(aria?.items).toHaveLength(10);
    expect(aria?.details).toEqual({ additional: 2 });
  });
});
