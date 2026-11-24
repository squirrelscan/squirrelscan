// security/card-fields-third-party flags card number fields in the page's own
// document on a page that loads third-party scripts (pub#2088).

import { parsePage } from "@squirrelscan/parser";
import { describe, expect, test } from "bun:test";

import type { CheckResult, RuleContext } from "../src/types";

import { cardFieldsThirdPartyRule } from "../src/security/card-fields-third-party";

const URL_ = "https://shop.example.com/checkout";
const TAG_MANAGER = `<script src="https://cdn.tagvendor.net/snippet.js"></script>`;
const CHAT = `<script async src="https://widget.chatvendor.io/loader.js"></script>`;

function runAll(head: string, body: string): CheckResult[] {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Checkout</title>${head}</head><body>${body}</body></html>`;
  const ctx = {
    page: { url: URL_, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, URL_),
    options: {},
  } as unknown as RuleContext;
  const result = cardFieldsThirdPartyRule.run(ctx);
  if (result instanceof Promise) throw new Error("rule is synchronous");
  return result.checks;
}

/** No card field found: one unscored info check, no warning. */
function expectNoCardField(checks: CheckResult[]): void {
  expect(checks.map((c) => c.status)).toEqual(["info"]);
  expect(checks[0]?.details?.cardFields).toBe(0);
}

const form = (fields: string): string =>
  `<form method="post" action="/pay">${fields}<button>Pay</button></form>`;

describe("security/card-fields-third-party", () => {
  test.each([
    ['autocomplete="cc-number"', `<input autocomplete="cc-number" id="f1">`],
    [
      "section and billing autocomplete prefixes",
      `<input autocomplete="section-pay billing cc-number" id="f1">`,
    ],
    ["a name", `<input name="card_number">`],
    ["a camelCase id", `<input id="creditCardNumber" type="tel">`],
    ["a placeholder", `<input placeholder="Card number" type="text">`],
    ["a cc-num name", `<input name="ccnum" inputmode="numeric">`],
  ])("warns on a card number field identified by %s", (_label, field) => {
    const checks = runAll(TAG_MANAGER + CHAT, form(field));
    expect(checks).toHaveLength(1);
    const check = checks[0]!;
    expect(check.status).toBe("warn");
    expect(check.items).toHaveLength(1);
    // Names the third-party script hosts, sorted.
    expect(check.details?.thirdPartyScriptHosts).toEqual([
      "cdn.tagvendor.net",
      "widget.chatvendor.io",
    ]);
    expect(check.message).toContain("cdn.tagvendor.net, widget.chatvendor.io");
    // Names the field.
    expect(check.items?.[0]?.label).toMatch(/^Card number field input/);
    expect(check.items?.[0]?.label).toContain("cdn.tagvendor.net");
  });

  test("the finding states the risk and the fix", () => {
    const check = runAll(TAG_MANAGER, form(`<input name="cardnumber">`))[0]!;
    expect(check.message).toContain(
      "any script in the document can read what is typed"
    );
    expect(check.message).toContain("hosted fields");
    expect(check.message).toContain("remove third-party scripts");
  });

  test("the rule states its limit: it reads the fetched HTML only", () => {
    const { solution } = cardFieldsThirdPartyRule.meta;
    expect(solution).toContain("reads the HTML the audit fetched");
    expect(solution).toContain(
      "a card form that JavaScript builds after the page loads is not seen"
    );
  });

  test("the same card field with no third-party script passes", () => {
    const firstParty = [
      `<script src="/app.js"></script>`,
      `<script src="https://static.example.com/vendor.js"></script>`,
      `<script src="//shop.example.com/checkout.js"></script>`,
      `<script>window.x = 1</script>`,
    ].join("");
    const checks = runAll(firstParty, form(`<input name="card_number">`));
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("pass");
  });

  test("scripts that never execute are not third-party scripts", () => {
    const inert = [
      `<script type="application/ld+json" src="https://cdn.tagvendor.net/a.json"></script>`,
      `<script type="text/template" src="https://cdn.tagvendor.net/t.html"></script>`,
      `<noscript><script src="https://cdn.tagvendor.net/x.js"></script></noscript>`,
    ].join("");
    const checks = runAll(inert, form(`<input name="card_number">`));
    expect(checks[0]?.status).toBe("pass");
  });

  test("module scripts count as third-party scripts", () => {
    const checks = runAll(
      `<script type="module" src="https://cdn.tagvendor.net/m.js"></script>`,
      form(`<input name="card_number">`)
    );
    expect(checks[0]?.status).toBe("warn");
  });

  test("card fields inside a payment provider's cross-origin iframe get no finding", () => {
    const checks = runAll(
      `<script src="https://js.stripe.com/v3/"></script>` + TAG_MANAGER,
      form(
        `<input name="email" autocomplete="email"><div id="card-element"><iframe src="https://js.stripe.com/v3/elements-inner-card.html" title="Secure card payment input frame"></iframe></div>`
      )
    );
    expectNoCardField(checks);
  });

  test("a page with no card field gets an info check, not a finding", () => {
    expectNoCardField(runAll(TAG_MANAGER, form(`<input name="email">`)));
  });

  describe("false positives produce no finding", () => {
    test.each([
      [
        "a search box",
        `<input type="search" name="q" placeholder="Search credit cards">`,
      ],
      [
        "a text input in a search landmark",
        `<div role="search"><input name="q" placeholder="Find a credit card offer"></div>`,
      ],
      ["a search element", `<search><input name="credit_card_query"></search>`],
      ["a gift card number", `<input name="gift_card_number">`],
      [
        "a gift card placeholder",
        `<input name="card_number" placeholder="Gift card number">`,
      ],
      [
        "a voucher code",
        `<input name="voucher_code" placeholder="Voucher code">`,
      ],
      [
        "a loyalty card number",
        `<label for="lc">Loyalty card number</label><input id="lc" name="card_number">`,
      ],
      [
        "a rewards card number in a wrapping label",
        `<label>Rewards card <input name="cardNumber"></label>`,
      ],
      ["a membership card number", `<input id="membershipCardNumber">`],
      ["a hidden card field", `<input type="hidden" name="card_number">`],
      ["a disabled card field", `<input name="card_number" disabled>`],
      [
        "an autocomplete token that is not cc-number",
        `<input name="card_number_expiry" autocomplete="cc-exp">`,
      ],
      ["a word that merely contains card", `<input name="discard_reason">`],
    ])("%s", (_label, field) => {
      expectNoCardField(runAll(TAG_MANAGER, form(field)));
    });
  });

  test("autocomplete=cc-number wins over a gift-card-looking name", () => {
    const checks = runAll(
      TAG_MANAGER,
      form(`<input name="gift_card" autocomplete="cc-number">`)
    );
    expect(checks[0]?.status).toBe("warn");
  });

  test("a membership signup form that takes a real card is still flagged", () => {
    const checks = runAll(
      TAG_MANAGER,
      `<form id="membership-signup" action="/membership/join"><input name="card_number"></form>`
    );
    expect(checks[0]?.status).toBe("warn");
  });

  test("a script on another subdomain of the same site is first-party", () => {
    const checks = runAll(
      `<script src="https://cdn.example.com/app.js"></script>`,
      form(`<input autocomplete="cc-number">`)
    );
    expect(checks[0]?.status).toBe("pass");
  });
});
