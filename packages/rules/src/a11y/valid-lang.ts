// a11y/valid-lang - All lang attributes have valid values

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

function isValidLangCode(tag: string): boolean {
  if (!tag || !tag.trim()) return false;

  const normalized = tag.trim().toLowerCase();
  const parts = normalized.split("-");
  const primary = parts[0];

  return validPrimaryLanguages.has(primary) || /^[a-z]{2,3}$/.test(primary);
}

export const validLangRule: Rule = {
  meta: {
    id: "a11y/valid-lang",
    name: "Valid Lang Attributes",
    description:
      "Checks that all lang attributes on the page have valid values",
    solution:
      "All lang attributes should use valid BCP 47 language tags. This includes lang attributes on any element, not just <html>. Use lang to mark up content in a different language from the page default.",
    category: "a11y",
    scope: "page",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const elementsWithLang = doc.querySelectorAll("[lang]");
    const invalidLangs: string[] = [];

    for (const el of elementsWithLang) {
      // Skip html element (checked by html-lang-valid)
      if (el.tagName.toLowerCase() === "html") continue;

      const lang = el.getAttribute("lang") || "";
      if (!isValidLangCode(lang)) {
        const tagName = el.tagName.toLowerCase();
        const id = el.getAttribute("id");
        invalidLangs.push(
          `${id ? `${tagName}#${id}` : tagName}: lang="${lang}"`
        );
      }
    }

    if (invalidLangs.length > 0) {
      checks.push({
        name: "valid-lang",
        status: "warn",
        message: `${invalidLangs.length} element(s) with invalid lang attribute`,
        items: invalidLangs.slice(0, 10).map((id) => ({ id })),
        details:
          invalidLangs.length > 10
            ? { additional: invalidLangs.length - 10 }
            : undefined,
      });
    } else if (elementsWithLang.length > 1) {
      // More than just html element
      checks.push({
        name: "valid-lang",
        status: "pass",
        message: "All lang attributes are valid",
        details: { elementsChecked: elementsWithLang.length - 1 },
      });
    } else {
      checks.push({
        name: "valid-lang",
        status: "info",
        message: "No additional lang attributes found",
      });
    }

    return { checks };
  },
};
