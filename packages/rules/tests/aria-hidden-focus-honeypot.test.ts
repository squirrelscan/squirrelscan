// a11y/aria-hidden-focus — honeypot annotation, issue #1100.
//
// scramnews.com's anti-spam honeypot input (input#pp-contact-hp, hidden via
// aria-hidden so screen readers skip it, left focusable so the WCAG issue is
// real) errored with no context. The finding must stay (it's a genuine
// keyboard-trap issue) but honeypot-matched elements get annotated and
// downgraded to warning, while unrelated focusable-in-aria-hidden content
// keeps failing at error severity.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { ariaHiddenFocusRule } from "../src/a11y/aria-hidden-focus";
import type { ParsedPage, RuleContext } from "../src/types";

function pageCtx(html: string, url = "https://example.com/"): RuleContext {
  return {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url) as ParsedPage,
    options: {},
  };
}

function run(ctx: RuleContext): CheckResult[] {
  return ariaHiddenFocusRule.run(ctx).checks as CheckResult[];
}

function check(checks: CheckResult[], name: string): CheckResult | undefined {
  return checks.find((c) => c.name === name);
}

describe("a11y/aria-hidden-focus — honeypot annotation (#1100)", () => {
  test("honeypot input (id matching hp, inside a form) is annotated and downgraded to warning", () => {
    const html = `<html><body>
      <form action="/contact" method="post">
        <input type="text" name="name">
        <div aria-hidden="true"><input type="text" id="pp-contact-hp" name="pp-contact-hp"></div>
        <button type="submit">Send</button>
      </form>
    </body></html>`;
    const checks = run(pageCtx(html));

    expect(check(checks, "aria-hidden-focus")).toBeUndefined();
    const honeypot = check(checks, "aria-hidden-focus-honeypot");
    expect(honeypot?.status).toBe("warn");
    expect(honeypot?.message).toContain("anti-spam honeypot");
    expect(honeypot?.value).toContain('tabindex="-1"');
    expect(honeypot?.value).toContain("autocomplete");
    expect(honeypot?.items?.[0]?.id).toBe("input#pp-contact-hp");
  });

  test("regular focusable-in-aria-hidden content (not a honeypot) still errors", () => {
    const html = `<html><body>
      <div aria-hidden="true"><a href="/promo">Hidden promo link</a></div>
    </body></html>`;
    const checks = run(pageCtx(html));

    const fail = check(checks, "aria-hidden-focus");
    expect(fail?.status).toBe("fail");
    expect(check(checks, "aria-hidden-focus-honeypot")).toBeUndefined();
  });

  test("honeypot-named input outside a form is NOT downgraded (form context required)", () => {
    const html = `<html><body>
      <div aria-hidden="true"><input type="text" id="standalone-hp"></div>
    </body></html>`;
    const checks = run(pageCtx(html));

    expect(check(checks, "aria-hidden-focus")?.status).toBe("fail");
    expect(check(checks, "aria-hidden-focus-honeypot")).toBeUndefined();
  });

  test("focusable input in a form without a honeypot-style name is NOT downgraded (name/id required)", () => {
    const html = `<html><body>
      <form action="/contact" method="post">
        <div aria-hidden="true"><input type="text" id="newsletter-opt-in"></div>
      </form>
    </body></html>`;
    const checks = run(pageCtx(html));

    expect(check(checks, "aria-hidden-focus")?.status).toBe("fail");
    expect(check(checks, "aria-hidden-focus-honeypot")).toBeUndefined();
  });

  test("a real a11y error and a honeypot on the same page both report, at their own severities", () => {
    const html = `<html><body>
      <div aria-hidden="true"><a href="/promo">Hidden promo link</a></div>
      <form action="/contact" method="post">
        <div aria-hidden="true"><input type="text" name="honeypot"></div>
      </form>
    </body></html>`;
    const checks = run(pageCtx(html));

    expect(check(checks, "aria-hidden-focus")?.status).toBe("fail");
    expect(check(checks, "aria-hidden-focus-honeypot")?.status).toBe("warn");
  });

  test("aria-hidden self-focusable honeypot input is also recognized", () => {
    const html = `<html><body>
      <form action="/contact" method="post">
        <input type="text" id="trap-field" aria-hidden="true">
      </form>
    </body></html>`;
    const checks = run(pageCtx(html));

    expect(check(checks, "aria-hidden-focus")).toBeUndefined();
    expect(check(checks, "aria-hidden-focus-honeypot")?.status).toBe("warn");
  });

  test("no aria-hidden elements → info (regression)", () => {
    const checks = run(pageCtx(`<html><body><p>plain page</p></body></html>`));
    expect(check(checks, "aria-hidden-focus")?.status).toBe("info");
  });

  test("aria-hidden present with no focusable content → pass (regression)", () => {
    const html = `<html><body><div aria-hidden="true"><p>decorative</p></div></body></html>`;
    const checks = run(pageCtx(html));
    expect(check(checks, "aria-hidden-focus")?.status).toBe("pass");
  });
});
