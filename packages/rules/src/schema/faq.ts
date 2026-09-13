// schema/faq - FAQPage schema validation

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { flattenJsonLdNodes } from "@squirrelscan/utils";

export const faqSchemaRule: Rule = {
  meta: {
    id: "schema/faq",
    name: "FAQ Schema",
    description: "Validates FAQPage schema structure",
    solution:
      "FAQPage schema enables FAQ rich results in search. Structure: FAQPage with mainEntity array of Question items. Each Question needs name (question text) and acceptedAnswer (Answer with text). FAQ content must be visible on the page. Don't use for single Q&A or forums - those have different schema types.",
    category: "schema",
    scope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const schemaScripts = doc.querySelectorAll(
      'script[type="application/ld+json"]'
    );
    let faqSchema: Record<string, unknown> | null = null;

    for (const script of schemaScripts) {
      // Flattened per script, so a Yoast / Rank Math `@graph` wrapper is
      // descended into rather than read as one typeless node (#317). Per
      // SCRIPT and not over the joined `schema.raw`, because that join can
      // mis-split a pretty-printed block (#1099). Unparseable JSON yields an
      // empty list, which is what the old try/catch was for.
      const schemas = flattenJsonLdNodes(script.textContent || "");

      for (const schema of schemas) {
        const type = schema["@type"];
        if (
          type === "FAQPage" ||
          (Array.isArray(type) && type.includes("FAQPage"))
        ) {
          faqSchema = schema;
          break;
        }
      }
    }

    if (!faqSchema) {
      checks.push({
        name: "faq-schema",
        status: "info",
        message: "No FAQPage schema found",
      });
      return { checks };
    }

    // Check mainEntity
    const mainEntity = faqSchema["mainEntity"];
    if (!mainEntity) {
      checks.push({
        name: "faq-mainEntity",
        status: "warn",
        message: "FAQPage missing mainEntity",
        value: "Add array of Question items",
      });
      return { checks };
    }

    const questions = Array.isArray(mainEntity) ? mainEntity : [mainEntity];

    if (questions.length === 0) {
      checks.push({
        name: "faq-questions",
        status: "warn",
        message: "FAQPage has no questions",
      });
      return { checks };
    }

    // Validate questions
    let validQuestions = 0;
    let invalidQuestions = 0;

    for (const q of questions) {
      const type = q["@type"];
      const hasName = !!q["name"];
      const hasAnswer = !!q["acceptedAnswer"];

      if (type === "Question" && hasName && hasAnswer) {
        validQuestions++;
      } else {
        invalidQuestions++;
      }
    }

    if (invalidQuestions > 0) {
      checks.push({
        name: "faq-questions",
        status: "warn",
        message: `${invalidQuestions} question(s) missing required properties`,
        value: "Each Question needs @type, name, acceptedAnswer",
      });
    }

    if (validQuestions > 0) {
      checks.push({
        name: "faq-valid",
        status: "pass",
        message: `FAQPage has ${validQuestions} valid question(s)`,
      });
    }

    return { checks };
  },
};
