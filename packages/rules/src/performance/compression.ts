// performance/compression - Gzip/Brotli detection

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const compressionRule: Rule = {
  meta: {
    id: "perf/compression",
    name: "Compression",
    description: "Checks for Gzip or Brotli compression",
    solution:
      "Enable Gzip or Brotli compression on your server to reduce transfer sizes by 60-90%. Most web servers support this via configuration. For nginx: 'gzip on;' For Apache: 'AddOutputFilterByType DEFLATE text/html'. Brotli provides better compression than Gzip for text content.",
    category: "perf",
    scope: "page",
    severity: "warning",
    weight: 6,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const headers = ctx.page.headers;

    const contentEncoding = headers["content-encoding"]?.toLowerCase();
    const contentType = headers["content-type"] || "";
    const transferEncoding = headers["transfer-encoding"]?.toLowerCase();

    // Check if content type is compressible
    const isCompressible =
      contentType.includes("text/") ||
      contentType.includes("application/json") ||
      contentType.includes("application/javascript") ||
      contentType.includes("application/xml") ||
      contentType.includes("+xml") ||
      contentType.includes("+json");

    if (!isCompressible) {
      checks.push({
        name: "compression",
        status: "info",
        message: "Content type may not benefit from compression",
        value: contentType,
      });
      return { checks };
    }

    if (contentEncoding) {
      if (contentEncoding.includes("br")) {
        checks.push({
          name: "compression",
          status: "pass",
          message: "Brotli compression enabled (optimal)",
          value: contentEncoding,
        });
      } else if (
        contentEncoding.includes("gzip") ||
        contentEncoding.includes("deflate")
      ) {
        checks.push({
          name: "compression",
          status: "pass",
          message: `${contentEncoding} compression enabled`,
          value: contentEncoding,
          details: { note: "Consider Brotli for better compression ratio" },
        });
      } else if (contentEncoding === "identity") {
        checks.push({
          name: "compression",
          status: "warn",
          message: "Compression explicitly disabled",
          value: contentEncoding,
          expected: "Enable gzip or br compression",
        });
      } else {
        checks.push({
          name: "compression",
          status: "info",
          message: `Unknown content encoding: ${contentEncoding}`,
          value: contentEncoding,
        });
      }
    } else if (transferEncoding?.includes("chunked")) {
      // Chunked transfer without compression
      checks.push({
        name: "compression",
        status: "warn",
        message: "Chunked transfer without compression",
        expected: "Enable gzip or Brotli compression",
      });
    } else {
      // Check HTML size to see if compression would help
      const htmlSize = ctx.page.html?.length || 0;
      if (htmlSize > 1000) {
        checks.push({
          name: "compression",
          status: "fail",
          message: `No compression detected (${(htmlSize / 1024).toFixed(0)}KB uncompressed)`,
          expected: "Enable gzip or Brotli compression",
          details: {
            estimatedSavings: `~${((htmlSize * 0.7) / 1024).toFixed(0)}KB`,
          },
        });
      } else {
        checks.push({
          name: "compression",
          status: "info",
          message: "Small response - compression not critical",
          value: `${htmlSize} bytes`,
        });
      }
    }

    return { checks };
  },
};
