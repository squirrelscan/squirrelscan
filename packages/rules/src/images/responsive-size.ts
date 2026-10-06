// images/responsive-size - Check image sizing vs display size

import { z } from "zod";

import type { ResourceSizeData } from "@squirrelscan/core-contracts";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { querySelectorAllOutsideNoscript } from "@squirrelscan/utils";

// The evidence is the file's byte size, from the pre-rules resource check;
// natural dimensions are never fetched. A raw 8-bit RGBA bitmap is 4 bytes a
// pixel and a compressed still image of the same pixel count is smaller, so a
// file heavier than the raw bitmap of the displayed box at 2x density is
// heavier than that box needs: more pixels, or extra bit depth or metadata.
// Animation frames are the one cause that is not waste, and GIF, the common
// animated format, is skipped.
const BYTES_PER_PIXEL = 4;
const DEVICE_PIXEL_RATIO = 2;
// Lighthouse's uses-responsive-images ignores savings under 4 KiB.
const MIN_SAVINGS_BYTES = 4096;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

// One url -> bytes index per resource list, not per page: the list is
// site-wide and every page's run reads the same array.
const byteIndexes = new WeakMap<ResourceSizeData[], Map<string, number>>();

interface ImgLike {
  getAttribute(name: string): string | null;
}

/**
 * The source the parser records for an image, and so the one the resource
 * check measured: a lazy-loading attribute first, then `src` (`getImageSrc` in
 * the parser's image extractor).
 */
function recordedSource(img: ImgLike): string | null {
  const src =
    img.getAttribute("data-src") ||
    img.getAttribute("data-original") ||
    img.getAttribute("data-lazy-src") ||
    img.getAttribute("src");
  return src && !src.startsWith("data:") ? src : null;
}

function lastSegment(url: string): string {
  try {
    return new URL(url).pathname.split("/").pop() ?? "";
  } catch {
    return "";
  }
}

/**
 * Pair each live `<img>` with the absolute URL the parser recorded for it, which
 * is the key the resource check measured it under. `extractImages` walks the
 * same elements in document order and records one entry for each with a usable
 * source, resolved against the URL the page was parsed under (the final URL at
 * crawl time, the requested one on a re-parse). Pairing by position rather than
 * by URL keeps two images that resolve to each other's URL under the two bases
 * apart. A pair whose file names disagree means the records do not line up, and
 * that image gets no URL.
 */
function recordedImageUrls(
  imgs: ImgLike[],
  recorded: ReadonlyArray<{ src: string }>,
  pageUrl: string
): Map<ImgLike, string> {
  const urls = new Map<ImgLike, string>();
  let next = 0;
  for (const img of imgs) {
    const src = recordedSource(img);
    if (!src) continue;
    let resolved: string;
    try {
      resolved = new URL(src, pageUrl).toString();
    } catch {
      continue;
    }
    const entry = recorded[next++];
    if (entry && lastSegment(entry.src) === lastSegment(resolved)) urls.set(img, entry.src);
  }
  return urls;
}

function imageBytesIndex(images: ResourceSizeData[]): Map<string, number> {
  let index = byteIndexes.get(images);
  if (!index) {
    index = new Map();
    for (const image of images) {
      const bytes = image.sizeBytes;
      if (typeof bytes === "number" && bytes > 0) index.set(image.url, bytes);
    }
    byteIndexes.set(images, index);
  }
  return index;
}

export const optionsSchema = z.object({
  max_thumbnail_dimension: z
    .number()
    .default(100)
    .describe("Max dimension to consider as thumbnail"),
});

export const responsiveSizeRule: Rule = {
  meta: {
    id: "images/responsive-size",
    name: "Responsive Image Size",
    description:
      "Checks whether small images serve files heavier than their displayed size needs",
    solution:
      "Serve images at the size they are displayed. A thumbnail shown at 64x64 needs at most a 128x128 file for high-density screens; a file much heavier than that wastes bandwidth and slows the page. Generate a thumbnail-sized variant and reference it, or list 1x and 2x candidates in srcset so the browser picks the smallest sharp one. Image CDNs can resize on the fly.",
    category: "images",
    scope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 5,
    optionsSchema,
  },

  run(ctx: RuleContext): RuleResult {
    const opts = optionsSchema.parse(ctx.options);
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;

    if (!doc) {
      checks.push({
        name: "responsive-size",
        status: "skipped",
        message: "No document available",
        skipReason: "Parse error",
      });
      return { checks };
    }

    const images = querySelectorAllOutsideNoscript(doc, "img[src]");

    if (images.length === 0) {
      checks.push({
        name: "responsive-size",
        status: "info",
        message: "No images found on page",
      });
      return { checks };
    }

    const oversizedImages: Array<{ id: string; label: string; meta: Record<string, unknown> }> =
      [];
    let imagesWithSizeInfo = 0;
    const imageBytes = imageBytesIndex(ctx.site?.resourceSizes?.images ?? []);
    const recordedUrls = recordedImageUrls(
      querySelectorAllOutsideNoscript(doc, "img"),
      ctx.parsed.images ?? [],
      ctx.page.finalUrl ?? ctx.page.url
    );

    for (const img of images) {
      const width = img.getAttribute("width");
      const height = img.getAttribute("height");

      if (!width || !height) continue;
      // A percentage is relative to the container, not a pixel size.
      if (width.includes("%") || height.includes("%")) continue;

      // Parse dimensions
      const displayWidth = Number.parseInt(String(width), 10);
      const displayHeight = Number.parseInt(String(height), 10);

      if (Number.isNaN(displayWidth) || Number.isNaN(displayHeight)) continue;
      if (displayWidth === 0 || displayHeight === 0) continue;

      imagesWithSizeInfo++;

      // Check for small display sizes (thumbnails) without srcset
      const isThumbnailSize =
        displayWidth <= opts.max_thumbnail_dimension &&
        displayHeight <= opts.max_thumbnail_dimension;

      const hasSrcset = img.hasAttribute("srcset");
      const isInPicture = img.closest("picture") !== null;

      if (!isThumbnailSize || hasSrcset || isInPicture) continue;

      const src = recordedSource(img);
      const url = recordedUrls.get(img);
      if (!src || !url) continue;
      let resolved: URL;
      try {
        resolved = new URL(url);
      } catch {
        continue;
      }
      // SVG and ICO do not scale by pixel count, and a GIF's frames multiply its
      // bytes, so their size says nothing about their pixel dimensions.
      const path = resolved.pathname.toLowerCase();
      if (
        resolved.protocol === "data:" ||
        path.endsWith(".svg") ||
        path.endsWith(".ico") ||
        path.endsWith(".gif")
      ) {
        continue;
      }

      // No measured size (third-party host, check skipped or failed): no
      // evidence either way, so the image is not reported.
      const bytes = imageBytes.get(url);
      if (bytes === undefined) continue;

      const filename = src.split("/").pop()?.split("?")[0] || src;

      const budgetBytes =
        displayWidth * DEVICE_PIXEL_RATIO * displayHeight * DEVICE_PIXEL_RATIO * BYTES_PER_PIXEL;
      if (bytes - budgetBytes < MIN_SAVINGS_BYTES) continue;

      oversizedImages.push({
        id: `${filename} (${displayWidth}x${displayHeight}, no srcset)`,
        label: `${filename} (${displayWidth}x${displayHeight}, ${formatBytes(bytes)}, no srcset)`,
        meta: { url, sizeBytes: bytes, budgetBytes },
      });
    }

    // Report findings
    if (oversizedImages.length > 0) {
      checks.push({
        name: "images-possibly-oversized",
        status: "warn",
        message: `${oversizedImages.length} small image(s) serve files larger than their displayed size needs`,
        items: oversizedImages.slice(0, 10),
        details:
          oversizedImages.length > 10 ? { additional: oversizedImages.length - 10 } : undefined,
      });
    } else if (imagesWithSizeInfo > 0) {
      checks.push({
        name: "responsive-size",
        status: "pass",
        message: "Image sizes appear appropriate",
        details: { imagesChecked: imagesWithSizeInfo },
      });
    } else {
      checks.push({
        name: "responsive-size",
        status: "info",
        message: "No images with explicit dimensions to check",
      });
    }

    return { checks };
  },
};
