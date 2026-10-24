// a11y/link-text and conventional link labels (pub#839).
//
// "Sign in", "Terms" or "Impressum" name their destination: they are the standard label for an
// account action or a site-utility page, not "click here". A rule that judges link text must
// leave them alone in any language, however the text is cased, punctuated or spaced, while
// "click here" and its kin are still reported.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { GENERIC_LINK_TEXT, isGenericLinkText, linkTextRule } from "../src/a11y/link-text";
import {
  CONVENTIONAL_LABEL_LANGUAGES,
  CONVENTIONAL_LINK_LABELS,
  isConventionalLinkLabel,
  normalizeLinkLabel,
} from "../src/shared/conventional-link-labels";
import type { CheckResult, ParsedPage, RuleContext } from "../src/types";

function run(body: string): CheckResult[] {
  const html = `<!DOCTYPE html><html><head><title>t</title></head><body>${body}</body></html>`;
  const url = "https://example.com/";
  const ctx = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url) as ParsedPage,
    options: {},
  } as unknown as RuleContext;
  return linkTextRule.run(ctx).checks as CheckResult[];
}

function generic(body: string): string[] {
  const check = run(body).find((c) => c.name === "link-text-generic");
  return check?.items?.map((i) => i.id) ?? [];
}

function links(...texts: string[]): string {
  return texts.map((t, i) => `<a href="/p${i}">${t}</a>`).join("");
}

describe("normalizeLinkLabel", () => {
  test.each([
    ["Sign In", "sign in"],
    ["  SIGN   IN  ", "sign in"],
    ["Sign-in", "sign in"],
    ["sign_in", "sign in"],
    ["Sign in.", "sign in"],
    ["Sign in!", "sign in"],
    ["“Sign in”", "sign in"],
    ["Sign in", "sign in"],
    [" Sign in ", "sign in"],
    ["Sign in →", "sign in"],
    ["Sign in »", "sign in"],
    ["› Sign in", "sign in"],
    ["Sign in >", "sign in"],
    ["Ｓｉｇｎ　ｉｎ", "sign in"],
    ["ログイン！", "ログイン"],
    ["「利用規約」", "利用規約"],
    ["お問い合わせ：", "お問い合わせ"],
    ["联系我们。", "联系我们"],
    ["Terms & Conditions", "terms and conditions"],
    ["Datenschutzerklärung", "datenschutzerklarung"],
    ["Über uns", "uber uns"],
    ["Straße", "strasse"],
    ["S’inscrire", "s'inscrire"],
    ["​Log​ in", "log in"],
  ])("%j reads as %j", (raw, expected) => {
    expect(normalizeLinkLabel(raw)).toBe(expected);
  });

  test("kana and Cyrillic marks are not stripped, only Latin diacritics", () => {
    expect(normalizeLinkLabel("ログイン")).toBe("ログイン");
    expect(normalizeLinkLabel("ﾛｸﾞｲﾝ")).toBe("ログイン");
    expect(normalizeLinkLabel("Выйти")).toBe("выйти");
  });

  test("a dotted capital I, decomposed Hangul, direction marks and emoji selectors normalise", () => {
    expect(normalizeLinkLabel("\u0130LET\u0130\u015e\u0130M")).toBe("iletisim");
    expect(normalizeLinkLabel("로그인".normalize("NFD"))).toBe("로그인");
    expect(normalizeLinkLabel("\u200eSign in\u200f")).toBe("sign in");
    expect(isConventionalLinkLabel("Privacy \u{1f512}\ufe0f")).toBe(true);
    expect(isConventionalLinkLabel("S\u00b4identifier")).toBe(true);
  });

  test("a long run of punctuation costs linear time, and padding never changes the answer", () => {
    const hostile = "x" + "!".repeat(250) + "x";
    const started = performance.now();
    expect(isConventionalLinkLabel(hostile)).toBe(false);
    expect(normalizeLinkLabel("x" + "!".repeat(200_000) + "x")).toHaveLength(200_002);
    expect(performance.now() - started).toBeLessThan(500);
    expect(isConventionalLinkLabel("Terms" + ".".repeat(75))).toBe(true);
    expect(isConventionalLinkLabel("Terms" + ".".repeat(76))).toBe(true);
  });

  test("text that is only punctuation or symbols normalises to nothing", () => {
    expect(normalizeLinkLabel("→")).toBe("");
    expect(normalizeLinkLabel(" ... ")).toBe("");
    expect(isConventionalLinkLabel("→")).toBe(false);
    expect(isConventionalLinkLabel("")).toBe(false);
  });
});

describe("the conventional label set", () => {
  test("covers the eleven languages the issue asks for, kind by kind", () => {
    expect([...CONVENTIONAL_LABEL_LANGUAGES]).toEqual(["en", "es", "fr", "de", "pt", "it", "nl", "ja", "zh", "ko", "ru"]);
    for (const kind of ["account", "legal"] as const) {
      for (const language of CONVENTIONAL_LABEL_LANGUAGES) {
        expect(CONVENTIONAL_LINK_LABELS[kind][language].length).toBeGreaterThan(5);
      }
    }
  });

  test("never overlaps the generic list: a conventional label is not generic text", () => {
    for (const phrase of GENERIC_LINK_TEXT) {
      expect(isConventionalLinkLabel(phrase)).toBe(false);
    }
  });

  test("the account labels left the generic list; subscribe and join stay", () => {
    for (const phrase of ["sign up", "signup", "register", "login", "log in", "sign in"]) {
      expect(GENERIC_LINK_TEXT).not.toContain(phrase);
    }
    expect(GENERIC_LINK_TEXT).toContain("subscribe");
    expect(GENERIC_LINK_TEXT).toContain("join");
    expect(GENERIC_LINK_TEXT).toHaveLength(48);
  });

  // One row per language. `account` and `legal` list labels that must be exempt, written the way
  // a page writes them (cased, accented or punctuated), so the table tests normalisation too.
  const PER_LANGUAGE: Array<[string, string[], string[]]> = [
    ["en", ["Sign in", "SIGN UP", "Log out", "Register", "My account", "Sign out"], ["Terms of Service", "Privacy Policy", "Legal notice", "DMCA", "Cookies", "Accessibility", "Sitemap", "Contact us", "About", "Help", "FAQ", "Careers", "Imprint"]],
    ["es", ["Iniciar sesión", "Iniciar sesion", "Registrarse", "Cerrar sesión", "Mi cuenta"], ["Términos y condiciones", "Política de privacidad", "Aviso legal", "Contacto", "Preguntas frecuentes"]],
    ["fr", ["Connexion", "Se connecter", "S'inscrire", "S’inscrire", "Déconnexion", "Mon compte"], ["Mentions légales", "Politique de confidentialité", "Conditions générales", "Contactez-nous", "À propos"]],
    ["de", ["Anmelden", "Einloggen", "Registrieren", "Abmelden", "Mein Konto"], ["Impressum", "Datenschutz", "Datenschutzerklärung", "Datenschutzerklaerung", "AGB", "Nutzungsbedingungen", "Kontakt", "Über uns", "Ueber uns"]],
    ["pt", ["Entrar", "Registar", "Cadastre-se", "Sair", "Minha conta"], ["Termos de Uso", "Política de Privacidade", "Aviso legal", "Contato", "Sobre nós"]],
    ["it", ["Accedi", "Registrati", "Esci", "Il mio account"], ["Termini e condizioni", "Informativa sulla privacy", "Note legali", "Contatti", "Chi siamo"]],
    ["nl", ["Inloggen", "Registreren", "Uitloggen", "Mijn account"], ["Algemene voorwaarden", "Privacybeleid", "Cookiebeleid", "Contact", "Over ons"]],
    ["ja", ["ログイン", "新規登録", "ログアウト", "会員登録"], ["利用規約", "プライバシーポリシー", "特定商取引法に基づく表記", "お問い合わせ", "会社概要"]],
    ["zh", ["登录", "注册", "退出", "登入", "註冊"], ["服务条款", "服務條款", "隐私政策", "隱私政策", "联系我们", "關於我們"]],
    ["ko", ["로그인", "회원가입", "로그아웃"], ["이용약관", "개인정보처리방침", "문의하기", "회사소개"]],
    ["ru", ["Войти", "Регистрация", "Выйти", "Личный кабинет"], ["Условия использования", "Политика конфиденциальности", "Контакты", "О нас"]],
  ];

  test.each(PER_LANGUAGE)("%s: account and legal labels are conventional", (_language, account, legal) => {
    for (const label of [...account, ...legal]) {
      expect(isConventionalLinkLabel(label)).toBe(true);
    }
  });

  test("variants: case, punctuation, non-breaking space, full width, arrows", () => {
    for (const label of ["sign in", "SIGN IN", "Sign in.", "Sign in!", "Sign in", "Sign-in", "Sign in →", "Ｓｉｇｎ　ｉｎ", "SignIn", "sign-up", "Log-out", "T&C", "Terms & Conditions", "ログイン。"]) {
      expect(isConventionalLinkLabel(label)).toBe(true);
    }
  });

  test("it matches the whole text, never a substring", () => {
    for (const label of ["Sign in to your account to continue", "Terms and a bit more", "Click here to sign in", "Please log in", "Contact", "contact-form-help-center-faq-and-more"]) {
      // The last one is a single word run: only exact entries match.
      expect(isConventionalLinkLabel(label)).toBe(label === "Contact");
    }
  });
});

describe("a11y/link-text", () => {
  test("sign in, sign up and the other account labels are no longer reported", () => {
    const labels = ["Sign in", "Signup", "Sign up", "Log in", "Login", "Log out", "Logout", "Sign out", "Register", "My account", "SIGN IN", "Sign in.", "Sign up"];
    const checks = run(links(...labels));
    expect(checks.map((c) => [c.name, c.status])).toEqual([["link-text", "pass"]]);
  });

  test("legal and utility labels are not reported", () => {
    const labels = ["Terms", "Terms of Service", "Terms and Conditions", "Privacy", "Privacy Policy", "Legal", "Legal notice", "Imprint", "DMCA", "Cookies", "Cookie policy", "Accessibility", "Sitemap", "Contact", "About", "Help", "FAQ", "Careers"];
    expect(run(links(...labels)).map((c) => c.name)).toEqual(["link-text"]);
  });

  test("labels in other languages are not reported", () => {
    const labels = ["Anmelden", "Impressum", "Datenschutz", "Iniciar sesión", "Aviso legal", "Connexion", "Mentions légales", "ログイン", "利用規約", "登录", "联系我们", "로그인", "이용약관", "Войти", "Контакты"];
    expect(run(links(...labels)).map((c) => c.name)).toEqual(["link-text"]);
  });

  test("click here and its kin are still reported", () => {
    const labels = ["click here", "read more", "learn more", "here", "more", "link", "this", "go", "continue"];
    expect(generic(links(...labels)).sort()).toEqual([...labels].sort());
  });

  test("subscribe and join are still reported", () => {
    expect(generic(links("Subscribe", "Join")).sort()).toEqual(["join", "subscribe"]);
  });

  test("a mixed page reports only the generic links", () => {
    const body = `<header>${links("Sign in", "Sign up")}</header><main><a href="/a">Read more</a><a href="/b">Pricing plans</a><a href="/c">Click here</a></main><footer>${links("Terms", "Privacy policy", "Impressum")}</footer>`;
    expect(generic(body).sort()).toEqual(["click here", "read more"]);
  });

  test("the aria-label path exempts conventional labels too, and still reports generic ones", () => {
    const body =
      `<a href="/login" aria-label="Sign in"><svg><circle/></svg></a>` +
      `<a href="/terms" aria-label="Terms of use">T</a>` +
      `<a href="/aria-generic" aria-label="Read more">R</a>` +
      `<a href="/title-generic" title="Click here">Q</a>` +
      `<a href="/impressum" title="Impressum">I</a>`;
    expect(generic(body).sort()).toEqual(["Click here", "Read more"]);
  });

  test("an accessible name that is conventional wins over visible generic text", () => {
    expect(generic(`<a href="/login" aria-label="Log in">here</a>`)).toEqual([]);
  });

  test("isGenericLinkText: a conventional label is checked first, whatever the list holds", () => {
    expect(isGenericLinkText("Sign in")).toBe(false);
    expect(isGenericLinkText("Click here!")).toBe(true);
    expect(isGenericLinkText("Pricing")).toBe(false);
    // The precedence itself: a list that DOES hold a conventional label still never reports it.
    const overlapping = ["sign in", "terms", "impressum", "click here"];
    expect(isGenericLinkText("Sign in", overlapping)).toBe(false);
    expect(isGenericLinkText("Impressum", overlapping)).toBe(false);
    expect(isGenericLinkText("Click here", overlapping)).toBe(true);
  });

  test("the aria-labelledby path exempts a conventional label and reports a generic one", () => {
    const body =
      `<span id="a">Sign in</span><a href="/login" aria-labelledby="a">x</a>` +
      `<span id="b">Read more</span><a href="/more" aria-labelledby="b">y</a>`;
    expect(generic(body)).toEqual(["Read more"]);
  });

  test("empty links are still reported", () => {
    const checks = run(`<a href="/x"></a>${links("Sign in")}`);
    expect(checks.map((c) => c.name)).toEqual(["link-text-empty"]);
  });
});
