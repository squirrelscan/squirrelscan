// pub#840: a11y/link-text and links/anchor-text recognise generic link text in
// the page language (<html lang>), English always, whole-text matches only.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { linkTextRule } from "../src/a11y/link-text";
import { anchorTextRule } from "../src/links/anchor-text";
import { isGenericInPageLanguage, primaryLangSubtag } from "../src/shared/generic-link-phrases";
import type { ParsedPage, RuleContext } from "../src/types";

type AnyRule = { run: (ctx: RuleContext) => { checks: unknown } };

function run(rule: AnyRule, lang: string | null, links: string[]): CheckResult[] {
  const url = "https://example.com/";
  const attr = lang === null ? "" : ` lang="${lang}"`;
  const html = `<!doctype html><html${attr}><head><title>t</title></head><body>${links
    .map((t, i) => `<a href="/p${i}">${t}</a>`)
    .join("")}</body></html>`;
  return rule.run({
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url) as ParsedPage,
    options: {},
  } as RuleContext).checks as CheckResult[];
}

const reported = (rule: AnyRule, name: string, lang: string | null, text: string): boolean =>
  run(rule, lang, [text]).some((c) => c.name === name && c.status !== "pass");

const RULES: Array<[string, AnyRule, string]> = [
  ["a11y/link-text", linkTextRule, "link-text-generic"],
  ["links/anchor-text", anchorTextRule, "generic-anchor"],
];

// [lang, generic phrase, descriptive link]
const CASES: Array<[string, string, string]> = [
  ["es", "Haga clic aquí", "Guía de precios del plan anual"],
  ["fr", "En savoir plus", "Tarifs de la formule annuelle"],
  ["de", "Mehr", "Preise des Jahresabos"],
  ["pt", "Clique aqui", "Preços do plano anual"],
  ["it", "Scopri di più", "Prezzi del piano annuale"],
  ["nl", "Klik hier", "Prijzen van het jaarabonnement"],
  ["ja", "詳しくはこちら", "年間プランの料金表"],
  ["zh", "点击这里", "年度套餐价格表"],
  ["ko", "자세히 보기", "연간 요금제 가격표"],
  ["ru", "Читать далее", "Цены годового тарифа"],
];

for (const [id, rule, name] of RULES) {
  describe(id, () => {
    test.each(CASES)("%s: a generic phrase is reported, a descriptive link is not", (lang, generic, descriptive) => {
      expect(reported(rule, name, lang, generic)).toBe(true);
      expect(reported(rule, name, lang, descriptive)).toBe(false);
    });

    test.each(CASES)("%s: punctuation, case and region subtags do not matter", (lang, generic) => {
      expect(reported(rule, name, `${lang}-XX`, `${generic.toUpperCase()}.`)).toBe(true);
      expect(reported(rule, name, lang.toUpperCase(), `  ${generic}！ `)).toBe(true);
    });

    test("English always applies on a non-English page", () => {
      expect(reported(rule, name, "fr", "click here")).toBe(true);
      expect(reported(rule, name, "ja", "read more")).toBe(true);
    });

    test("no or an unknown lang checks English only", () => {
      for (const lang of [null, "", "xx", "tlh", "en"]) {
        expect(reported(rule, name, lang, "En savoir plus")).toBe(false);
        expect(reported(rule, name, lang, "Mehr")).toBe(false);
        expect(reported(rule, name, lang, "click here")).toBe(true);
      }
    });

    test("another language's phrase is not reported", () => {
      expect(reported(rule, name, "fr", "Mehr")).toBe(false);
      expect(reported(rule, name, "de", "En savoir plus")).toBe(false);
    });

    test("whole text only: a longer descriptive text containing a phrase is not reported", () => {
      expect(reported(rule, name, "fr", "En savoir plus sur nos tarifs")).toBe(false);
      expect(reported(rule, name, "de", "Mehr über unsere Preise")).toBe(false);
      expect(reported(rule, name, "ja", "詳しくはこちらの料金表")).toBe(false);
    });

    test("conventional account and legal labels are never reported, in any language", () => {
      for (const [lang, label] of [
        ["fr", "Connexion"], ["fr", "Mentions légales"], ["de", "Anmelden"], ["de", "Impressum"],
        ["es", "Iniciar sesión"], ["es", "Contacto"], ["ja", "ログイン"], ["zh", "隐私政策"],
        ["ko", "로그인"], ["ru", "Войти"], ["it", "Contatti"], ["pt", "Contato"], ["nl", "Inloggen"],
      ] as const) {
        expect(reported(rule, name, lang, label)).toBe(false);
      }
    });
  });
}

describe("review trims (pub#840)", () => {
  test("ambiguous pager and wizard words are not generic", () => {
    for (const [lang, text] of [
      ["de", "Weiter »"], ["de", "Weiter"], ["fr", "Suite"], ["ru", "Продолжить"], ["it", "Altro"], ["nl", "Verder"],
    ] as const) {
      for (const [, rule, name] of RULES) expect(reported(rule, name, lang, text)).toBe(false);
    }
  });

  test("only the primary html lang is read: a nested lang is ignored, other-language text under another lang is not reported", () => {
    const url = "https://example.com/";
    const html = '<!doctype html><html lang="en"><head><title>t</title></head><body><div lang="fr"><a href="/a">En savoir plus</a></div><a href="/b">Cliquez ici</a></body></html>';
    for (const [, rule, name] of RULES) {
      const out = rule.run({
        page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
        parsed: parsePage(html, url) as ParsedPage,
        options: {},
      } as RuleContext).checks as CheckResult[];
      expect(out.some((c) => c.name === name && c.status !== "pass")).toBe(false);
    }
  });

  test("three-letter codes map, and prototype names never match", () => {
    for (const [code, lang] of [["deu", "de"], ["fra", "fr"], ["jpn", "ja"], ["spa", "es"], ["por", "pt"], ["ita", "it"], ["nld", "nl"], ["zho", "zh"], ["kor", "ko"], ["rus", "ru"]] as const) {
      expect(primaryLangSubtag(code)).toBe(lang);
    }
    expect(isGenericInPageLanguage("mehr", "deu")).toBe(true);
    expect(isGenericInPageLanguage("mehr", "constructor")).toBe(false);
    expect(isGenericInPageLanguage("mehr", "toString")).toBe(false);
  });
});

describe("generic-link-phrases helpers", () => {
  test("primary subtag", () => {
    expect(primaryLangSubtag("zh-Hant-TW")).toBe("zh");
    expect(primaryLangSubtag("pt_BR")).toBe("pt");
    expect(primaryLangSubtag(" DE ")).toBe("de");
    expect(primaryLangSubtag(null)).toBe("");
    expect(primaryLangSubtag("123")).toBe("");
  });

  test("CJK text is matched whole, never split on word boundaries", () => {
    expect(isGenericInPageLanguage("詳細", "ja")).toBe(true);
    expect(isGenericInPageLanguage("詳細な料金", "ja")).toBe(false);
    expect(isGenericInPageLanguage("更多", "zh-CN")).toBe(true);
    expect(isGenericInPageLanguage("更多优惠", "zh-CN")).toBe(false);
  });
});
