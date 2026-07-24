// content/article-toc - Table of contents for long articles

import { z } from "zod";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

const optionsSchema = z.object({
  min_word_count: z.number().default(1500),
  min_headings: z.number().default(3),
});

export const articleTocRule: Rule = {
  meta: {
    id: "content/article-toc",
    name: "Article Table of Contents",
    description:
      "Long articles with multiple sections should have a table of contents with schema markup",
    solution:
      "Add a table of contents with links to each section. Mark it up with ItemList schema containing ListItem elements with position, name, and url (fragment identifier) properties.",
    category: "content",
    scope: "page",
    severity: "info",
    weight: 3,
    optionsSchema,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const opts = optionsSchema.parse(ctx.options);
    const { pageType, content, headings, document: doc, schemas } = ctx.parsed;
    if (!doc) return { checks: [] };

    // Count h2/h3 headings (sections worth navigating)
    const sectionHeadings = headings.headings.filter(
      (h) => h.level === 2 || h.level === 3
    );

    // Check if article needs TOC
    const isArticle = pageType === "article" || schemas.article !== null;
    const isLongContent = content.wordCount >= opts.min_word_count;
    const hasMultipleSections = sectionHeadings.length >= opts.min_headings;

    if (!isArticle || (!isLongContent && !hasMultipleSections)) {
      checks.push({
        name: "article-toc",
        status: "info",
        message: "TOC not applicable",
        value: `${content.wordCount} words, ${sectionHeadings.length} sections`,
      });
      return { checks };
    }

    // Detect TOC in HTML
    const tocSelectors = [
      'nav[aria-label*="contents" i]',
      'nav[aria-label*="toc" i]',
      ".toc",
      ".table-of-contents",
      ".article-toc",
      "#toc",
      "#table-of-contents",
      '[role="navigation"][aria-label*="contents" i]',
    ];

    let hasToc = false;
    for (const sel of tocSelectors) {
      try {
        if (doc.querySelector(sel)) {
          hasToc = true;
          break;
        }
      } catch {
        // Invalid selector, skip
      }
    }

    // Check for ItemList schema with fragment URLs
    const hasItemListSchema = checkTocSchema(doc);

    if (hasToc && hasItemListSchema) {
      checks.push({
        name: "article-toc",
        status: "pass",
        message: "Table of contents with schema markup",
      });
    } else if (hasToc) {
      checks.push({
        name: "article-toc",
        status: "warn",
        message: "Table of contents missing schema markup",
        value: "Add ItemList schema with ListItem elements",
      });
    } else {
      checks.push({
        name: "article-toc",
        status: "warn",
        message: "Long article without table of contents",
        value: `${content.wordCount} words, ${sectionHeadings.length} sections`,
      });
    }

    return { checks };
  },
};

interface SchemaItem {
  url?: string;
  item?: string;
}

interface ItemListSchema {
  "@type"?: string;
  itemListElement?: SchemaItem[];
}

function checkTocSchema(doc: Document): boolean {
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    try {
      const data = JSON.parse(script.textContent || "") as
        | ItemListSchema
        | ItemListSchema[];
      const schemas: ItemListSchema[] = Array.isArray(data) ? data : [data];
      for (const schema of schemas) {
        if (
          schema["@type"] === "ItemList" &&
          Array.isArray(schema.itemListElement)
        ) {
          // Check if items have fragment URLs (in-page navigation)
          const hasFragmentUrls = schema.itemListElement.some(
            (item) => item.url?.includes("#") || item.item?.includes("#")
          );
          if (hasFragmentUrls) return true;
        }
      }
    } catch {
      // Ignore parse errors - handled by json-ld-valid rule
    }
  }
  return false;
}
