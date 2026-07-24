// content/mime-type - Validates Content-Type header matches file extension

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

// Expected MIME types by extension
const MIME_TYPE_MAP: Record<string, string[]> = {
  // JavaScript
  ".js": ["application/javascript", "text/javascript"],
  ".mjs": ["application/javascript", "text/javascript"],
  ".cjs": ["application/javascript", "text/javascript"],

  // CSS
  ".css": ["text/css"],

  // Images
  ".jpg": ["image/jpeg"],
  ".jpeg": ["image/jpeg"],
  ".png": ["image/png"],
  ".gif": ["image/gif"],
  ".webp": ["image/webp"],
  ".svg": ["image/svg+xml"],
  ".ico": ["image/x-icon", "image/vnd.microsoft.icon"],
  ".avif": ["image/avif"],

  // Fonts
  ".woff": ["font/woff", "application/font-woff"],
  ".woff2": ["font/woff2", "application/font-woff2"],
  ".ttf": ["font/ttf", "application/font-sfnt"],
  ".otf": ["font/otf", "application/font-sfnt"],
  ".eot": ["application/vnd.ms-fontobject"],

  // Documents
  ".pdf": ["application/pdf"],
  ".json": ["application/json"],
  ".xml": ["application/xml", "text/xml"],

  // HTML
  ".html": ["text/html"],
  ".htm": ["text/html"],
};

export const mimeTypeRule: Rule = {
  meta: {
    id: "content/mime-type",
    name: "MIME Type Validation",
    description: "Detects Content-Type header mismatches with file extensions",
    solution:
      "Incorrect MIME types break resource loading and waste crawl budget. Common issues include .js files served as text/html, images without image/* type, CSS without text/css. Fix server configuration to serve correct Content-Type headers. For Apache use .htaccess, for nginx use mime.types config.",
    category: "content",
    scope: "page",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const url = new URL(ctx.page.url);
    const pathname = url.pathname.toLowerCase();

    // Extract extension
    const extensionMatch = pathname.match(/(\.[a-z0-9]+)$/);
    if (!extensionMatch) {
      checks.push({
        name: "mime-type",
        status: "skipped",
        message: "No file extension detected",
        skipReason: "URL has no file extension",
      });
      return { checks };
    }

    const extension = extensionMatch[1];
    const expectedTypes = MIME_TYPE_MAP[extension];

    if (!expectedTypes) {
      checks.push({
        name: "mime-type",
        status: "info",
        message: `Unknown extension ${extension}, skipping validation`,
      });
      return { checks };
    }

    // Get actual content-type (remove charset)
    const contentTypeHeader = ctx.page.headers["content-type"] || "";
    const actualType = contentTypeHeader.split(";")[0].trim().toLowerCase();

    if (!actualType) {
      checks.push({
        name: "mime-type",
        status: "fail",
        message: `Missing Content-Type header for ${extension} file`,
        expected: expectedTypes[0],
      });
      return { checks };
    }

    // Check if actual type matches expected
    const isValid = expectedTypes.includes(actualType);

    if (isValid) {
      checks.push({
        name: "mime-type",
        status: "pass",
        message: `Correct MIME type for ${extension}`,
        value: actualType,
      });
    } else {
      checks.push({
        name: "mime-type",
        status: "fail",
        message: `Incorrect MIME type for ${extension} file`,
        value: actualType,
        expected: expectedTypes.join(" or "),
      });
    }

    return { checks };
  },
};
