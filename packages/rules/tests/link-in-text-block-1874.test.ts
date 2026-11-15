// squirrelscan/squirrelscan#1874: icon-only links in link lists are not links in running text.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { linkInTextBlockRule } from "../src/a11y/link-in-text-block";
import type { ParsedPage, RuleContext } from "../src/types";

const URL = "https://example.com/";

async function check(html: string) {
  const ctx: RuleContext = {
    page: { url: URL, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, URL) as ParsedPage,
    options: {},
  };
  return (await linkInTextBlockRule.run(ctx)).checks[0]!;
}

describe("a11y/link-in-text-block (#1874)", async () => {
  test("icon-only svg link in a list does not warn", async () => {
    const c = await check(
      `<ul><li><a href="https://s.example/p" aria-label="Social" style="text-decoration:none"><svg aria-hidden="true"></svg></a></li></ul>`,
    );
    expect(c.status).not.toBe("warn");
  });

  test("li and td holding only a link are not text blocks", async () => {
    const c = await check(
      `<ul><li><a href="/a" class="no-underline">Home</a></li></ul><table><tr><td><a href="/b" style="text-decoration:none">Docs</a></td></tr></table>`,
    );
    expect(c.status).toBe("info");
  });

  test("link in running text still warns", async () => {
    const c = await check(
      `<p>Read <a href="/x" style="text-decoration:none">the guide</a> first.</p>`,
    );
    expect(c.status).toBe("warn");
    expect(c.items?.[0]?.id).toBe(`"the guide"`);
  });

  test("border or background in inline style does not warn", async () => {
    const c = await check(
      `<p>Read <a href="/x" style="text-decoration:none;border-bottom:1px solid">the guide</a> and <a href="/y" style="text-decoration:none; background:#eee">more</a>.</p>`,
    );
    expect(c.status).toBe("pass");
  });

  test("warned link without text is never reported as empty", async () => {
    const c = await check(`<p>See <a href="/x" style="text-decoration:none">x</a> and text</p>`);
    expect(c.items?.every((i: { id: string }) => i.id !== `""`)).toBe(true);
  });
});
