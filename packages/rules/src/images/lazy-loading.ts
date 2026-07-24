// images/lazy-loading - Lazy loading check

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const lazyLoadingRule: Rule = {
  meta: {
    id: "images/lazy-loading",
    name: "Lazy Loading",
    description: "Checks for lazy loading on below-fold images",
    solution:
      "Use loading='lazy' on images below the fold to defer loading until needed. This improves initial page load and saves bandwidth. Native lazy loading is supported by all modern browsers. Don't lazy load above-fold images (especially LCP candidates). Consider loading='eager' for critical images.",
    category: "images",
    scope: "page",
    severity: "info",
    weight: 3,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const images = doc.querySelectorAll("img");

    if (images.length === 0) {
      checks.push({
        name: "lazy-loading",
        status: "skipped",
        message: "No images found",
      });
      return { checks };
    }

    let lazyCount = 0;
    let noAttrCount = 0;

    for (const img of images) {
      const loading = img.getAttribute("loading");
      if (loading === "lazy") {
        lazyCount++;
      } else if (loading !== "eager") {
        noAttrCount++;
      }
    }

    // Iframes can also be lazy loaded
    const iframes = doc.querySelectorAll("iframe");
    let lazyIframes = 0;
    for (const iframe of iframes) {
      if (iframe.getAttribute("loading") === "lazy") {
        lazyIframes++;
      }
    }

    if (lazyCount > 0 || lazyIframes > 0) {
      const totalLazy = lazyCount + lazyIframes;
      checks.push({
        name: "lazy-loading",
        status: "pass",
        message: `${totalLazy} element(s) use lazy loading`,
      });

      if (noAttrCount > 0) {
        checks.push({
          name: "lazy-loading-missing",
          status: "info",
          message: `${noAttrCount} image(s) without loading attribute`,
          value: "Consider adding loading='lazy' for below-fold images",
        });
      }
    } else if (images.length > 3) {
      // Only suggest lazy loading if there are multiple images
      checks.push({
        name: "lazy-loading",
        status: "info",
        message: `${images.length} images without lazy loading`,
        value: "Add loading='lazy' to below-fold images",
      });
    } else {
      checks.push({
        name: "lazy-loading",
        status: "info",
        message: `${images.length} image(s) found, no lazy loading detected`,
      });
    }

    return { checks };
  },
};
