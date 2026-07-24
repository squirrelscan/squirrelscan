// a11y/html-lang-valid - HTML lang attribute has valid value

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

// Common valid language codes (ISO 639-1)
const validPrimaryLanguages = new Set([
  "aa",
  "ab",
  "ae",
  "af",
  "ak",
  "am",
  "an",
  "ar",
  "as",
  "av",
  "ay",
  "az",
  "ba",
  "be",
  "bg",
  "bh",
  "bi",
  "bm",
  "bn",
  "bo",
  "br",
  "bs",
  "ca",
  "ce",
  "ch",
  "co",
  "cr",
  "cs",
  "cu",
  "cv",
  "cy",
  "da",
  "de",
  "dv",
  "dz",
  "ee",
  "el",
  "en",
  "eo",
  "es",
  "et",
  "eu",
  "fa",
  "ff",
  "fi",
  "fj",
  "fo",
  "fr",
  "fy",
  "ga",
  "gd",
  "gl",
  "gn",
  "gu",
  "gv",
  "ha",
  "he",
  "hi",
  "ho",
  "hr",
  "ht",
  "hu",
  "hy",
  "hz",
  "ia",
  "id",
  "ie",
  "ig",
  "ii",
  "ik",
  "in",
  "io",
  "is",
  "it",
  "iu",
  "iw",
  "ja",
  "ji",
  "jv",
  "jw",
  "ka",
  "kg",
  "ki",
  "kj",
  "kk",
  "kl",
  "km",
  "kn",
  "ko",
  "kr",
  "ks",
  "ku",
  "kv",
  "kw",
  "ky",
  "la",
  "lb",
  "lg",
  "li",
  "ln",
  "lo",
  "lt",
  "lu",
  "lv",
  "mg",
  "mh",
  "mi",
  "mk",
  "ml",
  "mn",
  "mo",
  "mr",
  "ms",
  "mt",
  "my",
  "na",
  "nb",
  "nd",
  "ne",
  "ng",
  "nl",
  "nn",
  "no",
  "nr",
  "nv",
  "ny",
  "oc",
  "oj",
  "om",
  "or",
  "os",
  "pa",
  "pi",
  "pl",
  "ps",
  "pt",
  "qu",
  "rm",
  "rn",
  "ro",
  "ru",
  "rw",
  "sa",
  "sc",
  "sd",
  "se",
  "sg",
  "sh",
  "si",
  "sk",
  "sl",
  "sm",
  "sn",
  "so",
  "sq",
  "sr",
  "ss",
  "st",
  "su",
  "sv",
  "sw",
  "ta",
  "te",
  "tg",
  "th",
  "ti",
  "tk",
  "tl",
  "tn",
  "to",
  "tr",
  "ts",
  "tt",
  "tw",
  "ty",
  "ug",
  "uk",
  "ur",
  "uz",
  "ve",
  "vi",
  "vo",
  "wa",
  "wo",
  "xh",
  "yi",
  "yo",
  "za",
  "zh",
  "zu",
]);

function isValidLanguageTag(tag: string): { valid: boolean; reason?: string } {
  if (!tag || !tag.trim()) {
    return { valid: false, reason: "empty value" };
  }

  const normalized = tag.trim().toLowerCase();

  // Split into subtags
  const parts = normalized.split("-");
  const primary = parts[0];

  // Check primary language
  if (!validPrimaryLanguages.has(primary)) {
    // Also allow 3-letter codes (ISO 639-2)
    if (!/^[a-z]{2,3}$/.test(primary)) {
      return { valid: false, reason: `invalid primary language '${primary}'` };
    }
  }

  // Region codes (ISO 3166-1 alpha-2) are 2 uppercase letters
  // Script codes (ISO 15924) are 4 letters with first uppercase
  // These are optional, so we don't strictly validate them

  return { valid: true };
}

export const htmlLangValidRule: Rule = {
  meta: {
    id: "a11y/html-lang-valid",
    name: "HTML Lang Valid",
    description:
      "Checks that the html lang attribute has a valid language code",
    solution:
      "The lang attribute on <html> should be a valid BCP 47 language tag. Use two-letter ISO 639-1 codes like 'en' for English, 'es' for Spanish, 'fr' for French. You can add region subtags like 'en-US' or 'en-GB'. This helps screen readers use correct pronunciation.",
    category: "a11y",
    scope: "page",
    severity: "error",
    weight: 7,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const html = doc.documentElement;
    const lang = html?.getAttribute("lang");

    if (!lang) {
      checks.push({
        name: "html-has-lang",
        status: "fail",
        message: "HTML element missing lang attribute",
        expected: 'lang="en" or appropriate language code',
      });
      return { checks };
    }

    const validation = isValidLanguageTag(lang);

    if (validation.valid) {
      checks.push({
        name: "html-lang-valid",
        status: "pass",
        message: `Valid lang attribute: "${lang}"`,
        value: lang,
      });
    } else {
      checks.push({
        name: "html-lang-valid",
        status: "fail",
        message: `Invalid lang attribute: ${validation.reason}`,
        value: lang,
        expected: "Valid BCP 47 language tag (e.g., 'en', 'en-US', 'es')",
      });
    }

    return { checks };
  },
};
