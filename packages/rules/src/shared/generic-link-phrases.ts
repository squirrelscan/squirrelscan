// Generic link text per language (pub#840): phrases that say nothing about the
// destination ("click here", "read more"). The page's `<html lang>` primary
// subtag selects the list; English is always checked by the caller, and a page
// with no or an unknown `lang` gets English only.
//
// Conservative on purpose: whole-text matches only (after the same
// normalisation as the conventional labels: NFKC, case folding, edge
// punctuation removed, CJK text never split on word boundaries), and only
// phrases that are generic in that language. A conventional account or
// utility label (shared/conventional-link-labels.ts) always wins.

import { isConventionalLinkLabel, normalizeLinkLabel } from "./conventional-link-labels";

const PHRASES: Readonly<Record<string, readonly string[]>> = {
  es: [
    "haga clic aquí", "haz clic aquí", "clic aquí", "click aquí", "pulse aquí", "pulsa aquí",
    "aquí", "leer más", "lee más", "más", "más información", "saber más", "ver más",
    "conocer más", "enlace", "continuar", "ver detalles", "más detalles",
  ],
  fr: [
    "cliquez ici", "clique ici", "cliquer ici", "ici", "en savoir plus", "lire la suite",
    "lire plus", "plus", "voir plus", "plus d'infos", "plus d'informations", "lien", "continuer",
    "savoir plus", "voir les détails", "plus de détails",
  ],
  de: [
    "hier klicken", "klicken sie hier", "klick hier", "hier", "mehr", "mehr lesen",
    "weiterlesen", "mehr erfahren", "mehr anzeigen", "mehr infos", "mehr informationen",
    "link", "hier lesen", "details ansehen",
  ],
  pt: [
    "clique aqui", "clica aqui", "aqui", "leia mais", "ler mais", "saiba mais", "mais",
    "ver mais", "veja mais", "continuar", "link", "clique", "mais informações", "mais detalhes",
  ],
  it: [
    "clicca qui", "clicca qua", "qui", "qua", "leggi di più", "leggi tutto", "leggi altro",
    "scopri di più", "di più", "continua", "link", "maggiori informazioni",
    "per saperne di più", "vai", "maggiori dettagli",
  ],
  nl: [
    "klik hier", "hier", "lees meer", "meer", "meer info", "meer informatie",
    "link", "lees verder", "bekijk meer", "meer weten", "meer details",
  ],
  ja: [
    "こちら", "ここ", "ここをクリック", "こちらをクリック", "クリック", "詳細", "詳しくはこちら",
    "詳細はこちら", "詳しく見る", "詳細を見る", "もっと見る", "続きを読む", "続きはこちら",
    "もっと読む", "リンク", "もっと詳しく", "さらに表示",
  ],
  zh: [
    "点击这里", "点击此处", "点此", "单击此处", "了解更多", "阅读更多", "阅读全文", "更多",
    "查看更多", "查看详情", "详情", "这里", "此处", "链接", "继续阅读",
    "點擊這裡", "點擊此處", "點此", "單擊此處", "瞭解更多", "了解更多資訊", "閱讀更多",
    "閱讀全文", "查看更多", "查看詳情", "詳情", "這裡", "此處", "連結", "繼續閱讀",
  ],
  ko: [
    "여기를 클릭", "여기 클릭", "여기를 클릭하세요", "클릭", "여기", "자세히 보기", "자세히",
    "더 보기", "더보기", "더 알아보기", "자세한 내용", "링크", "계속 읽기", "더 읽기",
  ],
  ru: [
    "нажмите здесь", "кликните здесь", "щёлкните здесь", "здесь", "тут", "читать далее",
    "читать больше", "читать дальше", "подробнее", "узнать больше", "больше", "далее",
    "ссылка", "узнать подробнее", "показать больше",
  ],
};

const SETS: Readonly<Record<string, ReadonlySet<string>>> = Object.fromEntries(
  Object.entries(PHRASES).map(([lang, list]) => [lang, new Set(list.map(normalizeLinkLabel))]),
);

/** Three-letter codes some pages use for the same languages. */
const ISO_639_2: Readonly<Record<string, string>> = {
  spa: "es", fra: "fr", fre: "fr", deu: "de", ger: "de", por: "pt", ita: "it", nld: "nl", dut: "nl",
  jpn: "ja", zho: "zh", chi: "zh", kor: "ko", rus: "ru",
};

/** The primary subtag of an `<html lang>` value, lower-cased; "" when there is none. */
export function primaryLangSubtag(lang: string | null | undefined): string {
  const m = /^\s*([a-zA-Z]{2,3})(?:[-_]|\s*$)/.exec(lang ?? "");
  const tag = m ? (m[1] as string).toLowerCase() : "";
  return ISO_639_2[tag] ?? tag;
}

/** Whether the page language has a generic phrase list beyond English. */
export function hasGenericPhrases(lang: string | null | undefined): boolean {
  return Object.hasOwn(SETS, primaryLangSubtag(lang));
}

/**
 * Whether the whole link text is a generic phrase in the page's language. Never
 * true for a conventional account or utility label. English is the caller's
 * own list; this covers the page language only.
 */
export function isGenericInPageLanguage(text: string, lang: string | null | undefined): boolean {
  const key = primaryLangSubtag(lang);
  const set = Object.hasOwn(SETS, key) ? SETS[key] : undefined;
  if (!set) return false;
  const normalized = normalizeLinkLabel(text);
  return normalized.length > 0 && set.has(normalized) && !isConventionalLinkLabel(normalized);
}
