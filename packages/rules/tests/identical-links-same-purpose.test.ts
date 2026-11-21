// a11y/identical-links-same-purpose keeps repeated menu labels separate by context (#1043).

import { parsePage } from "@squirrelscan/parser";
import { describe, expect, test } from "bun:test";

import type { CheckResult, RuleContext } from "../src/types";

import { identicalLinksSamePurposeRule } from "../src/a11y/identical-links-same-purpose";

async function run(body: string): Promise<CheckResult | undefined> {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shop</title></head><body>${body}</body></html>`;
  const url = "https://example.com/";
  const ctx = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    options: {},
  } as unknown as RuleContext;
  const result = await identicalLinksSamePurposeRule.run(ctx);
  return result.checks.find(
    (check) => check.name === "identical-links-same-purpose"
  );
}

describe("a11y/identical-links-same-purpose context", () => {
  test("the reporter's labelled mega-menu passes", async () => {
    const result = await run(`
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

  test("same text without context and different targets still warns", async () => {
    const result = await run(`
      <a href="/plans/team">Learn more</a>
      <a href="/plans/enterprise">Learn more</a>
    `);

    expect(result?.status).toBe("warn");
    expect(result?.items?.[0]?.id).toBe('"learn more" → 2 different URLs');
  });

  test("same text and same aria-label context still warns", async () => {
    const result = await run(`
      <ul aria-label="Products"><li><a href="/one">Learn more</a></li></ul>
      <ul aria-label="Products"><li><a href="/two">Learn more</a></li></ul>
    `);

    expect(result?.status).toBe("warn");
    expect(result?.items?.[0]?.id).toBe(
      '"learn more" in "products" → 2 different URLs'
    );
  });

  test("aria-labelledby gives repeated link text distinct contexts", async () => {
    const result = await run(`
      <h2 id="women">Women</h2>
      <ul aria-labelledby="women"><li><a href="/women/sale">Sale</a></li></ul>
      <h2 id="men">Men</h2>
      <ul aria-labelledby="men"><li><a href="/men/sale">Sale</a></li></ul>
    `);

    expect(result?.status).toBe("pass");
  });

  test("a parent list item's leading link gives nested menus context", async () => {
    const result = await run(`
      <ul>
        <li><a href="/women">Women</a><ul><li><a href="/women/sale">Sale</a></li></ul></li>
        <li><a href="/men">Men</a><ul><li><a href="/men/sale">Sale</a></li></ul></li>
      </ul>
    `);

    expect(result?.status).toBe("pass");
  });

  test("a labelled context shared by thousands of links completes", async () => {
    const labels = Array.from(
      { length: 8 },
      (_, index) => `<span id="label-${index}">Section ${index}</span>`
    ).join("");
    const links = Array.from(
      { length: 5_000 },
      () => '<li><a href="/catalog">Catalog</a></li>'
    ).join("");
    const labelledBy = Array.from(
      { length: 8 },
      (_, index) => `label-${index}`
    ).join(" ");

    const result = await run(
      `${labels}<ul aria-labelledby="${labelledBy}">${links}</ul>`
    );

    expect(result?.status).toBe("pass");
  });
});

describe("a11y/identical-links-same-purpose accessible name (#1875)", () => {
  test("same visible text with distinct aria-label values passes", async () => {
    const result = await run(`
      <a href="/events/1.ics" aria-label="Add to calendar: Event one">Add to calendar</a>
      <a href="/events/2.ics" aria-label="Add to calendar: Event two">Add to calendar</a>
    `);
    expect(result?.status).toBe("pass");
  });

  test("same visible text with distinct aria-labelledby targets passes", async () => {
    const result = await run(`
      <span id="n1">Event one</span><span id="n2">Event two</span>
      <a href="/events/1.ics" aria-labelledby="n1">Add to calendar</a>
      <a href="/events/2.ics" aria-labelledby="n2">Add to calendar</a>
    `);
    expect(result?.status).toBe("pass");
  });

  test("identical accessible names with different hrefs still warn", async () => {
    const result = await run(`
      <a href="/a" aria-label="Read more">One</a>
      <a href="/b" aria-label="Read more">Two</a>
    `);
    expect(result?.status).toBe("warn");
  });

  test("icon-only links named by aria-label are compared by that name", async () => {
    const result = await run(`
      <a href="/a" aria-label="Open cart"><svg></svg></a>
      <a href="/b" aria-label="Open cart"><svg></svg></a>
    `);
    expect(result?.status).toBe("warn");
    expect(result?.items?.[0]?.id).toBe('"open cart" → 2 different URLs');
  });

  test("the reported item uses the accessible name", async () => {
    const result = await run(`
      <a href="/a" aria-label="Buy now">Shop</a>
      <a href="/b" aria-label="Buy now">Store</a>
    `);
    expect(result?.items?.[0]?.id).toBe('"buy now" → 2 different URLs');
  });
});
