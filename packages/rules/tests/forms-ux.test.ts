// Forms UX rules: a11y/autocomplete-tokens, a11y/input-types, and the
// security/form-https extension that tells an HTTPS-page downgrade apart from
// a form on an already-insecure page.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { autocompleteTokensRule } from "../src/a11y/autocomplete-tokens";
import { inputTypesRule } from "../src/a11y/input-types";
import { formHttpsRule } from "../src/security/form-https";
import type { CheckResult, RuleContext } from "../src/types";

function ctx(html: string, url = "https://example.com/checkout"): RuleContext {
  return {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    options: {},
  } as unknown as RuleContext;
}

function page(bodyHtml: string): string {
  return `<!DOCTYPE html><html><head><title>t</title></head><body>${bodyHtml}</body></html>`;
}

function check(checks: CheckResult[], name: string): CheckResult | undefined {
  return checks.find((c) => c.name === name);
}

function itemIds(result: CheckResult | undefined): string[] {
  return (result?.items ?? []).map((i) => i.id);
}

// A checkout form marked up the way the docs ask for: typed inputs, full
// autocomplete tokens, keyboard hints, an HTTPS action. Nothing here may be
// reported by any of the three rules — this is the no-false-positive fixture.
const CLEAN_CHECKOUT = `<form id="checkout" action="https://pay.example.com/charge">
  <label for="fname">First name</label>
  <input id="fname" name="firstName" type="text" autocomplete="given-name" enterkeyhint="next" required>
  <label for="lname">Last name</label>
  <input id="lname" name="lastName" type="text" autocomplete="family-name" enterkeyhint="next" required>
  <label for="email">Email</label>
  <input id="email" name="email" type="email" autocomplete="email" enterkeyhint="next" required>
  <label for="phone">Phone</label>
  <input id="phone" name="phone" type="tel" autocomplete="tel" enterkeyhint="next">
  <label for="address1">Address line 1</label>
  <input id="address1" name="addressLine1" type="text" autocomplete="shipping address-line1" enterkeyhint="next">
  <label for="city">City</label>
  <input id="city" name="city" type="text" autocomplete="shipping address-level2" enterkeyhint="next">
  <label for="zip">ZIP code</label>
  <input id="zip" name="postalCode" type="text" inputmode="numeric" autocomplete="shipping postal-code" enterkeyhint="next">
  <label for="country">Country</label>
  <select id="country" name="country" autocomplete="shipping country"><option>US</option></select>
  <label for="cc">Card number</label>
  <input id="cc" name="cardNumber" type="text" inputmode="numeric" autocomplete="cc-number" enterkeyhint="next" required>
  <label for="ccexp">Expiry</label>
  <input id="ccexp" name="cardExpiry" type="text" inputmode="numeric" autocomplete="cc-exp" enterkeyhint="next" required>
  <label for="cvv">Security code</label>
  <input id="cvv" name="cvv" type="text" inputmode="numeric" autocomplete="cc-csc" enterkeyhint="done" required>
  <button type="submit">Pay</button>
</form>`;

describe("forms UX — correctly marked-up checkout stays clean", () => {
  const html = page(CLEAN_CHECKOUT);

  test("a11y/autocomplete-tokens passes", () => {
    const result = check(autocompleteTokensRule.run(ctx(html)).checks, "autocomplete-tokens");
    expect(result?.status).toBe("pass");
    expect(result?.items).toBeUndefined();
  });

  test("a11y/input-types reports nothing on any of its three checks", () => {
    const { checks } = inputTypesRule.run(ctx(html));
    expect(check(checks, "input-types")?.status).toBe("pass");
    expect(check(checks, "enterkeyhint")?.status).toBe("pass");
    // No novalidate anywhere, so the intent check has nothing to judge.
    expect(check(checks, "form-novalidate")?.status).toBe("skipped");
    for (const c of checks) {
      expect(c.status === "warn" || c.status === "fail").toBe(false);
    }
  });

  test("security/form-https passes", () => {
    expect(check(formHttpsRule.run(ctx(html)).checks, "form-https")?.status).toBe("pass");
  });
});

describe("a11y/autocomplete-tokens", () => {
  test("warn: identified fields carry no token at all", () => {
    const html = page(`<form action="/contact">
      <label for="n">Full name</label><input id="n" name="fullName" type="text">
      <label for="e">Email</label><input id="e" name="email" type="email">
      <label for="p">Phone</label><input id="p" name="phone" type="tel">
    </form>`);
    const result = check(autocompleteTokensRule.run(ctx(html)).checks, "autocomplete-tokens");
    expect(result?.status).toBe("warn");
    expect(itemIds(result)).toEqual(["input#n", "input#e", "input#p"]);
    expect(result?.details).toMatchObject({ fieldsChecked: 3, incorrect: 0, missing: 3 });
  });

  test("fail: a token that is not in the spec, and a token for the wrong purpose", () => {
    const html = page(`<form action="/signup">
      <label for="e">Email</label><input id="e" name="email" autocomplete="mail">
      <label for="f">First name</label><input id="f" name="firstName" autocomplete="family-name">
    </form>`);
    const result = check(autocompleteTokensRule.run(ctx(html)).checks, "autocomplete-tokens");
    expect(result?.status).toBe("fail");
    expect(itemIds(result)).toEqual(["input#e", "input#f"]);
    expect(result?.items?.[0]?.meta).toMatchObject({ reason: "invalid-token", expected: "email" });
    expect(result?.items?.[1]?.meta).toMatchObject({
      reason: "wrong-token",
      expected: "given-name",
      actual: "family-name",
    });
  });

  test("every item carries a selector and a snippet naming the exact node", () => {
    const html = page(`<form action="/x"><input id="e" name="email"></form>`);
    const result = check(autocompleteTokensRule.run(ctx(html)).checks, "autocomplete-tokens");
    expect(result?.items?.[0]?.id).toBe("input#e");
    expect(result?.items?.[0]?.snippet).toContain('name="email"');
  });

  test("skipped: no field on the page has an identifiable purpose", () => {
    const html = page(`<form action="/search" role="search">
      <label for="q">Search</label><input id="q" name="q" type="search">
      <button type="submit">Go</button>
    </form>`);
    const result = check(autocompleteTokensRule.run(ctx(html)).checks, "autocomplete-tokens");
    expect(result?.status).toBe("skipped");
    expect(result?.skipReason).toBe("no-identifiable-fields");
  });

  test("warn: autocomplete=off on a payment field is not an accepted answer", () => {
    const html = page(
      `<form action="/pay"><label for="cc">Card number</label><input id="cc" name="cardNumber" autocomplete="off"></form>`,
    );
    const result = check(autocompleteTokensRule.run(ctx(html)).checks, "autocomplete-tokens");
    expect(result?.status).toBe("warn");
    expect(result?.items?.[0]?.meta).toMatchObject({ reason: "disabled", expected: "cc-number" });
  });

  test("section-*, shipping/billing and contact prefixes are valid, not typos", () => {
    const html = page(`<form action="/x">
      <input id="a1" name="billingAddressLine1" autocomplete="section-payment billing address-line1">
      <input id="t1" name="phone" autocomplete="section-payment billing mobile tel">
      <input id="e1" name="email" autocomplete="section-payment billing home email">
    </form>`);
    const result = check(autocompleteTokensRule.run(ctx(html)).checks, "autocomplete-tokens");
    expect(result?.status).toBe("pass");
  });

  test("username is accepted on a login email field", () => {
    const html = page(
      `<form action="/login"><input id="e" name="email" type="email" autocomplete="username"><input type="password" name="password" autocomplete="current-password"></form>`,
    );
    expect(
      check(autocompleteTokensRule.run(ctx(html)).checks, "autocomplete-tokens")?.status,
    ).toBe("pass");
  });

  test("hidden, disabled and aria-hidden controls are not fields a user fills", () => {
    const html = page(`<form action="/x">
      <input type="hidden" name="email" value="a@b.c">
      <input name="firstName" disabled>
      <div aria-hidden="true"><input name="lastName"></div>
    </form>`);
    const result = check(autocompleteTokensRule.run(ctx(html)).checks, "autocomplete-tokens");
    expect(result?.status).toBe("skipped");
  });

  test("the submitted name outranks a weaker id or placeholder, not the PURPOSES order", () => {
    const html = page(
      `<form action="/x"><input id="email" name="firstName" placeholder="City"></form>`,
    );
    const result = check(autocompleteTokensRule.run(ctx(html)).checks, "autocomplete-tokens");
    expect(result?.items?.[0]?.meta).toMatchObject({ expected: "given-name" });
  });

  test("webauthn is only valid trailing a credential token", () => {
    const html = page(`<form action="/login">
      <input id="u" name="email" type="email" autocomplete="username webauthn">
      <input id="e" name="emailAddress" type="email" autocomplete="email webauthn">
    </form>`);
    const result = check(autocompleteTokensRule.run(ctx(html)).checks, "autocomplete-tokens");
    expect(result?.status).toBe("fail");
    expect(itemIds(result)).toEqual(["input#e"]);
    expect(result?.items?.[0]?.meta).toMatchObject({ reason: "invalid-token" });
  });

  test("purpose matching is segment-based: capacity is not a city, hotel is not a phone", () => {
    const html = page(`<form action="/x">
      <label for="c">Capacity</label><input id="c" name="capacity" type="text">
      <label for="h">Hotel</label><input id="h" name="hotel" type="text">
      <label for="m">Mailing list name</label><input id="m" name="mailingListName" type="text">
    </form>`);
    const result = check(autocompleteTokensRule.run(ctx(html)).checks, "autocomplete-tokens");
    expect(result?.status).toBe("skipped");
  });
});

describe("a11y/input-types — the right type", () => {
  test("warn: type=text where email, tel, url and number are correct", () => {
    const html = page(`<form action="/x">
      <label for="e">Email</label><input id="e" name="email" type="text">
      <label for="p">Phone</label><input id="p" name="phone" type="text">
      <label for="w">Website</label><input id="w" name="website" type="text">
      <label for="q">Quantity</label><input id="q" name="quantity" type="text">
    </form>`);
    const result = check(inputTypesRule.run(ctx(html)).checks, "input-types");
    expect(result?.status).toBe("warn");
    expect(itemIds(result)).toEqual(["input#e", "input#p", "input#w", "input#q"]);
    expect(result?.items?.map((i) => i.meta?.expected)).toEqual(["email", "tel", "url", "number"]);
  });

  test("fail: type=number on a digit string mangles leading zeros", () => {
    const html = page(`<form action="/x">
      <label for="z">ZIP code</label><input id="z" name="postalCode" type="number">
      <label for="cc">Card number</label><input id="cc" name="cardNumber" type="number">
    </form>`);
    const result = check(inputTypesRule.run(ctx(html)).checks, "input-types");
    expect(result?.status).toBe("fail");
    expect(itemIds(result)).toEqual(["input#z", "input#cc"]);
    expect(result?.items?.[0]?.meta).toMatchObject({ reason: "number-hostile" });
  });

  test("inputmode already delivers the keyboard, so text is a deliberate choice", () => {
    const html = page(
      `<form action="/x"><label for="p">Phone</label><input id="p" name="phone" type="text" inputmode="tel"></form>`,
    );
    expect(check(inputTypesRule.run(ctx(html)).checks, "input-types")?.status).toBe("pass");
  });

  test("the escape hatch survives a camelCase inputMode (#1507)", () => {
    // squirrelscan.com's own tools pages: React passes inputMode straight
    // through, the exemption read "inputmode", missed it, and the rule warned
    // on correct markup across five pages.
    const html = page(
      `<form action="/x"><label for="u">Site URL</label><input id="u" name="websiteUrl" type="text" inputMode="url"></form>`,
    );
    expect(check(inputTypesRule.run(ctx(html)).checks, "input-types")?.status).toBe("pass");
  });

  test("skipped: no input on the page implies a particular type", () => {
    const html = page(
      `<form action="/x"><label for="m">Message</label><textarea id="m" name="message"></textarea><input id="n" name="fullName" type="text" autocomplete="name"></form>`,
    );
    const result = check(inputTypesRule.run(ctx(html)).checks, "input-types");
    expect(result?.status).toBe("skipped");
    expect(result?.skipReason).toBe("no-typed-inputs");
  });
});

describe("a11y/input-types — enterkeyhint", () => {
  const threeFields = `<form id="signup" action="/x">
    <input name="alpha" type="text"><input name="beta" type="text"><input name="gamma" type="text">
    <button type="submit">Go</button>
  </form>`;

  test("warn: a multi-field form with no keyboard hint anywhere", () => {
    const result = check(inputTypesRule.run(ctx(page(threeFields))).checks, "enterkeyhint");
    expect(result?.status).toBe("warn");
    expect(itemIds(result)).toEqual(["form#signup"]);
    expect(result?.items?.[0]?.meta).toMatchObject({ reason: "missing-enterkeyhint", fields: 3 });
  });

  test("pass: one hint on the form is enough to show the intent", () => {
    const html = page(threeFields.replace('name="gamma"', 'name="gamma" enterkeyhint="done"'));
    expect(check(inputTypesRule.run(ctx(html)).checks, "enterkeyhint")?.status).toBe("pass");
  });

  test("skipped: a two-field login is not a multi-field form", () => {
    const html = page(`<form action="/login">
      <input name="username" type="text"><input name="password" type="password">
      <button type="submit">Sign in</button>
    </form>`);
    const result = check(inputTypesRule.run(ctx(html)).checks, "enterkeyhint");
    expect(result?.status).toBe("skipped");
    expect(result?.skipReason).toBe("no-multi-field-forms");
  });

  test("submit buttons and hidden inputs do not pad a form to multi-field", () => {
    const html = page(`<form action="/x">
      <input name="alpha" type="text"><input type="hidden" name="csrf" value="x">
      <input type="submit" value="Go"><input type="reset" value="Reset">
    </form>`);
    expect(check(inputTypesRule.run(ctx(html)).checks, "enterkeyhint")?.status).toBe("skipped");
  });
});

describe("a11y/input-types — novalidate intent", () => {
  test("warn: novalidate on a form that still declares constraints and ships no replacement", () => {
    const html = page(`<form id="signup" action="/signup" novalidate>
      <label for="e">Email</label><input id="e" name="email" type="email" autocomplete="email" required>
      <input id="p" name="password" type="password" required>
      <button type="submit">Join</button>
    </form>`);
    const result = check(inputTypesRule.run(ctx(html)).checks, "form-novalidate");
    expect(result?.status).toBe("warn");
    expect(itemIds(result)).toEqual(["form#signup"]);
  });

  test("not every occurrence: an error region in the form means validation was replaced", () => {
    const html = page(`<form id="signup" action="/signup" novalidate>
      <label for="e">Email</label><input id="e" name="email" type="email" autocomplete="email" required aria-invalid="false">
      <div role="alert" id="err"></div>
      <button type="submit">Join</button>
    </form>`);
    expect(check(inputTypesRule.run(ctx(html)).checks, "form-novalidate")?.status).toBe("pass");
  });

  test("not every occurrence: a page that calls checkValidity itself", () => {
    const html = page(`<form id="signup" action="/signup" novalidate>
      <label for="e">Email</label><input id="e" name="email" type="email" autocomplete="email" required>
      <button type="submit">Join</button>
    </form>
    <script>document.getElementById('signup').addEventListener('submit', function (e) { if (!e.target.checkValidity()) e.preventDefault(); });</script>`);
    expect(check(inputTypesRule.run(ctx(html)).checks, "form-novalidate")?.status).toBe("pass");
  });

  test("not every occurrence: novalidate on a form with no constraints to disable", () => {
    const html = page(
      `<form action="/search" novalidate><input name="q" type="text"><button type="submit">Go</button></form>`,
    );
    expect(check(inputTypesRule.run(ctx(html)).checks, "form-novalidate")?.status).toBe("pass");
  });

  test("skipped: no form on the page sets novalidate", () => {
    const html = page(`<form action="/x"><input name="q" type="text" required></form>`);
    const result = check(inputTypesRule.run(ctx(html)).checks, "form-novalidate");
    expect(result?.status).toBe("skipped");
    expect(result?.skipReason).toBe("no-novalidate-forms");
  });
});

describe("security/form-https", () => {
  test("fail: an HTTPS page whose form action points at http://", () => {
    const html = page(`<form id="pay" action="http://pay.example.com/charge"><input name="cardNumber"></form>`);
    const result = check(formHttpsRule.run(ctx(html, "https://example.com/checkout")).checks, "form-https");
    expect(result?.status).toBe("fail");
    expect(itemIds(result)).toEqual(["form#pay"]);
    expect(result?.items?.[0]?.meta).toMatchObject({ reason: "https-page-http-action" });
    expect(result?.details).toMatchObject({ downgrades: 1 });
  });

  test("warn: the same action on a page that is itself served over http", () => {
    const html = page(`<form id="pay" action="http://pay.example.com/charge"><input name="cardNumber"></form>`);
    const result = check(formHttpsRule.run(ctx(html, "http://example.com/checkout")).checks, "form-https");
    expect(result?.status).toBe("warn");
    expect(result?.items?.[0]?.meta).toMatchObject({ reason: "http-action" });
    expect(result?.details).toMatchObject({ downgrades: 0 });
  });

  test("fail: a submit button's formaction downgrades the submission", () => {
    const html = page(
      `<form id="pay" action="/charge"><input name="cardNumber"><button type="submit" formaction="http://pay.example.com/charge">Pay</button></form>`,
    );
    const result = check(formHttpsRule.run(ctx(html, "https://example.com/checkout")).checks, "form-https");
    expect(result?.status).toBe("fail");
    expect(result?.items?.[0]?.meta).toMatchObject({ attribute: "formaction" });
  });

  test("formaction only counts on a control that actually submits", () => {
    const html = page(`<form id="pay" action="/charge"><input name="cardNumber">
      <button type="button" formaction="http://a.example.com/x">Cancel</button>
      <div formaction="http://b.example.com/x">Not a control</div>
    </form>`);
    expect(
      check(formHttpsRule.run(ctx(html, "https://example.com/checkout")).checks, "form-https")
        ?.status,
    ).toBe("pass");
  });

  test("an unparseable http:// action is still an insecure submission", () => {
    const html = page(`<form id="pay" action="http://["><input name="cardNumber"></form>`);
    const result = check(
      formHttpsRule.run(ctx(html, "https://example.com/checkout")).checks,
      "form-https",
    );
    expect(result?.status).toBe("fail");
    expect(itemIds(result)).toEqual(["form#pay"]);
  });

  test("a protocol-relative action inherits HTTPS from the page and is clean", () => {
    const html = page(`<form action="//pay.example.com/charge"><input name="cardNumber"></form>`);
    expect(
      check(formHttpsRule.run(ctx(html, "https://example.com/checkout")).checks, "form-https")
        ?.status,
    ).toBe("pass");
  });

  test("relative actions and non-network schemes are not the form's problem", () => {
    const html = page(`<form action="/charge"><input name="cardNumber"></form>
      <form action="mailto:sales@example.com"><input name="email"></form>
      <form action="javascript:void(0)"><input name="email"></form>`);
    expect(
      check(formHttpsRule.run(ctx(html, "http://example.com/checkout")).checks, "form-https")
        ?.status,
    ).toBe("pass");
  });

  test("info: nothing on the page submits anywhere", () => {
    const result = check(
      formHttpsRule.run(ctx(page(`<p>No forms here.</p>`))).checks,
      "form-https",
    );
    expect(result?.status).toBe("info");
  });
});
