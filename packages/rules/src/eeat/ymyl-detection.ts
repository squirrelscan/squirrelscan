// eeat/ymyl-detection - Your Money Your Life content detection

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { getPathname } from "@squirrelscan/utils";

const HEALTH_KEYWORDS = [
  "symptoms",
  "treatment",
  "diagnosis",
  "medication",
  "disease",
  "medical",
  "health",
  "doctor",
  "prescription",
  "therapy",
  "cancer",
  "diabetes",
  "heart",
  "mental health",
  "surgery",
];

const FINANCE_KEYWORDS = [
  "investment",
  "mortgage",
  "loan",
  "credit",
  "banking",
  "retirement",
  "tax",
  "insurance",
  "financial",
  "stock",
  "crypto",
  "trading",
  "wealth",
  "debt",
  "budget",
];

const LEGAL_KEYWORDS = [
  "lawyer",
  "attorney",
  "legal",
  "lawsuit",
  "court",
  "divorce",
  "custody",
  "immigration",
  "criminal",
  "contract",
];

export const ymylDetectionRule: Rule = {
  meta: {
    id: "eeat/ymyl-detection",
    name: "YMYL Detection",
    description: "Detects Your Money Your Life (YMYL) content",
    solution:
      "YMYL content (health, finance, legal, safety) is held to higher E-E-A-T standards by Google. If detected: ensure expert authors with credentials, add disclaimers ('not medical advice'), cite authoritative sources, show content review dates, and include professional credentials. YMYL errors can significantly impact rankings.",
    category: "eeat",
    scope: "site",
    severity: "info",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const pages = ctx.site?.pages;

    if (!pages || pages.length === 0) {
      checks.push({
        name: "ymyl-detection",
        status: "skipped",
        message: "No pages available for analysis",
      });
      return { checks };
    }

    let healthPages = 0;
    let financePages = 0;
    let legalPages = 0;

    for (const page of pages) {
      const content = (
        page.parsed.meta.title +
        " " +
        page.parsed.meta.description
      ).toLowerCase();
      const path = getPathname(page.url).toLowerCase();

      // Check categories
      if (
        HEALTH_KEYWORDS.some((k) => content.includes(k) || path.includes(k))
      ) {
        healthPages++;
      }
      if (
        FINANCE_KEYWORDS.some((k) => content.includes(k) || path.includes(k))
      ) {
        financePages++;
      }
      if (LEGAL_KEYWORDS.some((k) => content.includes(k) || path.includes(k))) {
        legalPages++;
      }
    }

    const ymylCategories: string[] = [];
    if (healthPages > 0) ymylCategories.push(`Health (${healthPages} pages)`);
    if (financePages > 0)
      ymylCategories.push(`Finance (${financePages} pages)`);
    if (legalPages > 0) ymylCategories.push(`Legal (${legalPages} pages)`);

    if (ymylCategories.length > 0) {
      checks.push({
        name: "ymyl-content",
        status: "info",
        message: "YMYL content detected - apply higher E-E-A-T standards",
        items: ymylCategories.map((cat) => ({ id: cat })),
      });

      checks.push({
        name: "ymyl-requirements",
        status: "info",
        message:
          "YMYL content should have expert authors, disclaimers, and citations",
      });
    } else {
      checks.push({
        name: "ymyl-detection",
        status: "pass",
        message: "No obvious YMYL content detected",
      });
    }

    return { checks };
  },
};
