// content/author-info - Author markup detection

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const authorInfoRule: Rule = {
  meta: {
    id: "content/author-info",
    name: "Author Info",
    description: "Checks for author markup and attribution",
    solution:
      "Author information supports E-E-A-T (Experience, Expertise, Authoritativeness, Trustworthiness). Use Person schema to mark up authors with name, url, and credentials. Link to author bio pages. Display author names visibly on content. For YMYL topics (health, finance), include author qualifications. Consider using rel='author' links.",
    category: "content",
    scope: "page",
    severity: "info",
    weight: 3,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    // Check for author in schema
    const schemaScripts = doc.querySelectorAll(
      'script[type="application/ld+json"]'
    );
    let hasAuthorSchema = false;
    let authorName: string | null = null;

    for (const script of schemaScripts) {
      const content = script.textContent || "";
      if (content.includes('"author"')) {
        hasAuthorSchema = true;
        // Try to extract author name
        const match = content.match(/"author"[^}]*"name"\s*:\s*"([^"]+)"/);
        if (match) {
          authorName = match[1];
        }
        break;
      }
    }

    if (hasAuthorSchema) {
      checks.push({
        name: "author-schema",
        status: "pass",
        message: "Author schema markup present",
        value: authorName || undefined,
      });
    }

    // Check for rel="author" links
    const authorLinks = doc.querySelectorAll('a[rel="author"]');
    if (authorLinks.length > 0) {
      checks.push({
        name: "author-links",
        status: "pass",
        message: `${authorLinks.length} author link(s) found`,
        value: authorLinks[0].textContent?.trim() || undefined,
      });
    }

    // Check for article:author meta
    const articleAuthor = doc.querySelector('meta[property="article:author"]');
    if (articleAuthor) {
      checks.push({
        name: "og-author",
        status: "pass",
        message: "Open Graph author meta present",
        value: articleAuthor.getAttribute("content") || undefined,
      });
    }

    // Check for common author patterns in HTML
    const authorElements = doc.querySelectorAll(
      '[class*="author"], [class*="byline"], [rel="author"]'
    );
    const hasVisibleAuthor = authorElements.length > 0;

    if (hasVisibleAuthor && !hasAuthorSchema && authorLinks.length === 0) {
      checks.push({
        name: "visible-author",
        status: "info",
        message: "Author element found but no structured data",
        value: "Consider adding author schema markup",
      });
    }

    // Summary if nothing found
    if (
      !hasAuthorSchema &&
      authorLinks.length === 0 &&
      !articleAuthor &&
      !hasVisibleAuthor
    ) {
      checks.push({
        name: "author-info",
        status: "info",
        message: "No author information detected",
        value: "Consider adding author attribution for E-E-A-T",
      });
    }

    return { checks };
  },
};
