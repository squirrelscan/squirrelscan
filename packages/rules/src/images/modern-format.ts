// images/modern-format - Modern image format check

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const modernFormatRule: Rule = {
  meta: {
    id: "images/modern-format",
    name: "Modern Image Formats",
    description: "Checks for modern image formats like WebP or AVIF",
    solution:
      "Modern formats (WebP, AVIF) offer 25-50% better compression than JPEG/PNG with similar quality. Use <picture> with WebP/AVIF sources and fallbacks. Most browsers support WebP (97%+). AVIF offers even better compression but lower support (~92%). Convert images with tools like cwebp, squoosh, or sharp.",
    category: "images",
    scope: "page",
    severity: "info",
    weight: 3,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const images = doc.querySelectorAll("img[src]");
    const sources = doc.querySelectorAll("source[srcset]");

    if (images.length === 0) {
      checks.push({
        name: "modern-format",
        status: "skipped",
        message: "No images found",
      });
      return { checks };
    }

    let modernCount = 0;
    let legacyCount = 0;
    const modernExtensions = [".webp", ".avif"];
    const legacyExtensions = [".jpg", ".jpeg", ".png", ".gif"];

    // Check img src attributes
    for (const img of images) {
      const src = (img.getAttribute("src") || "").toLowerCase();
      if (modernExtensions.some((ext) => src.includes(ext))) {
        modernCount++;
      } else if (legacyExtensions.some((ext) => src.includes(ext))) {
        legacyCount++;
      }
    }

    // Check source elements (picture element)
    for (const source of sources) {
      const srcset = (source.getAttribute("srcset") || "").toLowerCase();
      const type = (source.getAttribute("type") || "").toLowerCase();
      if (
        type.includes("webp") ||
        type.includes("avif") ||
        modernExtensions.some((ext) => srcset.includes(ext))
      ) {
        modernCount++;
      }
    }

    if (modernCount > 0 && legacyCount === 0) {
      checks.push({
        name: "modern-format",
        status: "pass",
        message: `All ${modernCount} image(s) use modern formats`,
      });
    } else if (modernCount > 0) {
      checks.push({
        name: "modern-format",
        status: "info",
        message: `${modernCount} modern format(s), ${legacyCount} legacy format(s)`,
        value: "Consider converting remaining images to WebP/AVIF",
      });
    } else if (legacyCount > 0) {
      checks.push({
        name: "modern-format",
        status: "info",
        message: `${legacyCount} image(s) using legacy formats (JPEG/PNG)`,
        value: "Consider using WebP or AVIF for better compression",
      });
    }

    return { checks };
  },
};
