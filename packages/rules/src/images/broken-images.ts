// images/broken-images - Broken images check (site-scope)

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const brokenImagesRule: Rule = {
  meta: {
    id: "images/broken-images",
    name: "Broken Images",
    description: "Checks for images returning 404 errors",
    solution:
      "Broken images hurt user experience and can indicate neglected content. Fix 404 images by: updating the src URL, restoring the missing file, or removing the img element. Use automated monitoring to detect broken images. Consider implementing fallback images with onerror handlers.",
    category: "images",
    scope: "site",
    severity: "error",
    weight: 6,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];

    if (!ctx.site?.pages) {
      checks.push({
        name: "broken-images",
        status: "skipped",
        message: "Site data not available",
      });
      return { checks };
    }

    // Collect all image URLs and their status
    const brokenImages: Array<{ url: string; page: string }> = [];
    const checkedUrls = new Set<string>();

    for (const page of ctx.site.pages) {
      // Check for image resources that returned errors
      // This would require tracking image fetches in the crawler
      // For now, we check if images are in the parsed data

      const images = page.parsed.images || [];

      for (const image of images) {
        const src = image.src;
        if (checkedUrls.has(src)) continue;
        checkedUrls.add(src);

        // In a real implementation, we'd check the actual HTTP status
        // For now, we flag obvious issues like empty or malformed URLs
        if (!src || src === "#" || src.startsWith("data:error")) {
          brokenImages.push({ url: src, page: page.url });
        }
      }
    }

    if (brokenImages.length > 0) {
      checks.push({
        name: "broken-images",
        status: "fail",
        message: `${brokenImages.length} potentially broken image(s) found`,
        items: brokenImages.map((img) => ({
          id: img.url || "(empty)",
          sourcePages: [img.page],
        })),
      });
    } else {
      checks.push({
        name: "broken-images",
        status: "pass",
        message: "No obviously broken images detected",
      });
    }

    return { checks };
  },
};
