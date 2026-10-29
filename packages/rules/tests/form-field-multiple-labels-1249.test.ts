// a11y/form-field-multiple-labels counts label ELEMENTS (HTMLInputElement.labels), so a label that
// wraps a control and also points at it with for= is one label (#1249).

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { formFieldMultipleLabelsRule } from "../src/a11y/form-field-multiple-labels";
import type { CheckResult, RuleContext } from "../src/types";

function run(body: string): CheckResult | undefined {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Gift card amount selection form test page</title></head><body><main>${body}</main></body></html>`;
  const url = "https://example.com/";
  const ctx = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    options: {},
  } as unknown as RuleContext;
  const result = formFieldMultipleLabelsRule.run(ctx);
  if (result instanceof Promise) throw new Error("form-field-multiple-labels is async");
  return result.checks.find((c) => c.name === "form-field-multiple-labels");
}

describe("a11y/form-field-multiple-labels counts label elements (#1249)", () => {
  test("the reporter's gift card page passes", () => {
    const result = run(`<h1>Gift card</h1><form><fieldset><legend>Amount</legend>
<label for="a"><input type="radio" name="amt" id="a" value="50"> 50</label>
<label for="b"><input type="radio" name="amt" id="b" value="100"> 100</label>
</fieldset></form>`);
    expect(result?.status).toBe("pass");
    expect(result?.items).toBeUndefined();
  });

  test.each([
    ["wrap only", `<label><input id="x" type="text"> X</label>`],
    ["for only", `<label for="x">X</label><input id="x" type="text">`],
    ["wrap plus for to itself", `<label for="x"><input id="x" type="text"> X</label>`],
    [
      "wrap plus for, no id to match twice",
      `<label for="x"><input id="x" name="n" type="text"></label>`,
    ],
  ])("%s passes", (_name, body) => {
    expect(run(body)?.status).toBe("pass");
  });

  test("two label elements for one id still warn, with the real count", () => {
    const result = run(
      `<label for="y">One</label><label for="y">Two</label><input id="y" name="y" type="text">`,
    );
    expect(result?.status).toBe("warn");
    expect(result?.items?.[0]?.id).toBe("y (2 labels)");
  });

  test("a wrapping label plus a separate label for= still warns", () => {
    const result = run(
      `<label>Wrap <input id="z" name="z" type="text"></label><label for="z">Other</label>`,
    );
    expect(result?.status).toBe("warn");
    expect(result?.items?.[0]?.id).toBe("z (2 labels)");
  });

  test("a wrapping label whose for= points at another control does not label this one", () => {
    const result = run(
      `<label for="other">Other <input id="inner" name="inner" type="text"></label><input id="other" name="other" type="text"><label for="inner">Inner</label>`,
    );
    // `inner` is labelled by its for= label only; the wrapper belongs to `other`.
    expect(result?.status).toBe("pass");
  });

  test("a wrapping label labels only its first labelable control", () => {
    const result = run(
      `<label>Both <input id="p" name="p" type="text"><input id="q" name="q" type="text"></label><label for="q">Q</label>`,
    );
    expect(result?.status).toBe("pass");
  });

  test("an id with selector characters is matched literally", () => {
    const result = run(
      `<label for='a"]b'>A</label><label for='a"]b'>B</label><input id='a"]b' name="w" type="text">`,
    );
    expect(result?.status).toBe("warn");
    expect(result?.items?.[0]?.id).toBe("w (2 labels)");
  });
});
