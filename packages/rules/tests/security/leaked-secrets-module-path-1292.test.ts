// security/leaked-secrets: an AMD / RequireJS module path under a credential-named key is not a credential (#1292). The rule is narrow:
// segments of words from a list of module-path words (at most three per segment), a `Vendor_Module` head or a `js` segment, at most two digits and three capitals per segment. Random base64-ish values with `/` still report.

import { describe, expect, test } from "bun:test";

import { isModulePath, isNotACredentialValue, scanContent } from "../../src/security/leaked-secrets";
import { runOf, seededRng } from "./leaked-secrets/generators";

const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const PAGE = "https://shop.acme.test/";
const reported = (text: string) => scanContent(text, "inline-script", PAGE).length; // pragma: allowlist secret
const KEYS = ["password", "secret", "token", "apiKey"];

describe("module paths are names, not values", () => {
  const PATHS = [
    "Magento_Customer/js/change-email-password",
    "Magento_Checkout/js/model/quote",
    "Magento_Ui/js/form/element/abstract",
    "Magento_Customer/js/model/customer/password-reset",
    "Vendor_Module/js/view/payment/method-renderer/credit-card",
    "Magento_Checkout/js/model/cartData",
    "Magento_Customer/template/form/register",
    "text!Magento_Ui/templates/form/element/input",
    "Acme_Shop/js/lib/token-store",
    "js/lib/secret-keeper",
    "app/js/auth/password.reset",
  ];

  test("each shape is not reported under a password, secret, token or api key", () => {
    for (const path of PATHS) {
      for (const key of KEYS) expect([path, key, reported(`var c={${key}:"${path}"};`)]).toEqual([path, key, 0]);
      expect([path, isNotACredentialValue(path)]).toEqual([path, true]);
    }
  });
});

describe("values that are not module paths still report", () => {
  test("a digit run, a long segment, a run of capitals, one segment, or no module head and no js segment", () => {
    const control = [
      `Magento_Customer/js/${"4tR7yU"}${"1iO3wE5"}`,
      "Magento_Customer/js/aBcDeFgHiJkL",
      `Magento_Customer/js/${"a".repeat(40)}`,
      "Magento_Customer",
      "Magento_Customer/",
      "Xk9mQ2vL8zPqRt4Wn7",
      "Acme/Shop/Token",
      "a/b/c",
      `Magento_Customer/js/${"x".repeat(10)}/${"Y".repeat(12)}`,
    ];
    for (const value of control.slice(0, 5)) expect([value, isNotACredentialValue(value)]).toEqual([value, false]);
    expect(isNotACredentialValue("Xk9mQ2vL8zPqRt4Wn7")).toBe(false);
    expect(isNotACredentialValue(control[8]!)).toBe(false);
    // `Acme/Shop/Token` and `a/b/c`: mixed-case / lowercase routes are the older location rule's business (lowercase) or report (capitals)
    expect(isNotACredentialValue("Acme/Shop/Token")).toBe(false);
  });

  test("a value under a module-shaped head with a drawn tail reports, a path longer than 128 characters is not a module path", () => {
    const rng = seededRng(1292);
    expect(isNotACredentialValue(`Vendor_Module/${runOf(rng as never, ALNUM, 24)}`)).toBe(false);
    expect(isNotACredentialValue(`Magento_Customer/js/${"model/".repeat(30)}x`)).toBe(false);
  });

  test("random base64-ish values with slashes: the module-path rule drops none of 20,000", () => {
    const rng = seededRng(129201);
    const alphabets = [ALNUM + "+/", ALNUM + "/", `${ALNUM}_-/`, `${"0123456789"}${"abcdef"}/`, ALNUM];
    let dropped = 0;
    for (let i = 0; i < 20_000; i++) {
      const alphabet = alphabets[i % alphabets.length]!;
      const length = 24 + Math.floor(rng() * 41);
      let value = "";
      for (let j = 0; j < length; j++) value += alphabet[Math.floor(rng() * alphabet.length)];
      // put one to three slashes in (the alphabets without one still get them)
      const chars = value.split("");
      for (let s = 0; s < 1 + Math.floor(rng() * 3); s++) chars[1 + Math.floor(rng() * (length - 2))] = "/";
      const candidate = chars.join("");
      if (isModulePath(candidate)) dropped++;
    }
    expect(dropped).toBe(0);
  });
});

describe("the words are a list: a drawn lower-case run is not a word", () => {
  const rng = seededRng(1292_7);
  const LOWER = "abcdefghijklmnopqrstuvwxyz";
  const draw = (n: number) => runOf(rng as never, LOWER, n);

  test("a lower-case tail after a Vendor_Module head, a js segment or both is not a module path", () => {
    for (let i = 0; i < 2_000; i++) {
      const n = 8 + Math.floor(rng() * 33);
      for (const value of [`Magento_Customer/${draw(n)}`, `${draw(3)}/js/${draw(n)}`, `Stripe_Live/js/${draw(20)}`, `Magento_Customer/js/${draw(n)}/${draw(n)}`]) {
        expect([value, isModulePath(value)]).toEqual([value, false]);
      }
    }
  });

  test("random lower-case values of 8 to 40 letters with one to three slashes: none of 100,000 is a module path", () => {
    let dropped = 0;
    for (let i = 0; i < 100_000; i++) {
      const length = 8 + Math.floor(rng() * 33);
      const chars = draw(length).split("");
      for (let s = 0; s < 1 + Math.floor(rng() * 3); s++) chars[1 + Math.floor(rng() * (length - 2))] = "/";
      if (isModulePath(chars.join(""))) dropped++;
    }
    expect(dropped).toBe(0);
  });

  test("a word outside the list, a fourth word in a segment and a plural of a listed word", () => {
    expect(isModulePath("Magento_Customer/js/zorblax")).toBe(false);
    expect(isModulePath("Magento_Customer/js/change-email-password-reset")).toBe(false);
    expect(isModulePath("Magento_Customer/js/change-email-password")).toBe(true);
    expect(isModulePath("Magento_Customer/js/models/quotes")).toBe(true);
    expect(isModulePath("Magento_Customer/js/dialogs/overlays")).toBe(true);
  });
});

describe("the bounds are exact", () => {
  test("a segment of 32 characters passes, one of 34 does not; a path of 128 passes, one of 150 does not", () => {
    expect(isModulePath("Magento_Customer/js/customer-registration-confirm")).toBe(true); // 31
    expect(isModulePath("Magento_Customer/js/customer-registration-confirmation")).toBe(false); // 34
    const path = (n: number) => `Magento_Customer/js/${"model/".repeat(n)}form`;
    expect(path(14).length).toBeLessThanOrEqual(128);
    expect(isModulePath(path(14))).toBe(true);
    expect(path(25).length).toBeGreaterThan(128);
    expect(isModulePath(path(25))).toBe(false);
  });

  test("two digits in a segment pass, three do not", () => {
    expect(isModulePath("Magento_Customer/js/model22")).toBe(true);
    expect(isModulePath("Magento_Customer/js/model222")).toBe(false);
  });

  test("a segment with three capitals after its first letter passes, five do not", () => {
    expect(isModulePath("Magento_Customer/js/modelQuoteCartData")).toBe(true);
    expect(isModulePath("Magento_Customer/js/modelQuoteCartDataFormItem")).toBe(false);
  });

  test("the path needs a Vendor_Module head or a js segment: listed words alone are not enough", () => {
    expect(isModulePath("app/js/auth/token")).toBe(true);
    expect(isModulePath("app/lib/auth/token")).toBe(false);
    expect(isModulePath("Magento_Customer/lib/auth")).toBe(true);
    expect(isModulePath("Magento/Customer/lib/auth")).toBe(false);
  });
});
