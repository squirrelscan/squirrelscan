// performance/unminified-css - Detect unminified CSS
// Aligns with Lighthouse unminified-css audit

import { z } from "zod";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const optionsSchema = z.object({
  min_size_bytes: z
    .number()
    .default(2048)
    .describe("Minimum CSS size in bytes to check for minification"),
  newline_ratio_threshold: z
    .number()
    .default(0.01)
    .describe(
      "Newlines per character ratio threshold for unminified detection"
    ),
});

// Thresholds for detecting unminified CSS
const NEWLINE_RATIO_THRESHOLD = 0.01; // 1% newlines = likely unminified
const COMMENT_COUNT_THRESHOLD = 3;
const WHITESPACE_RATIO_THRESHOLD = 0.15; // 15% whitespace = likely unminified

/**
 * Analyze CSS content to determine if it's minified
 * Returns potential savings and reasons if unminified
 */
function analyzeCss(css: string): {
  minified: boolean;
  reason?: string;
  potentialSavingsBytes?: number;
} {
  if (!css || css.length < 100) {
    return { minified: true }; // Too small to matter
  }

  const issues: string[] = [];
  let potentialSavings = 0;

  // Count newlines
  const newlines = (css.match(/\n/g) || []).length;
  const newlineRatio = newlines / css.length;

  if (newlineRatio > NEWLINE_RATIO_THRESHOLD) {
    issues.push(`high newlines (${(newlineRatio * 100).toFixed(1)}%)`);
    potentialSavings += newlines; // Each newline could be removed
  }

  // Count comments
  const comments = css.match(/\/\*[\s\S]*?\*\//g) || [];
  const commentBytes = comments.reduce((sum, c) => sum + c.length, 0);
  if (comments.length > COMMENT_COUNT_THRESHOLD) {
    issues.push(`${comments.length} comments`);
    potentialSavings += commentBytes;
  }

  // Count whitespace
  const whitespace = (css.match(/\s+/g) || []).join("");
  const whitespaceRatio = whitespace.length / css.length;

  if (whitespaceRatio > WHITESPACE_RATIO_THRESHOLD) {
    issues.push(
      `excessive whitespace (${(whitespaceRatio * 100).toFixed(1)}%)`
    );
    // Estimate savings: whitespace minus 1 space per occurrence
    const whitespaceMatches = css.match(/\s+/g) || [];
    potentialSavings += whitespaceMatches.reduce(
      (sum, ws) => sum + Math.max(0, ws.length - 1),
      0
    );
  }

  // Check for formatting patterns common in unminified CSS
  const formattedSelectors = (css.match(/\{\s*\n/g) || []).length;
  if (formattedSelectors > 10) {
    issues.push("formatted code blocks");
  }

  if (issues.length > 0) {
    return {
      minified: false,
      reason: issues.join(", "),
      potentialSavingsBytes: potentialSavings,
    };
  }

  return { minified: true };
}

export const unminifiedCssRule: Rule = {
  meta: {
    id: "perf/unminified-css",
    name: "Unminified CSS",
    description: "Detects unminified CSS that could be optimized",
    solution:
      "Minify CSS to reduce file size and improve load times. Use build tools like cssnano, clean-css, or PostCSS with cssnano plugin. Most bundlers (Webpack, Vite, esbuild) can minify CSS automatically in production mode. Minification removes whitespace, comments, and optimizes syntax.",
    category: "perf",
    scope: "page",
    severity: "warning",
    weight: 4,
    optionsSchema,
  },

  run(ctx: RuleContext): RuleResult {
    const opts = optionsSchema.parse(ctx.options);
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const checks: CheckResult[] = [];
    const unminifiedItems: Array<{
      source: string;
      sizeKb: number;
      savingsKb: number;
      reason: string;
    }> = [];

    // Check inline styles
    const styleElements = doc.querySelectorAll("style");
    for (const style of styleElements) {
      const content = style.textContent || "";
      if (content.length < opts.min_size_bytes) continue;

      const result = analyzeCss(content);
      if (!result.minified) {
        const sizeKb = content.length / 1024;
        const savingsKb = (result.potentialSavingsBytes || 0) / 1024;
        unminifiedItems.push({
          source: "inline style",
          sizeKb,
          savingsKb,
          reason: result.reason || "unminified",
        });
      }
    }

    // Track which stylesheets we've already checked (by URL) to avoid duplicates
    const checkedCssUrls = new Set<string>();

    // Check external stylesheets from site data (same-domain CSS with size info)
    if (ctx.site?.resourceSizes?.css) {
      for (const css of ctx.site.resourceSizes.css) {
        checkedCssUrls.add(css.url);
        // We only have size data, not content - can't analyze
        // But we can check if filename suggests unminified
        const url = css.url;
        const sizeBytes = css.sizeBytes || 0;
        if (sizeBytes < opts.min_size_bytes) continue;

        const filename = url.split("/").pop()?.split("?")[0] || url;

        // Check filename patterns suggesting unminified
        const hasMinIndicator =
          filename.includes(".min.") ||
          filename.includes("-min.") ||
          filename.includes(".prod.");

        // Check for hash patterns (bundler output is usually minified)
        const hasHash = /[.-][a-f0-9]{8,}\./i.test(filename);

        if (!hasMinIndicator && !hasHash) {
          // Can't determine - would need content analysis
          // Skip framework files that are typically minified
          const isFramework =
            filename.includes("bootstrap") ||
            filename.includes("tailwind") ||
            filename.includes("normalize");

          if (!isFramework) {
            unminifiedItems.push({
              source: filename,
              sizeKb: sizeBytes / 1024,
              savingsKb: 0, // Unknown without content
              reason: "no .min indicator",
            });
          }
        }
      }
    }

    // ALWAYS check DOM for external stylesheets not in site data (CDN/external resources)
    const linkElements = doc.querySelectorAll('link[rel="stylesheet"]');
    for (const link of linkElements) {
      const href = link.getAttribute("href") || "";
      if (!href) continue;

      // Skip if already checked via site.resourceSizes.css
      if (checkedCssUrls.has(href)) continue;

      const filename = href.split("/").pop()?.split("?")[0] || href;

      const hasMinIndicator =
        filename.includes(".min.") ||
        filename.includes("-min.") ||
        filename.includes(".prod.");

      const hasHash = /[.-][a-f0-9]{8,}\./i.test(filename);

      if (!hasMinIndicator && !hasHash) {
        const isFramework =
          filename.includes("bootstrap") ||
          filename.includes("tailwind") ||
          filename.includes("normalize") ||
          filename.includes("cdn");

        if (!isFramework && filename.endsWith(".css")) {
          unminifiedItems.push({
            source: filename,
            sizeKb: 0,
            savingsKb: 0,
            reason: "no .min indicator",
          });
        }
      }
    }

    // Report findings
    const confirmedUnminified = unminifiedItems.filter(
      (i) => i.reason !== "no .min indicator"
    );
    const suspectedUnminified = unminifiedItems.filter(
      (i) => i.reason === "no .min indicator"
    );

    if (confirmedUnminified.length > 0) {
      const totalSavingsKb = confirmedUnminified.reduce(
        (sum, i) => sum + i.savingsKb,
        0
      );
      checks.push({
        name: "unminified-css",
        status: "warn",
        message: `${confirmedUnminified.length} CSS file(s) appear unminified`,
        items: confirmedUnminified.slice(0, 5).map((i) => ({
          id: i.source,
          label: `${i.sizeKb.toFixed(1)}KB, ~${i.savingsKb.toFixed(1)}KB savings`,
          meta: { reason: i.reason },
        })),
        details: {
          totalPotentialSavingsKb: totalSavingsKb.toFixed(1),
          ...(confirmedUnminified.length > 5
            ? { additional: confirmedUnminified.length - 5 }
            : {}),
        },
      });
    }

    if (suspectedUnminified.length > 0) {
      checks.push({
        name: "potentially-unminified-css",
        status: "info",
        message: `${suspectedUnminified.length} stylesheet(s) may not be minified`,
        items: suspectedUnminified.slice(0, 5).map((i) => ({
          id: i.source,
          label: i.sizeKb > 0 ? `${i.sizeKb.toFixed(1)}KB` : undefined,
        })),
        details: { note: "Files without .min in name - verify if minified" },
      });
    }

    if (confirmedUnminified.length === 0 && suspectedUnminified.length === 0) {
      checks.push({
        name: "minified-css",
        status: "pass",
        message: "CSS appears to be minified",
      });
    }

    return { checks };
  },
};
