// pub#839: a conventional account or site-utility label names its destination,
// so a11y/link-text does not report it as generic text.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { linkTextRule } from "../src/a11y/link-text";
import { isConventionalLinkLabel, normalizeLinkLabel } from "../src/shared/conventional-link-labels";
import type { ParsedPage, RuleContext } from "../src/types";

function checks(links: string[]): CheckResult[] {
  const url = "https://example.com/";
  const html = `<!doctype html><html lang="en"><head><title>t</title></head><body>${links
    .map((t, i) => `<a href="/p${i}">${t}</a>`)
    .join("")}</body></html>`;
  return linkTextRule.run({
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url) as ParsedPage,
    options: {},
  } as RuleContext).checks as CheckResult[];
}

const flagged = (text: string): boolean =>
  checks([text]).some((c) => c.name === "link-text-generic");

describe("account labels are never generic", () => {
  test.each([
    "Sign in", "Sign In", "signin", "Sign up", "signup", "Log in", "login", "Log out", "Logout",
    "Sign out", "Register", "My account", "Sign in.", "Sign up!", "Sign in", "SIGN  IN",
    "Ｓｉｇｎ ｉｎ", "Log in:", "Sign in！",
  ])("%s", (text) => {
    expect(flagged(text)).toBe(false);
    expect(isConventionalLinkLabel(text)).toBe(true);
  });
});

describe("legal and utility labels are never generic", () => {
  test.each([
    "Terms", "Terms of Service", "Terms and Conditions", "Privacy", "Privacy Policy", "Legal",
    "Legal notice", "Imprint", "DMCA", "Cookies", "Cookie policy", "Accessibility", "Sitemap",
    "Contact", "About", "Help", "FAQ", "Careers", "Contact us",
  ])("%s", (text) => {
    expect(flagged(text)).toBe(false);
    expect(isConventionalLinkLabel(text)).toBe(true);
  });
});

describe("one test per language", () => {
  test.each([
    ["en", "Sign in", "Privacy policy"],
    ["es", "Iniciar sesión", "Política de privacidad"],
    ["fr", "Se connecter", "Mentions légales"],
    ["de", "Anmelden", "Datenschutzerklärung"],
    ["pt", "Entrar", "Termos de uso"],
    ["it", "Accedi", "Informativa sulla privacy"],
    ["nl", "Inloggen", "Algemene voorwaarden"],
    ["ja", "ログイン", "プライバシーポリシー"],
    ["zh", "登录", "隐私政策"],
    ["ko", "로그인", "개인정보처리방침"],
    ["ru", "Войти", "Политика конфиденциальности"],
  ])("%s", (_lang, account, utility) => {
    expect(isConventionalLinkLabel(account)).toBe(true);
    expect(isConventionalLinkLabel(utility)).toBe(true);
    expect(isConventionalLinkLabel(`${account}。`)).toBe(true);
    expect(checks([account, utility]).some((c) => c.status !== "pass")).toBe(false);
  });

  test("a curly apostrophe matches the straight one", () => {
    expect(isConventionalLinkLabel("S’inscrire")).toBe(true);
    expect(isConventionalLinkLabel("Conditions d’utilisation")).toBe(true);
  });
});

describe("genuine generic links are still reported", () => {
  test.each(["click here", "read more", "learn more", "here", "more", "link", "this", "go", "continue"])(
    "%s",
    (text) => {
      expect(flagged(text)).toBe(true);
      expect(isConventionalLinkLabel(text)).toBe(false);
    },
  );

  test("the whole text must match: 'Sign in to read more' is not exempt, 'Read more' still is flagged", () => {
    expect(isConventionalLinkLabel("Sign in to read more")).toBe(false);
    expect(normalizeLinkLabel("  “Sign in”. ")).toBe("sign in");
  });

  test("a page with Sign in and Sign up in the header and one real generic link reports only the generic one", () => {
    const out = checks(["Sign in", "Sign up", "Pricing", "click here"]);
    const generic = out.find((c) => c.name === "link-text-generic");
    expect(generic?.message).toBe("1 link(s) with generic text");
  });

  test("sign in alone passes the rule", () => {
    expect(checks(["Sign in", "Sign up"]).map((c) => [c.name, c.status])).toEqual([["link-text", "pass"]]);
  });
});
