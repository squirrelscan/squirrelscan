// security/html-comment-exposure flags sensitive information left in HTML comments (#2332).

import { parsePage } from "@squirrelscan/parser";
import { describe, expect, test } from "bun:test";

import type { CheckResult, RuleContext } from "../src/types";

import {
  REDACTED,
  SNIPPET_MAX_LENGTH,
  htmlCommentExposureRule,
} from "../src/security/html-comment-exposure";

const URL_ = "https://www.example.com/page";

async function run(body: string): Promise<CheckResult | undefined> {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>T</title></head><body>${body}</body></html>`;
  const ctx = {
    page: { url: URL_, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, URL_),
    options: {},
  } as unknown as RuleContext;
  const result = await htmlCommentExposureRule.run(ctx);
  return result.checks[0];
}

async function signalsOf(comment: string): Promise<string[]> {
  const r = await run(`<p>x</p><!-- ${comment} -->`);
  if (r?.status !== "warn") return [];
  return (r.items![0]!.meta as { signals: string[] }).signals;
}

describe("signals", () => {
  test.each([
    ["10.0.0.5", "api at 10.0.0.5"],
    ["192.168.1.20", "see 192.168.1.20 for the admin box"],
    ["172.16.4.4", "db 172.16.4.4"],
    [".internal", "calls billing.corp.internal/v1"],
    [".local", "host printer.local"],
    ["staging host", "use staging.shop.example.net for tests"],
  ])("internal host: %s", async (_n, c) => {
    expect(await signalsOf(c)).toContain("internal-host");
  });

  test.each([
    "TODO: wire this up",
    "FIXME later",
    "HACK for ie",
    "remove before launch",
    "Do not ship this",
    "the password is in the vault",
    "debug mode on",
  ])("exposure note: %s", async (c) => {
    expect(await signalsOf(c)).toContain("exposure-note");
  });

  test.each([
    '<script src="/old.js"></script>',
    '<form action="/x"><input></form>',
    '<a href="/wp-admin/">Admin</a>',
  ])("commented-out markup: %s", async (c) => {
    expect(await signalsOf(c)).toContain("commented-markup");
  });

  test("a secret is flagged and redacted from the snippet", async () => {
    const key = `${"AKIA"}${"JQ7XK2MZ4PL9RT5N"}`;
    const r = await run(`<!-- stripe ${key} -->`);
    expect(r?.status).toBe("warn");
    const item = r!.items![0]!;
    expect((item.meta as { signals: string[] }).signals).toContain("secret");
    expect(item.snippet).toContain(REDACTED);
    expect(JSON.stringify(r)).not.toContain(key);
  });

  // The scanner reports offsets into DECODED text: entities before the key shift them, and cutting the raw comment
  // with them left the key in the snippet.
  const KEY = `${"AKIA"}${"JQ7XK2MZ4PL9RT5N"}`;
  function expectNoKeyFragment(out: string): void {
    for (let i = 0; i + 4 <= KEY.length; i++)
      expect(out).not.toContain(KEY.slice(i, i + 4));
  }
  test.each([
    ["8x &lt; before the key", `${"&lt;".repeat(8)} aws ${KEY}`],
    ["&amp; before the key", `a &amp; b aws ${KEY}`],
    [
      "double-encoded entities before the key",
      `${"&amp;lt;".repeat(8)} aws ${KEY}`,
    ],
    ["an entity-encoded key", `aws &#65;&#75;&#73;&#65;${KEY.slice(4)}`],
  ])("a secret after entities is still redacted: %s", async (_name, c) => {
    const r = await run(`<!-- ${c} -->`);
    expect(r?.status).toBe("warn");
    const item = r!.items![0]!;
    expect((item.meta as { signals: string[] }).signals).toContain("secret");
    expect(item.snippet).toContain(REDACTED);
    expectNoKeyFragment(item.snippet!);
    expectNoKeyFragment(JSON.stringify(r));
  });
});

describe("output", () => {
  test("snippet is bounded and the finding names the page", async () => {
    const r = await run(`<!-- TODO ${"lorem ipsum ".repeat(500)} -->`);
    const item = r!.items![0]!;
    expect(item.snippet!.length).toBeLessThanOrEqual(SNIPPET_MAX_LENGTH);
    expect(item.label).toContain(URL_);
    expect(r!.message).toContain(URL_);
  });

  test("the snippet shows the signal even deep in a long comment", async () => {
    const r = await run(`<!-- ${"filler ".repeat(200)} see 10.1.2.3 -->`);
    expect(r!.items![0]!.snippet).toContain("10.1.2.3");
  });
});

describe("no false positives", () => {
  test.each([
    [
      "IE conditional",
      '<!--[if lt IE 9]><script src="/html5shiv.js"></script><![endif]-->',
    ],
    ["downlevel-revealed", "<!--[if !IE]><!--><p>x</p><!--<![endif]-->"],
    ["Vue/Svelte boundaries", "<!--[--><p>x</p><!--]-->"],
    ["React boundary", "<!--$--><p>x</p><!--/$-->"],
    ["WordPress block", "<!-- wp:paragraph --><p>x</p><!-- /wp:paragraph -->"],
    [
      "GTM markers",
      "<!-- Google Tag Manager --><p>x</p><!-- End Google Tag Manager -->",
    ],
    ["empty", "<!---->"],
  ])("%s", async (_n, body) => {
    const r = await run(body);
    expect(r?.status).not.toBe("warn");
  });

  test("ordinary comment passes", async () => {
    const r = await run("<!-- Hero banner with the product photo -->");
    expect(r?.status).toBe("pass");
  });

  test("the page's own staging host is not flagged", async () => {
    const html = `<html><body><!-- served by staging.example.com --></body></html>`;
    const url = "https://staging.example.com/";
    const ctx = {
      page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
      parsed: parsePage(html, url),
      options: {},
    } as unknown as RuleContext;
    const r = (await htmlCommentExposureRule.run(ctx)).checks[0];
    expect(r?.status).toBe("pass");
  });

  test("a page with no comments passes, so a fixed page resolves its finding", async () => {
    expect((await run("<p>hi</p>"))?.status).toBe("pass");
  });
});
