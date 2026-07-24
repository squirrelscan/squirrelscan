// a11y/html-xml-lang-mismatch - HTML lang and xml:lang match

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const htmlXmlLangMismatchRule: Rule = {
  meta: {
    id: "a11y/html-xml-lang-mismatch",
    name: "HTML XML Lang Mismatch",
    description:
      "Checks that lang and xml:lang attributes match on html element",
    solution:
      "If both lang and xml:lang are present on the <html> element, they must have the same base language. Mismatches can cause screen readers to announce content in the wrong language. Typically, you only need lang for HTML5 documents.",
    category: "a11y",
    scope: "page",
    severity: "error",
    weight: 6,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const html = doc.documentElement;
    const lang = html?.getAttribute("lang")?.toLowerCase().trim();
    const xmlLang = html?.getAttribute("xml:lang")?.toLowerCase().trim();

    if (lang && xmlLang) {
      // Compare base language (before any hyphen)
      const langBase = lang.split("-")[0];
      const xmlLangBase = xmlLang.split("-")[0];

      if (langBase !== xmlLangBase) {
        checks.push({
          name: "html-xml-lang-mismatch",
          status: "fail",
          message: `lang="${lang}" and xml:lang="${xmlLang}" don't match`,
          details: {
            issue: "Base languages must match",
            fix: "Set both to the same value or remove xml:lang",
          },
        });
      } else if (lang !== xmlLang) {
        checks.push({
          name: "html-xml-lang-mismatch",
          status: "warn",
          message: `lang="${lang}" and xml:lang="${xmlLang}" differ slightly`,
          details: {
            note: "Base languages match but subtags differ",
          },
        });
      } else {
        checks.push({
          name: "html-xml-lang-mismatch",
          status: "pass",
          message: "lang and xml:lang attributes match",
          value: lang,
        });
      }
    } else if (xmlLang && !lang) {
      checks.push({
        name: "html-xml-lang-mismatch",
        status: "warn",
        message: "xml:lang present without lang attribute",
        value: xmlLang,
        details: {
          suggestion: "Add lang attribute for HTML5 compatibility",
        },
      });
    } else {
      checks.push({
        name: "html-xml-lang-mismatch",
        status: "info",
        message: "Only lang attribute present (recommended for HTML5)",
      });
    }

    return { checks };
  },
};
