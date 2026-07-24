// a11y/image-redundant-alt - Image alt not redundant with surrounding text

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

// Common redundant alt text patterns
// Expanded based on Lighthouse and common usage
const redundantPatterns = [
  // Original patterns
  /^image$/i,
  /^image of/i,
  /^photo$/i,
  /^photo of/i,
  /^photograph$/i,
  /^photograph of/i,
  /^picture$/i,
  /^picture of/i,
  /^graphic$/i,
  /^graphic of/i,
  /^icon$/i,
  /^icon of/i,
  /^logo$/i,
  /^banner$/i,
  // Technical/diagram types
  /^illustration$/i,
  /^illustration of/i,
  /^diagram$/i,
  /^diagram of/i,
  /^screenshot$/i,
  /^screenshot of/i,
  /^chart$/i,
  /^chart of/i,
  /^graph$/i,
  /^graph of/i,
  /^figure$/i,
  /^figure of/i,
  /^infographic$/i,
  /^infographic of/i,
  // File references
  /^img$/i,
  /^\.jpg$/i,
  /^\.png$/i,
  /^\.gif$/i,
  /^\.webp$/i,
  /^\.svg$/i,
  // Common lazy patterns
  /^thumbnail$/i,
  /^hero image$/i,
  /^cover image$/i,
  /^featured image$/i,
  /^placeholder$/i,
  /^untitled$/i,
  /^spacer$/i,
  /^divider$/i,
];

export const imageRedundantAltRule: Rule = {
  meta: {
    id: "a11y/image-redundant-alt",
    name: "Redundant Image Alt",
    description:
      "Checks that image alt text is not redundant with surrounding text",
    solution:
      "Image alt text should not start with 'image of', 'photo of', 'picture of', etc. Screen readers already announce that it's an image. Alt text should describe the content or function, not state the obvious. Also avoid duplicating adjacent text in the alt.",
    category: "a11y",
    scope: "page",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const images = doc.querySelectorAll("img[alt]");
    const redundantAlts: string[] = [];

    for (const img of images) {
      const alt = img.getAttribute("alt")?.trim() || "";
      if (!alt) continue; // Empty alt is valid for decorative

      // Check for redundant patterns
      for (const pattern of redundantPatterns) {
        if (pattern.test(alt)) {
          const src = img.getAttribute("src") || "";
          const filename = src.split("/").pop()?.split("?")[0] || "";
          redundantAlts.push(
            `"${alt.slice(0, 30)}${alt.length > 30 ? "..." : ""}" (${filename})`
          );
          break;
        }
      }

      // Check if alt duplicates filename
      const src = img.getAttribute("src") || "";
      const filename =
        src
          .split("/")
          .pop()
          ?.split("?")[0]
          ?.replace(/\.[^.]+$/, "") || "";
      if (filename && filename.length > 3) {
        const normalizedAlt = alt.toLowerCase().replace(/[-_\s]+/g, "");
        const normalizedFilename = filename
          .toLowerCase()
          .replace(/[-_\s]+/g, "");

        if (normalizedAlt === normalizedFilename) {
          redundantAlts.push(`alt="${alt}" matches filename`);
        }
      }

      // Check if alt duplicates adjacent text (parent or sibling)
      const parent = img.parentElement;
      if (parent) {
        const parentText = parent.textContent?.trim().toLowerCase() || "";
        const altLower = alt.toLowerCase();

        // If parent contains exact alt text (and parent has more text)
        if (parentText.length > alt.length && parentText.includes(altLower)) {
          // More lenient: only flag if alt is substantial part of parent text
          if (alt.length > 10 && parentText.length < alt.length * 3) {
            redundantAlts.push(
              `"${alt.slice(0, 20)}..." duplicates surrounding text`
            );
          }
        }

        // Check if image is inside <figure> with <figcaption>
        const figure =
          parent.tagName.toLowerCase() === "figure"
            ? parent
            : parent.closest?.("figure");
        if (figure) {
          const figcaption = figure.querySelector("figcaption");
          if (figcaption) {
            const captionText =
              figcaption.textContent?.trim().toLowerCase() || "";
            // Flag if alt exactly matches or is substring of figcaption
            if (captionText && altLower.length > 5) {
              if (captionText === altLower || captionText.includes(altLower)) {
                redundantAlts.push(
                  `"${alt.slice(0, 20)}..." duplicates figcaption`
                );
              }
            }
          }
        }
      }
    }

    // Deduplicate
    const uniqueIssues = [...new Set(redundantAlts)];

    if (uniqueIssues.length > 0) {
      checks.push({
        name: "image-redundant-alt",
        status: "warn",
        message: `${uniqueIssues.length} image(s) with redundant alt text`,
        items: uniqueIssues.slice(0, 10).map((id) => ({ id })),
        details:
          uniqueIssues.length > 10
            ? { additional: uniqueIssues.length - 10 }
            : undefined,
      });
    } else if (images.length > 0) {
      checks.push({
        name: "image-redundant-alt",
        status: "pass",
        message: "No redundant image alt text found",
        details: { imagesChecked: images.length },
      });
    } else {
      checks.push({
        name: "image-redundant-alt",
        status: "info",
        message: "No images with alt text found",
      });
    }

    return { checks };
  },
};
