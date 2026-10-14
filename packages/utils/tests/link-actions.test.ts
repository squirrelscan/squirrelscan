// repo#2759: the link action and token rules, shared by the internal link
// probe and the external link checker, and the masking a report applies to a
// link it never requested.

import { describe, expect, test } from "bun:test";

import {
  CREDENTIAL_PARAM_NAMES,
  isCredentialParam,
  linkTextLooksLikeAnAction,
  looksLikeAnAction,
  maskLinkTokens,
} from "../src/link-actions";

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

  test("ordinary paths and slugs keep their shape", () => {
    for (const path of [
      "/blog/2024/10/post-title",
      "/p/12345",
      "/en-us/",
      "/blog/top-10-tips/logout",
      "/iphone-15-pro",
    ]) {
      expect(maskLinkTokens(`https://site.example${path}`)).toBe(`https://site.example${path}`);
    }
    expect(maskLinkTokens(`https://site.example/a?${"k".repeat(41)}=1`)).toBe(
      "https://site.example/a?…=…",
    );
    expect(maskLinkTokens("https://site.example/%E0%A4%A/logout")).toBe(
      "https://site.example/…/logout",
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

describe("a sign-out written as several words (#774)", () => {
  test("inside a camelCase name, or a hyphenated segment of five words, is an action", () => {
    for (const path of [
      "/MyAccountLogOut.aspx",
      "/my-account-log-out-now",
      "/UserSignOut",
      "/portal/AccountLogOff.do",
      "/?next=MyAccountSignOut",
    ]) {
      expect(looksLikeAnAction(`https://x.test${path}`)).toBe(true);
    }
  });

  test("a long slug that mentions one, and names that only contain the letters, are pages", () => {
    for (const path of [
      "/blog/how-to-log-out-of-every-device",
      "/BlogOutreachTips",
      "/DesignOfficeIdeas",
      "/catalog-outlet",
    ]) {
      expect(looksLikeAnAction(`https://x.test${path}`)).toBe(false);
    }
  });
});

describe("credential query parameters (#774)", () => {
  test("every name on the list makes the URL one that is never requested, in any case", () => {
    for (const name of CREDENTIAL_PARAM_NAMES) {
      expect(looksLikeAnAction(`https://x.test/page?${name}=abc`)).toBe(true);
      expect(looksLikeAnAction(`https://x.test/page?${name.toUpperCase()}=abc`)).toBe(true);
    }
    for (const name of [
      "api_key",
      "x-api-key",
      "pwd",
      "session_id",
      "accesstoken",
      "authorization",
      "jwt",
      "x-amz-credential",
      "x-goog-credential",
    ]) {
      expect(CREDENTIAL_PARAM_NAMES).toContain(name);
    }
  });

  test("a JWT value counts whatever the parameter is called; ordinary parameters do not", () => {
    const jwt = "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2Q";
    expect(isCredentialParam("gift", jwt)).toBe(true);
    expect(isCredentialParam("X-Amz-Credential")).toBe(true);
    expect(isCredentialParam("page", "2")).toBe(false);
    expect(looksLikeAnAction("https://x.test/search?q=api+key&page=2")).toBe(false);
  });
});

describe("an email address in a path segment is masked (#774)", () => {
  test("plain, encoded and with a plus sign; a handle stays", () => {
    expect(maskLinkTokens("https://m.example/unsubscribe/user@example.com/77b1")).toBe(
      "https://m.example/unsubscribe/…/77b1",
    );
    expect(maskLinkTokens("https://m.example/u/user%40example.com")).toBe("https://m.example/u/…");
    expect(maskLinkTokens("https://m.example/u/user+tag@example.co.uk/")).toBe("https://m.example/u/…/");
    expect(maskLinkTokens("https://m.example/prefs;email=user@example.com")).toBe("https://m.example/…");
    expect(maskLinkTokens("https://medium.example/@writer/a-post")).toBe(
      "https://medium.example/@writer/a-post",
    );
  });
});
