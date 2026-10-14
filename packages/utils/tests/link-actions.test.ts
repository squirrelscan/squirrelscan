// repo#2759: the link action and token rules, shared by the internal link
// probe and the external link checker, and the masking a report applies to a
// link it never requested.

import { describe, expect, test } from "bun:test";

import { linkTextLooksLikeAnAction, looksLikeAnAction, maskLinkTokens } from "../src/link-actions";

describe("maskLinkTokens", () => {
  test("every query value and token-like path segment is masked; the rest of the URL stays", () => {
    expect(maskLinkTokens("https://mail.example/unsubscribe?token=0123456789abcdef0123&u=7")).toBe(
      "https://mail.example/unsubscribe?token=…&u=…",
    );
    expect(
      maskLinkTokens(
        "https://auth.example/magic-login/eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2Q",
      ),
    ).toBe("https://auth.example/magic-login/…");
    expect(maskLinkTokens("https://app.example/account/logout#top")).toBe(
      "https://app.example/account/logout",
    );
    expect(maskLinkTokens("https://cdn.example:8443/a.pdf?sig=x")).toBe(
      "https://cdn.example:8443/a.pdf?sig=…",
    );
  });

  test("a URL that does not parse is fully masked", () => {
    expect(maskLinkTokens("not a url")).toBe("…");
  });
});

describe("the rules moved here unchanged", () => {
  test("still classify as the internal link probe did", () => {
    expect(looksLikeAnAction("https://example.com/logout")).toBe(true);
    expect(looksLikeAnAction("https://example.com/blog/how-to-verify-your-domain")).toBe(false);
    expect(linkTextLooksLikeAnAction("Log out", false)).toBe(true);
    expect(linkTextLooksLikeAnAction("Buy on Amazon", false)).toBe(false);
  });
});
