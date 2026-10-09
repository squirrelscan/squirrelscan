// content/meta-in-body — microdata `<meta itemprop>` exemption (#490).

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { metaInBodyRule } from "../src/content/meta-in-body";
import type { CheckResult, RuleContext } from "../src/types";

const URL = "https://example.com/";

function makeCtx(html: string): RuleContext {
  const parsed = parsePage(html, URL);
  return {
    page: { url: URL, html, statusCode: 200, loadTime: 0, headers: {}, parsed },
    parsed,
    options: {},
  };
}

function page(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shirt | Brand</title></head><body>${body}</body></html>`;
}

function run(body: string): CheckResult {
  const checks = (metaInBodyRule.run(makeCtx(page(body))) as { checks: CheckResult[] }).checks;
  expect(checks).toHaveLength(1);
  return checks[0] as CheckResult;
}

const MICRODATA = `<h1>Shirt</h1>
<div itemscope itemtype="https://schema.org/Product">
  <meta itemprop="name" content="Shirt">
  <meta itemprop="description" content="Organic cotton shirt">
  <div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
    <meta itemprop="priceCurrency" content="EUR">
    <meta itemprop="price" content="29.90">
  </div>
</div>`;

describe("content/meta-in-body", () => {
  test("passes: reporter repro with only microdata metas", () => {
    const c = run(MICRODATA);
    expect(c.status).toBe("pass");
    expect(c.items).toBeUndefined();
  });

  test("fails with exactly 1 item when a name meta sits among microdata", () => {
    const c = run(`${MICRODATA}<meta name="description" content="Oops">`);
    expect(c.status).toBe("fail");
    expect(c.items).toHaveLength(1);
    expect(c.message).toBe("Found 1 meta tag(s) in <body>");
    expect(c.items?.[0]?.id).toBe("description");
    expect(c.items?.some((i) => i.label.startsWith("unknown"))).toBe(false);
  });

  test("fails: itemprop combined with name is not exempt", () => {
    const c = run(`<meta name="x" itemprop="y" content="z">`);
    expect(c.status).toBe("fail");
    expect(c.items).toHaveLength(1);
  });

  test("fails: itemprop combined with http-equiv is not exempt", () => {
    const c = run(`<meta http-equiv="refresh" itemprop="y" content="5">`);
    expect(c.status).toBe("fail");
  });

  test("fails: itemprop combined with charset is not exempt", () => {
    const c = run(`<meta charset="utf-8" itemprop="y">`);
    expect(c.status).toBe("fail");
  });

  test("still fails: meta property in the body", () => {
    const c = run(`<meta property="og:title" content="Shirt">`);
    expect(c.status).toBe("fail");
    expect(c.items?.[0]?.id).toBe("og:title");
  });

  test("still fails: RDFa meta property under an RDFa ancestor", () => {
    const c = run(
      `<div vocab="https://schema.org/" typeof="Product"><meta property="name" content="Shirt"></div>`,
    );
    expect(c.status).toBe("fail");
    expect(c.items).toHaveLength(1);
  });

  test("passes: itemprop combined with property is exempt (triage: only name, http-equiv, charset block it)", () => {
    const c = run(`<meta itemprop="name" property="name" content="Shirt">`);
    expect(c.status).toBe("pass");
  });

  test("passes: page with no body metas", () => {
    const c = run(`<h1>Shirt</h1>`);
    expect(c.status).toBe("pass");
    expect(c.message).toBe("All meta tags correctly placed in <head>");
  });
});

describe("content/meta-in-body wording is count-independent (#231)", () => {
  test("one and several body metas share one message form", () => {
    expect(run(`<meta name="description" content="Oops">`).message).toBe("Found 1 meta tag(s) in <body>");
    expect(run(`<meta name="description" content="Oops"><meta name="robots" content="index">`).message).toBe(
      "Found 2 meta tag(s) in <body>",
    );
  });
});
