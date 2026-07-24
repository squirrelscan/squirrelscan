// eeat/author-byline - Author names on content pages

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { flattenJsonLdNodes, getPathname } from "@squirrelscan/utils";

export const authorBylineRule: Rule = {
  meta: {
    id: "eeat/author-byline",
    name: "Author Bylines",
    description: "Checks for visible author names on content pages",
    solution:
      "Author bylines demonstrate experience and accountability. Show author names prominently on articles, blog posts, and expert content. Include author credentials where relevant. Link author names to bio pages. For YMYL content (health, finance), author transparency is especially important for Google's E-E-A-T assessment.",
    category: "eeat",
    scope: "site",
    severity: "warning",
    weight: 5,
    // Author bylines are an E-E-A-T signal for editorial / content sites. They're
    // noise on a SaaS marketing site or landing page (no articles to attribute).
    // Gate to content-publishing site types; offline / no-metadata runs as today.
    appliesWhen: { siteTypes: ["blog", "news", "healthcare_provider", "education", "nonprofit"] },
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const pages = ctx.site?.pages;

    if (!pages || pages.length === 0) {
      checks.push({
        name: "author-byline",
        status: "skipped",
        message: "No pages available for analysis",
      });
      return { checks };
    }

    let pagesWithAuthor = 0;
    let contentPages = 0;

    for (const page of pages) {
      // Skip non-content pages (based on URL patterns)
      const path = getPathname(page.url);
      const isContentPage =
        /\/(blog|article|post|news|guide|how-to|review)/i.test(path) ||
        page.parsed.schema.types.includes("Article") ||
        page.parsed.schema.types.includes("BlogPosting") ||
        page.parsed.schema.types.includes("NewsArticle") ||
        // Visible byline markup (Kadence-style entry pages) marks article
        // content even without a recognized URL slug or JSON-LD Article schema.
        page.parsed.visibleAuthor != null;

      if (!isContentPage && pages.length > 5) continue;
      contentPages++;

      // Check for author indicators in schema. The parser's extracted
      // author already handles @graph (incl. @id-referenced Person nodes);
      // fall back to scanning all flattened JSON-LD nodes (top-level-only
      // checks miss Yoast-style @graph sites).
      let hasAuthor = page.parsed.author !== null;
      if (!hasAuthor && page.parsed.schema.raw) {
        hasAuthor = flattenJsonLdNodes(page.parsed.schema.raw).some(
          (s) => s["author"]
        );
      }
      // Fall back to visible byline markup (hCard `.author.vcard .fn`,
      // `rel="author"`, etc.) for themes (Kadence et al.) that omit JSON-LD
      // author. Org-level / footer noise is already filtered by the parser.
      if (!hasAuthor && page.parsed.visibleAuthor) {
        hasAuthor = true;
      }

      if (hasAuthor) {
        pagesWithAuthor++;
      }
    }

    if (contentPages === 0) {
      checks.push({
        name: "author-byline",
        status: "info",
        message: "No content pages detected for author analysis",
      });
      return { checks };
    }

    const authorPercentage = Math.round((pagesWithAuthor / contentPages) * 100);

    if (authorPercentage >= 80) {
      checks.push({
        name: "author-byline",
        status: "pass",
        message: `${authorPercentage}% of content pages have author attribution`,
        value: `${pagesWithAuthor}/${contentPages} pages`,
      });
    } else if (authorPercentage >= 50) {
      checks.push({
        name: "author-byline",
        status: "info",
        message: `${authorPercentage}% of content pages have author attribution`,
        value: "Consider adding authors to more content",
      });
    } else {
      checks.push({
        name: "author-byline",
        status: "warn",
        message:
          pagesWithAuthor === 0
            ? "No content pages have author attribution"
            : `Only ${authorPercentage}% of content pages have author attribution`,
        value: "Add author bylines to build E-E-A-T",
      });
    }

    return { checks };
  },
};
