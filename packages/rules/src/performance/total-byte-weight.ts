// performance/total-byte-weight - Total page weight check
// Aligns with Lighthouse total-byte-weight audit

import { z } from "zod";

import type { CheckResult, ParsedPage, Rule, RuleContext, RuleResult } from "../types";

/**
 * Per-page byte-weight signal read off a live DOM (#1021 E-E2). Shared by the
 * page-time collector (buildCollectedPageSignal) and this rule's legacy
 * `site.pages` fallback so both produce byte-identical sums. `inlineCssLen` /
 * `inlineJsLen` feed the total; the external `*Count`s feed the no-resource-data
 * estimate branch (used only for the first page).
 */
export function extractPageByteSignal(doc: NonNullable<ParsedPage["document"]>): {
  inlineCssLen: number;
  inlineJsLen: number;
  externalCssCount: number;
  externalJsCount: number;
  imageCount: number;
} {
  let inlineCssLen = 0;
  for (const style of doc.querySelectorAll("style")) {
    inlineCssLen += (style.textContent || "").length;
  }

  let inlineJsLen = 0;
  for (const script of doc.querySelectorAll("script:not([src])")) {
    // Skip JSON-LD and other data scripts
    const type = script.getAttribute("type") || "";
    if (!type.includes("json") && !type.includes("template")) {
      inlineJsLen += (script.textContent || "").length;
    }
  }

  return {
    inlineCssLen,
    inlineJsLen,
    externalCssCount: doc.querySelectorAll('link[rel="stylesheet"]').length,
    externalJsCount: doc.querySelectorAll("script[src]").length,
    imageCount: doc.querySelectorAll("img[src]").length,
  };
}

export const optionsSchema = z.object({
  warn_threshold_kb: z
    .number()
    .default(1600)
    .describe("Warning threshold for total page weight in KB"),
  error_threshold_kb: z
    .number()
    .default(5000)
    .describe("Error threshold for total page weight in KB"),
});

export const totalByteWeightRule: Rule = {
  meta: {
    id: "perf/total-byte-weight",
    name: "Total Page Weight",
    description: "Checks the total byte weight of the page",
    solution:
      "Reduce total page weight for faster loads on slow connections. Optimize images (use modern formats, compress, serve appropriate sizes). Minify and compress CSS/JS. Remove unused code via tree-shaking. Lazy-load non-critical resources. Target under 1.6MB for mobile users.",
    category: "perf",
    scope: "site",
    severity: "warning",
    weight: 6,
    optionsSchema,
  },

  run(ctx: RuleContext): RuleResult {
    const opts = optionsSchema.parse(ctx.options);
    const checks: CheckResult[] = [];

    // Aggregate sizes from various sources across ALL pages
    const sizes = {
      html: 0,
      inlineCss: 0,
      externalCss: 0,
      inlineJs: 0,
      externalJs: 0,
      images: 0,
      fonts: 0,
      other: 0,
    };

    // Track unique resources to avoid double-counting
    const countedCssUrls = new Set<string>();
    const countedJsUrls = new Set<string>();
    const countedImageUrls = new Set<string>();

    // Aggregate inline CSS/JS across all pages. In the streaming engine (#1021)
    // the per-page DOM scan happened at page-time — read the collected sums;
    // otherwise fall back to scanning each live `site.pages` document (v1).
    const pages = ctx.site?.pages ?? [];
    const collected = ctx.collectedSignals;
    if (collected) {
      for (const rec of collected.pages) {
        sizes.inlineCss += rec.inlineCssLen;
        sizes.inlineJs += rec.inlineJsLen;
      }
    } else {
      for (const page of pages) {
        const doc = page.parsed?.document;
        if (!doc) continue;
        const s = extractPageByteSignal(doc);
        sizes.inlineCss += s.inlineCssLen;
        sizes.inlineJs += s.inlineJsLen;
      }
    }

    // External CSS sizes from site data (already deduplicated by URL)
    if (ctx.site?.resourceSizes?.css) {
      for (const css of ctx.site.resourceSizes.css) {
        if (!countedCssUrls.has(css.url)) {
          sizes.externalCss += css.sizeBytes || 0;
          countedCssUrls.add(css.url);
        }
      }
    }

    // External JS sizes from scripts data (already deduplicated by URL)
    if (ctx.site?.scripts) {
      for (const script of ctx.site.scripts) {
        if (!countedJsUrls.has(script.url)) {
          sizes.externalJs += script.sizeBytes || 0;
          countedJsUrls.add(script.url);
        }
      }
    }

    // Image sizes from site data (already deduplicated by URL)
    if (ctx.site?.resourceSizes?.images) {
      for (const img of ctx.site.resourceSizes.images) {
        if (!countedImageUrls.has(img.url)) {
          sizes.images += img.sizeBytes || 0;
          countedImageUrls.add(img.url);
        }
      }
    }

    // Calculate totals
    const totalCss = sizes.inlineCss + sizes.externalCss;
    const totalJs = sizes.inlineJs + sizes.externalJs;
    const totalKnownBytes =
      sizes.html + totalCss + totalJs + sizes.images + sizes.fonts;
    const totalKnownKb = totalKnownBytes / 1024;

    // Determine what data we have
    const hasExternalResourceData =
      ctx.site?.resourceSizes || ctx.site?.scripts;

    // Build detailed breakdown
    const details: Record<string, string | number | boolean> = {
      pagesAnalyzed: pages.length,
    };

    if (totalCss > 0) {
      details.css = `${(totalCss / 1024).toFixed(0)}KB`;
      if (sizes.inlineCss > 0 && sizes.externalCss > 0) {
        details.cssBreakdown = `inline: ${(sizes.inlineCss / 1024).toFixed(0)}KB, external: ${(sizes.externalCss / 1024).toFixed(0)}KB`;
      }
      details.cssFiles = countedCssUrls.size;
    }

    if (totalJs > 0) {
      details.js = `${(totalJs / 1024).toFixed(0)}KB`;
      if (sizes.inlineJs > 0 && sizes.externalJs > 0) {
        details.jsBreakdown = `inline: ${(sizes.inlineJs / 1024).toFixed(0)}KB, external: ${(sizes.externalJs / 1024).toFixed(0)}KB`;
      }
      details.jsFiles = countedJsUrls.size;
    }

    if (sizes.images > 0) {
      details.images = `${(sizes.images / 1024).toFixed(0)}KB`;
      details.imageFiles = countedImageUrls.size;
    }

    // If we don't have external resource data, estimate based on first page
    let estimatedTotal = totalKnownKb;
    let isEstimate = false;

    if (!hasExternalResourceData && pages.length > 0) {
      // External resource counts for the FIRST page — from the page-time collector
      // (streaming) or the first live document (v1). Both resolve to the same page
      // (site.pages[0] is the first HTML page; collected.pages[0] mirrors it).
      const firstExternal = collected
        ? collected.pages[0]
        : (() => {
            const doc = pages[0]?.parsed?.document;
            return doc ? extractPageByteSignal(doc) : undefined;
          })();
      if (firstExternal) {
        const externalCssCount = firstExternal.externalCssCount;
        const externalJsCount = firstExternal.externalJsCount;
        const imageCount = firstExternal.imageCount;

        // Conservative estimates (KB per resource)
        const avgCssSize = 30; // KB
        const avgJsSize = 50; // KB
        const avgImageSize = 100; // KB

        const estimatedCss = externalCssCount * avgCssSize;
        const estimatedJs = externalJsCount * avgJsSize;
        const estimatedImages = imageCount * avgImageSize;

        estimatedTotal =
          (sizes.inlineCss + sizes.inlineJs) / 1024 +
          estimatedCss +
          estimatedJs +
          estimatedImages;

        isEstimate = true;

        details.estimated = true;
        details.externalCssCount = externalCssCount;
        details.externalJsCount = externalJsCount;
        details.imageCount = imageCount;
      }
    }

    // Report total weight
    const reportTotal = isEstimate ? estimatedTotal : totalKnownKb;
    const totalLabel = isEstimate
      ? "Estimated total"
      : "Total tracked resources";

    if (reportTotal < opts.warn_threshold_kb) {
      checks.push({
        name: "total-byte-weight",
        status: "pass",
        message: `${totalLabel}: ${reportTotal.toFixed(0)}KB`,
        value: `${reportTotal.toFixed(0)}KB`,
        expected: `< ${opts.warn_threshold_kb}KB`,
        details,
      });
    } else if (reportTotal < opts.error_threshold_kb) {
      checks.push({
        name: "total-byte-weight",
        status: "warn",
        message: `${totalLabel}: ${reportTotal.toFixed(0)}KB (heavy page)`,
        value: `${reportTotal.toFixed(0)}KB`,
        expected: `< ${opts.warn_threshold_kb}KB`,
        details,
      });
    } else {
      checks.push({
        name: "total-byte-weight",
        status: "fail",
        message: `${totalLabel}: ${reportTotal.toFixed(0)}KB (very heavy)`,
        value: `${reportTotal.toFixed(0)}KB`,
        expected: `< ${opts.error_threshold_kb}KB`,
        details,
      });
    }

    return { checks };
  },
};
