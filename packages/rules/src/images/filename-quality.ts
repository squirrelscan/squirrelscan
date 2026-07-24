// images/filename-quality - Image filename quality check

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const filenameQualityRule: Rule = {
  meta: {
    id: "images/filename-quality",
    name: "Image Filename Quality",
    description: "Checks for descriptive image filenames",
    solution:
      "Use descriptive, keyword-rich filenames for images instead of generic names like IMG_001.jpg or DSC1234.png. Good: 'red-running-shoes-nike.jpg'. Bad: 'IMG_20231015.jpg'. Filenames contribute to image SEO and help search engines understand image content. Use hyphens to separate words.",
    category: "images",
    scope: "page",
    severity: "info",
    weight: 2,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const images = doc.querySelectorAll("img[src]");

    if (images.length === 0) {
      checks.push({
        name: "filename-quality",
        status: "skipped",
        message: "No images found",
      });
      return { checks };
    }

    // Patterns that indicate poor filenames
    const poorPatterns = [
      /^IMG[_-]?\d+/i, // IMG_001, IMG-001
      /^DSC[_-]?\d+/i, // DSC1234
      /^DCIM[_-]?\d+/i, // DCIM001
      /^P\d{6,}/i, // P20231015
      /^image\d+/i, // image1, image2
      /^photo\d+/i, // photo1
      /^pic\d+/i, // pic1
      /^screenshot[_-]?\d*/i, // screenshot, screenshot_1
      /^screen[_-]?shot/i, // screen shot
      /^untitled/i, // untitled
      /^\d{8,}/, // Just numbers (timestamps)
      /^[a-f0-9]{32}/i, // MD5 hashes
      /^[a-f0-9-]{36}/i, // UUIDs
    ];

    let poorFilenames = 0;
    let goodFilenames = 0;
    const poorExamples: string[] = [];

    for (const img of images) {
      const src = img.getAttribute("src") || "";
      // Extract filename from path
      const filename = src.split("/").pop()?.split("?")[0] || "";

      // Skip data URIs and SVGs
      if (src.startsWith("data:") || filename.endsWith(".svg")) {
        continue;
      }

      const nameWithoutExt = filename.replace(/\.[^.]+$/, "");

      const isPoor = poorPatterns.some((pattern) =>
        pattern.test(nameWithoutExt)
      );

      if (isPoor) {
        poorFilenames++;
        if (poorExamples.length < 3) {
          poorExamples.push(filename);
        }
      } else if (nameWithoutExt.length > 0) {
        goodFilenames++;
      }
    }

    if (poorFilenames === 0 && goodFilenames > 0) {
      checks.push({
        name: "filename-quality",
        status: "pass",
        message: `All ${goodFilenames} image(s) have descriptive filenames`,
      });
    } else if (poorFilenames > 0) {
      checks.push({
        name: "filename-quality",
        status: "info",
        message: `${poorFilenames} image(s) with non-descriptive filenames`,
        items: poorExamples.map((filename) => ({ id: filename })),
      });
    }

    return { checks };
  },
};
