// a11y/paste-inputs reports paste blocking on authentication fields only (squirrelscan/squirrelscan#2106).
//
// WCAG 2.2 success criterion 3.3.8 Accessible Authentication (Minimum) covers entering a password or a
// code, so the rule reports a password or one-time-code field whose inline onpaste handler cancels the
// paste, and leaves every other field alone, including a "confirm email" field and copy or cut blocking.

import { parsePage } from "@squirrelscan/parser";
import { describe, expect, test } from "bun:test";

import type { CheckResult, ParsedPage, RuleContext } from "../src/types";

import { pasteInputsRule } from "../src/a11y/paste-inputs";

async function run(body: string): Promise<CheckResult> {
  const html = `<!DOCTYPE html><html><head><title>t</title></head><body><form>${body}</form></body></html>`;
  const url = "https://example.com/";
  const ctx = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url) as ParsedPage,
    options: {},
  } as unknown as RuleContext;
  const checks = (await pasteInputsRule.run(ctx)).checks as CheckResult[];
  expect(checks).toHaveLength(1);
  return checks[0]!;
}

const items = (c: CheckResult) => (c.items ?? []).map((i) => i.id);

describe("a11y/paste-inputs (squirrelscan/squirrelscan#2106)", () => {
  test("a password field that blocks paste fails", async () => {
    const c = await run(
      `<input type="password" name="password" onpaste="return false">`
    );
    expect(c.status).toBe("fail");
    expect(items(c)).toEqual(["password (type=password)"]);
  });

  test.each([
    "one-time-code",
    "current-password",
    "new-password",
    "section-login one-time-code",
  ])(
    'a field with autocomplete="%s" that blocks paste fails',
    async (token) => {
      const c = await run(
        `<input type="text" inputmode="numeric" name="code" autocomplete="${token}" onpaste="event.preventDefault()">`
      );
      expect(c.status).toBe("fail");
      expect(items(c)).toEqual([
        `code (autocomplete=${token.split(" ").pop()})`,
      ]);
    }
  );

  test('a "confirm email" field that blocks paste is not reported', async () => {
    const c = await run(
      `<input type="email" name="email" autocomplete="email">` +
        `<input type="email" name="confirm-email" onpaste="return false" oncopy="return false" oncut="return false">`
    );
    expect(c.status).toBe("info");
    expect(c.items).toBeUndefined();
  });

  test("copy or cut blocking on a password field is not reported", async () => {
    const c = await run(
      `<input type="password" name="pw" oncopy="return false" oncut="return false">`
    );
    expect(c.status).toBe("pass");
    expect(c.details).toEqual({ inputsChecked: 1 });
  });

  test("only the authentication field is listed beside a paste-blocking confirm email field", async () => {
    const c = await run(
      `<input type="email" name="confirm-email" onpaste="return false">` +
        `<input type="password" id="new-pw" autocomplete="new-password" onpaste="return!1">`
    );
    expect(c.status).toBe("fail");
    expect(items(c)).toEqual(["new-pw (type=password)"]);
  });

  test("a hidden input carrying an auth token is not an authentication field", async () => {
    const c = await run(
      `<input type="hidden" name="otp" autocomplete="one-time-code" onpaste="return false">`
    );
    expect(c.status).toBe("info");
  });
});
