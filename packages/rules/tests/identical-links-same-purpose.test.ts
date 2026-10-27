// a11y/identical-links-same-purpose keeps repeated menu labels separate by context (#1043).

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { identicalLinksSamePurposeRule } from "../src/a11y/identical-links-same-purpose";
import type { CheckResult, RuleContext } from "../src/types";

function run(body: string): CheckResult | undefined {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shop</title></head><body>${body}</body></html>`;
  const url = "https://example.com/";
  const ctx = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    options: {},
  } as unknown as RuleContext;
  const result = identicalLinksSamePurposeRule.run(ctx);
  if (result instanceof Promise) {
    throw new Error("identical-links-same-purpose is async");
  }
  return result.checks.find((check) => check.name === "identical-links-same-purpose");
}

describe("a11y/identical-links-same-purpose context", () => {
  test("the reporter's labelled mega-menu passes", () => {
    const result = run(`
      <nav aria-label="Hauptmenü"><ul>
        <li><a href="/damen/">Damen</a><ul aria-label="Damen">
          <li><a href="/damen/bademode/">Bademode</a></li>
          <li><a href="/damen/shirts/">Shirts</a></li>
        </ul></li>
        <li><a href="/herren/">Herren</a><ul aria-label="Herren">
          <li><a href="/herren/bademode/">Bademode</a></li>
          <li><a href="/herren/shirts/">Shirts</a></li>
        </ul></li>
      </ul></nav>
    `);

    expect(result?.status).toBe("pass");
    expect(result?.items).toBeUndefined();
  });

  test("same text without context and different targets still warns", () => {
    const result = run(`
      <a href="/plans/team">Learn more</a>
      <a href="/plans/enterprise">Learn more</a>
    `);

    expect(result?.status).toBe("warn");
    expect(result?.items?.[0]?.id).toBe('"learn more" → 2 different URLs');
  });

  test("same text and same aria-label context still warns", () => {
    const result = run(`
      <ul aria-label="Products"><li><a href="/one">Learn more</a></li></ul>
      <ul aria-label="Products"><li><a href="/two">Learn more</a></li></ul>
    `);

    expect(result?.status).toBe("warn");
    expect(result?.items?.[0]?.id).toBe('"learn more" in "products" → 2 different URLs');
  });

  test("aria-labelledby gives repeated link text distinct contexts", () => {
    const result = run(`
      <h2 id="women">Women</h2>
      <ul aria-labelledby="women"><li><a href="/women/sale">Sale</a></li></ul>
      <h2 id="men">Men</h2>
      <ul aria-labelledby="men"><li><a href="/men/sale">Sale</a></li></ul>
    `);

    expect(result?.status).toBe("pass");
  });

  test("a parent list item's leading link gives nested menus context", () => {
    const result = run(`
      <ul>
        <li><a href="/women">Women</a><ul><li><a href="/women/sale">Sale</a></li></ul></li>
        <li><a href="/men">Men</a><ul><li><a href="/men/sale">Sale</a></li></ul></li>
      </ul>
    `);

    expect(result?.status).toBe("pass");
  });

  test("a labelled context shared by thousands of links completes", () => {
    const labels = Array.from(
      { length: 8 },
      (_, index) => `<span id="label-${index}">Section ${index}</span>`,
    ).join("");
    const links = Array.from(
      { length: 5_000 },
      () => '<li><a href="/catalog">Catalog</a></li>',
    ).join("");
    const labelledBy = Array.from({ length: 8 }, (_, index) => `label-${index}`).join(" ");

    const result = run(`${labels}<ul aria-labelledby="${labelledBy}">${links}</ul>`);

    expect(result?.status).toBe("pass");
  });
});
