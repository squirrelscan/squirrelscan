// security/leaked-secrets: an AMD / RequireJS module path under a credential-named key is not a credential (#1292). The rule is narrow:
// short word segments, a `Vendor_Module` head or a `js` segment, no digit runs or mixed-case runs. Random base64-ish values with `/` still report.

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
