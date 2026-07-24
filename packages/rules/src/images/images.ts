// Validate images for SEO (alt text + dimensions/CLS)
import type { CheckResult, ImageData } from "@squirrelscan/core-contracts";

export function validateImages(images: ImageData[]): CheckResult[] {
  const checks: CheckResult[] = [];
  const missingAlt: string[] = [];
  const emptyAlt: string[] = [];
  const missingDimensions: string[] = [];

  for (const img of images) {
    // Skip data URIs and SVGs for alt check (often decorative)
    if (img.src.startsWith("data:") || img.src.endsWith(".svg")) {
      continue;
    }

    // Check for missing alt attribute
    if (img.alt === null) {
      missingAlt.push(img.src);
    } else if (img.alt.trim() === "") {
      // Empty alt is valid for decorative images, but track it
      emptyAlt.push(img.src);
    }

    // Check for dimensions (good for CLS)
    if (!img.width || !img.height) {
      missingDimensions.push(img.src);
    }
  }

  // Alt text checks
  if (missingAlt.length > 0) {
    checks.push({
      name: "image-alt",
      status: "fail",
      message: `${missingAlt.length} image(s) missing alt attribute`,
      items: missingAlt.map((src) => ({ id: src })),
    });
  } else if (emptyAlt.length > images.length * 0.5 && images.length > 2) {
    // More than half have empty alt - might be an issue
    checks.push({
      name: "image-alt",
      status: "warn",
      message: `${emptyAlt.length} of ${images.length} images have empty alt (decorative?)`,
      value: null,
    });
  } else {
    checks.push({
      name: "image-alt",
      status: "pass",
      message: "All images have alt attributes",
      value: `${images.length} images checked`,
    });
  }

  // Dimension checks (for CLS)
  if (missingDimensions.length > 0 && images.length > 0) {
    const percentage = Math.round(
      (missingDimensions.length / images.length) * 100
    );
    if (percentage > 50) {
      checks.push({
        name: "image-dimensions",
        status: "warn",
        message: `${missingDimensions.length} images missing width/height (may cause CLS)`,
        value: `${percentage}% of images`,
      });
    }
  }

  return checks;
}
