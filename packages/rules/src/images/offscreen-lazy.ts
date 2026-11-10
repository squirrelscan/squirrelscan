// images/offscreen-lazy - Offscreen images lazy loading

import { z } from "zod";

import { elementSelector } from "../element-path";
import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { querySelectorAllOutsideNoscript } from "@squirrelscan/utils";
import { initialViewportFlags } from "@squirrelscan/utils/image-loading";

export const optionsSchema = z.object({
  above_fold_count: z
    .number()
    .default(3)
    .describe(
      "Number of content images considered above the fold (icons and logos declared with width and height do not count)"
    ),
});

const SNIPPET_MAX_CHARS = 160;

function filenameOf(url: string): string {
  return url.split("/").pop()?.split("?")[0] || url;
}

/** The first URL of a `srcset`/`data-srcset` value (the part before a width or density descriptor). */
function firstSrcsetUrl(value: string | null): string {
  return value?.trim().split(/[\s,]+/)[0] ?? "";
}

/**
 * How an item names its image. A real `src` gives its filename, as before. An empty `src` (the
 * source is filled in later by script) falls back to the `data-src` file, then the `srcset` or
 * `data-srcset` file, then the element's selector with a short snippet of its tag (#1644), so an
 * item never has an empty id.
 */
function itemFor(img: Element): { id: string; snippet?: string } {
  const src = (img.getAttribute("src") || "").trim();
  if (src) return { id: filenameOf(src) };
  const fallback =
    (img.getAttribute("data-src") || "").trim() ||
    firstSrcsetUrl(img.getAttribute("srcset")) ||
    firstSrcsetUrl(img.getAttribute("data-srcset"));
  if (fallback) return { id: filenameOf(fallback) };
  const tag = (img.outerHTML || "<img>").replace(/\s+/g, " ");
  const snippet =
    tag.length > SNIPPET_MAX_CHARS ? `${tag.slice(0, SNIPPET_MAX_CHARS - 1)}…` : tag;
  return { id: elementSelector(img), snippet };
}

export const offscreenLazyRule: Rule = {
  meta: {
    id: "images/offscreen-lazy",
    name: "Offscreen Image Lazy Loading",
    description: "Checks if offscreen images use lazy loading",
    solution:
      "Add loading='lazy' to images below the fold to defer loading until needed. This reduces initial page load time and saves bandwidth. Exception: Don't lazy-load LCP image or above-the-fold content. Use loading='eager' for critical images.",
    category: "images",
    scope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 5,
    optionsSchema,
  },

  run(ctx: RuleContext): RuleResult {
    const opts = optionsSchema.parse(ctx.options);
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const checks: CheckResult[] = [];

    const images = querySelectorAllOutsideNoscript(doc, "img[src]");

    if (images.length === 0) {
      checks.push({
        name: "offscreen-lazy",
        status: "info",
        message: "No images found",
      });
      return { checks };
    }

    const imagesArray = Array.from(images);
    // Below the fold is the images after the first `above_fold_count` CONTENT
    // images, not after the first N elements: with no layout to measure, an
    // image declared at icon or logo size (both width and height) neither fills
    // the budget nor, before it is full, counts as below the fold (#1250).
    const inViewport = initialViewportFlags(
      imagesArray.map((img) => ({
        width: img.getAttribute("width"),
        height: img.getAttribute("height"),
      })),
      opts.above_fold_count
    );
    const belowFoldImages = imagesArray.filter((_, index) => !inViewport[index]);

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
    const missingLazy: Array<{ id: string; snippet?: string }> = [];

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
        missingLazy.push(itemFor(img));
      }
    }

    // Report findings
    if (missingLazy.length > 0) {
      checks.push({
        name: "offscreen-images-not-lazy",
        status: "warn",
        message: `${missingLazy.length} below-fold image(s) without lazy loading`,
        items: missingLazy.slice(0, 10),
        details: {
          // How "below the fold" was decided: document order, no layout (#1644).
          aboveFoldCount: opts.above_fold_count,
          belowFoldBasis:
            "images after the first above_fold_count content images in document order; no viewport is measured in an HTTP-only audit",
          ...(missingLazy.length > 10 ? { additional: missingLazy.length - 10 } : {}),
        },
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
