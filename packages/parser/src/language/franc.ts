// franc (MIT, https://github.com/wooorm/franc) behind the LanguageDetector
// interface. franc is a trigram detector over 187
// languages; it returns ISO 639-3 codes and, per language, a score normalised so
// the best match is 1.

import { francAll } from "franc";

import type { DetectedLanguage, LanguageDetector } from "./detector";

/**
 * ISO 639-3 code -> ISO 639-1 code, for every franc language that has one.
 * Individual languages of a macrolanguage map to the macrolanguage's code
 * (`arb` -> `ar`, `zlm` -> `ms`, `ekk` -> `et`), the code a page declares.
 */
export const FRANC_ISO6391: Readonly<Record<string, string>> = {
  afr: "af",
  als: "sq",
  amh: "am",
  arb: "ar",
  azj: "az",
  bam: "bm",
  bel: "be",
  ben: "bn",
  bod: "bo",
  bos: "bs",
  bul: "bg",
  cat: "ca",
  ces: "cs",
  cmn: "zh",
  dan: "da",
  deu: "de",
  ekk: "et",
  ell: "el",
  eng: "en",
  epo: "eo",
  ewe: "ee",
  fin: "fi",
  fra: "fr",
  glg: "gl",
  guj: "gu",
  hat: "ht",
  hau: "ha",
  heb: "he",
  hin: "hi",
  hrv: "hr",
  hun: "hu",
  hye: "hy",
  ibo: "ig",
  ind: "id",
  ita: "it",
  jav: "jv",
  jpn: "ja",
  kan: "kn",
  kat: "ka",
  kaz: "kk",
  khk: "mn",
  khm: "km",
  kin: "rw",
  kir: "ky",
  kor: "ko",
  lao: "lo",
  lin: "ln",
  lit: "lt",
  lug: "lg",
  lvs: "lv",
  mal: "ml",
  mar: "mr",
  mkd: "mk",
  mya: "my",
  ndo: "ng",
  nld: "nl",
  nno: "nn",
  nob: "nb",
  npi: "ne",
  nya: "ny",
  pan: "pa",
  pbu: "ps",
  pes: "fa",
  pol: "pl",
  por: "pt",
  prs: "fa",
  ron: "ro",
  run: "rn",
  rus: "ru",
  sag: "sg",
  sin: "si",
  slk: "sk",
  slv: "sl",
  sna: "sn",
  som: "so",
  sot: "st",
  spa: "es",
  srp: "sr",
  ssw: "ss",
  sun: "su",
  swe: "sv",
  swh: "sw",
  tam: "ta",
  tat: "tt",
  tel: "te",
  tgk: "tg",
  tgl: "tl",
  tha: "th",
  tir: "ti",
  tsn: "tn",
  tso: "ts",
  tuk: "tk",
  tur: "tr",
  uig: "ug",
  ukr: "uk",
  urd: "ur",
  uzn: "uz",
  ven: "ve",
  vie: "vi",
  wol: "wo",
  xho: "xh",
  ydd: "yi",
  yor: "yo",
  zlm: "ms",
  zul: "zu",
};

/**
 * Languages the production detector chooses between: every franc language with
 * an ISO 639-1 code. Without a list franc's long tail wins on ordinary text
 * (plain English scores as Scots, German as Low German), so the default
 * detector only names languages a page can declare with a two-letter tag.
 */
export const FRANC_WEB_LANGUAGES: readonly string[] =
  Object.keys(FRANC_ISO6391);

export interface FrancDetectorOptions {
  /** Restrict franc to these ISO 639-3 codes. Omit to let it choose from all 187. */
  only?: readonly string[];
  /** Detector id; defaults to "franc" with a list and "franc-all" without. */
  id?: string;
}

/**
 * A franc-backed detector. Confidence is the margin between the best and the
 * second-best language's normalised scores (1 - second), so a clear winner
 * scores high and a near tie (Danish vs Norwegian Bokmål) scores near zero. A
 * script with a single franc language (Thai, Greek, Korean) scores 1.
 */
export function createFrancDetector(
  options: FrancDetectorOptions = {}
): LanguageDetector {
  const only = options.only ? [...options.only] : undefined;
  const id = options.id ?? (only ? "franc" : "franc-all");
  return {
    id,
    detectLanguage(text: string): DetectedLanguage | null {
      // minLength 1: the floor wrapper owns the length cut, not franc.
      const ranked = francAll(text, {
        minLength: 1,
        ...(only ? { only } : {}),
      });
      const top = ranked[0];
      if (!top || top[0] === "und") return null;
      const second = ranked[1]?.[1] ?? 0;
      const confidence = Math.min(1, Math.max(0, 1 - second));
      return { lang: FRANC_ISO6391[top[0]] ?? top[0], confidence };
    },
  };
}
