import { describe, expect, test } from "bun:test";

import { detectTechnologies } from "../src";

function detectsClerk(content: string): boolean {
  return detectTechnologies({
    url: "https://example.com/",
    headers: {},
    html: "",
    scripts: [{ url: "https://example.com/app.js", content }],
  }).some((technology) => technology.id === "clerk");
}

describe("Clerk publishable-key detection (#1478)", () => {
  test("does not mistake Stripe publishable keys for Clerk", () => {
    expect(detectsClerk('stripe={publishableKey:"pk_live_51Qabcdefghijklmnopqrstuv"}')).toBeFalse();
    expect(detectsClerk('stripe={publishableKey:"pk_test_51Qabcdefghijklmnopqrstuv"}')).toBeFalse();
  });

  test("accepts a Clerk production key whose body decodes to a Clerk host", () => {
    expect(detectsClerk('config={publishableKey:"pk_live_Y2xlcmsuZXhhbXBsZS5jb20k"}')).toBeTrue();
  });

  test("accepts a Clerk development-instance key", () => {
    expect(
      detectsClerk(
        'config={publishableKey:"pk_test_c3Vubnktb3dsLTEyLmNsZXJrLmFjY291bnRzLmRldiQ="}',
      ),
    ).toBeTrue();
  });
});
