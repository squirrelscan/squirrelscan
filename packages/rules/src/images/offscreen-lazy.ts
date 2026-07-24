// images/offscreen-lazy - Offscreen images lazy loading

import { z } from "zod";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const optionsSchema = z.object({
  above_fold_count: z
    .number()
    .default(3)
    .describe("Number of images considered above the fold"),
});

export const offscreenLazyRule: Rule = {
  meta: {
    id: "images/offscreen-lazy",
    name: "Offscreen Image Lazy Loading",
    description: "Checks if offscreen images use lazy loading",
    solution:
      "Add loading='lazy' to images below the fold to defer loading until needed. This reduces initial page load time and saves bandwidth. Exception: Don't lazy-load LCP image or above-the-fold content. Use loading='eager' for critical images.",
    category: "images",
    scope: "page",
    severity: "warning",
    weight: 5,
    optionsSchema,
  },

  run(ctx: RuleContext): RuleResult {
    const opts = optionsSchema.parse(ctx.options);
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const checks: CheckResult[] = [];

    const images = doc.querySelectorAll("img[src]");

    if (images.length === 0) {
      checks.push({
        name: "offscreen-lazy",
        status: "info",
        message: "No images found",
      });
      return { checks };
    }

    const imagesArray = Array.from(images);
    const belowFoldImages = imagesArray.slice(opts.above_fold_count);

    if (belowFoldImages.length === 0) {
      checks.push({
        name: "offscreen-lazy",
        status: "pass",
        message: "Few images on page - lazy loading not critical",
        details: { totalImages: imagesArray.length },
      });
      return { checks };
    }

    let lazyCount = 0;
    let eagerBelowFold = 0;
    const missingLazy: string[] = [];

    for (const img of belowFoldImages) {
      const loading = img.getAttribute("loading");
      const src = img.getAttribute("src") || "";

      // Skip data URIs and tiny images (likely icons)
      if (src.startsWith("data:")) continue;

      if (loading === "lazy") {
        lazyCount++;
      } else if (loading === "eager") {
        eagerBelowFold++;
      } else {
        // No loading attribute - suggest lazy
        const filename = src.split("/").pop()?.split("?")[0] || src;
        missingLazy.push(filename);
      }
    }

    // Report findings
    if (missingLazy.length > 0) {
      checks.push({
        name: "offscreen-images-not-lazy",
        status: "warn",
        message: `${missingLazy.length} below-fold image(s) without lazy loading`,
        items: missingLazy.slice(0, 10).map((id) => ({ id })),
        details:
          missingLazy.length > 10
            ? { additional: missingLazy.length - 10 }
            : undefined,
      });
    }

    if (lazyCount > 0) {
      checks.push({
        name: "lazy-loading-used",
        status: "pass",
        message: `${lazyCount} image(s) use lazy loading`,
      });
    }

    if (eagerBelowFold > 0) {
      checks.push({
        name: "eager-below-fold",
        status: "info",
        message: `${eagerBelowFold} below-fold image(s) explicitly set to eager`,
        details: { note: "May be intentional for critical images" },
      });
    }

    if (missingLazy.length === 0 && lazyCount === 0) {
      checks.push({
        name: "offscreen-lazy",
        status: "info",
        message: "No lazy loading configured - consider adding loading='lazy'",
      });
    }

    return { checks };
  },
};
