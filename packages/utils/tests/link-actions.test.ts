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

  test("tokens as query keys, in matrix parameters, behind an encoded slash, and ids are masked", () => {
    expect(maskLinkTokens("https://m.example/unsubscribe?0123456789abcdef0123456789abcdef")).toBe(
      "https://m.example/unsubscribe?…=…",
    );
    expect(maskLinkTokens("https://m.example/logout;jsessionid=0123456789ABCDEF0123")).toBe(
      "https://m.example/…",
    );
    expect(maskLinkTokens("https://m.example/a%2F0123456789abcdef0123/unsubscribe")).toBe(
      "https://m.example/…/unsubscribe",
    );
    expect(
      maskLinkTokens("https://m.example/unsubscribe/123e4567-e89b-12d3-a456-426614174000"),
    ).toBe("https://m.example/unsubscribe/…");
    expect(maskLinkTokens("https://m.example/u/Ab3dE9xY/")).toBe("https://m.example/u/…/");
    // A file name keeps its name: it says where the link points.
    expect(maskLinkTokens("https://cdn.example/report2024.pdf?sig=x")).toBe(
      "https://cdn.example/report2024.pdf?sig=…",
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
