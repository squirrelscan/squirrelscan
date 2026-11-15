// a11y/label-content-name-mismatch: adjacent children and full item text (#1876).

import { parsePage } from "@squirrelscan/parser";
import { describe, expect, test } from "bun:test";

import { labelContentNameMismatchRule } from "../src/a11y/label-content-name-mismatch";
import type { CheckResult, RuleContext } from "../src/types";

function run(body: string): CheckResult[] {
  const html = `<!doctype html><html lang="en"><head><title>t</title></head><body><main>${body}</main></body></html>`;
  const url = "https://example.com/";
  const ctx = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    options: {},
  } as unknown as RuleContext;
  const result = labelContentNameMismatchRule.run(ctx);
  if (result instanceof Promise) throw new Error("async");
  return result.checks;
}

const failing = (checks: CheckResult[]) => checks.find((c) => c.status === "fail");

describe("label-content-name-mismatch (#1876)", () => {
  test("two adjacent spans with a spaced aria-label pass", () => {
    const checks = run(
      '<a href="/" aria-label="Saint John the Baptist Example Church"><span class="line1">Saint John the Baptist</span><span class="line2">Example Church</span></a>',
    );
    expect(failing(checks)).toBeUndefined();
  });

  test("a real mismatch still fails", () => {
    const checks = run('<button aria-label="Find products">Search</button>');
    expect(failing(checks)?.items?.length).toBe(1);
  });

  test("items sharing a 20 character prefix show where they differ", () => {
    const checks = run(
      '<a href="/" aria-label="Saint John the Baptist Church">Saint John the Baptist Example Church</a>',
    );
    const item = failing(checks)?.items?.[0] as { id: string };
    expect(item.id).toContain('visible="saint john the baptist example church"');
    expect(item.id).toContain('aria-label="saint john the baptist church"');
  });

  test("item text is bounded", () => {
    const long = "word ".repeat(60).trim();
    const checks = run(`<button aria-label="zzz">${long}</button>`);
    const item = failing(checks)?.items?.[0] as { id: string };
    expect(item.id.length).toBeLessThan(300);
  });
});
