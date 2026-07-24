// performance/cache-headers - Cache-Control header analysis

import { parseCacheControl } from "@squirrelscan/utils/cache-control";
import { z } from "zod";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const optionsSchema = z.object({
  min_static_max_age: z
    .number()
    .default(86400)
    .describe("Minimum max-age for static assets in seconds (1 day)"),
});

export const cacheHeadersRule: Rule = {
  meta: {
    id: "perf/cache-headers",
    name: "Cache Headers",
    description: "Checks Cache-Control header configuration",
    solution:
      "Use Cache-Control headers to enable browser caching. For static assets (CSS, JS, images), set long max-age (1 year) with immutable when using hashed filenames. For HTML, use shorter max-age or no-cache with revalidation. Example: 'Cache-Control: public, max-age=31536000, immutable' for versioned assets.",
    category: "perf",
    scope: "page",
    severity: "warning",
    weight: 4,
    optionsSchema,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const headers = ctx.page.headers;

    const cacheControl = headers["cache-control"];
    const expires = headers["expires"];
    const etag = headers["etag"];
    const lastModified = headers["last-modified"];

    if (!cacheControl && !expires) {
      checks.push({
        name: "cache-headers-missing",
        status: "warn",
        message: "No caching headers found",
        expected: "Cache-Control header recommended",
      });
      return { checks };
    }

    if (cacheControl) {
      const directives = parseCacheControl(cacheControl);

      // Check for no-store (completely disables caching)
      if (directives.noStore) {
        checks.push({
          name: "cache-control",
          status: "info",
          message: "Caching disabled with no-store",
          value: cacheControl,
          details: { note: "May be intentional for sensitive content" },
        });
        return { checks };
      }

      // Check for no-cache (requires revalidation)
      if (directives.noCache) {
        if (etag || lastModified) {
          checks.push({
            name: "cache-control",
            status: "pass",
            message: "Uses revalidation caching with no-cache",
            value: cacheControl,
            details: {
              etag: etag ? "present" : "missing",
              lastModified: lastModified ? "present" : "missing",
            },
          });
        } else {
          checks.push({
            name: "cache-control",
            status: "warn",
            message: "no-cache without ETag or Last-Modified",
            value: cacheControl,
            expected: "Add ETag or Last-Modified for efficient revalidation",
          });
        }
        return { checks };
      }

      // Check max-age
      const maxAgeSeconds = directives.maxAge;
      if (maxAgeSeconds !== undefined) {
        // HTML pages should have shorter cache times
        const contentType = headers["content-type"] || "";
        const isHtml =
          contentType.includes("text/html") ||
          ctx.page.url.endsWith(".html") ||
          !ctx.page.url.match(/\.[a-z]{2,4}$/);

        if (isHtml) {
          if (maxAgeSeconds > 3600) {
            checks.push({
              name: "cache-control-html",
              status: "info",
              message: `HTML cached for ${maxAgeSeconds}s (${(maxAgeSeconds / 3600).toFixed(1)}h)`,
              value: cacheControl,
              details: {
                note: "Consider shorter cache for dynamic content",
              },
            });
          } else {
            checks.push({
              name: "cache-control-html",
              status: "pass",
              message: `HTML cache appropriate (${maxAgeSeconds}s)`,
              value: cacheControl,
            });
          }
        } else {
          // Static assets
          if (maxAgeSeconds < 86400) {
            checks.push({
              name: "cache-control-static",
              status: "warn",
              message: `Short cache for static asset (${maxAgeSeconds}s)`,
              value: cacheControl,
              expected:
                "Static assets should cache for at least 1 day (86400s)",
            });
          } else {
            checks.push({
              name: "cache-control-static",
              status: "pass",
              message: `Good cache duration (${(maxAgeSeconds / 86400).toFixed(0)} days)`,
              value: cacheControl,
            });
          }
        }
      } else {
        checks.push({
          name: "cache-control",
          status: "warn",
          message: "Cache-Control without max-age",
          value: cacheControl,
          expected: "Add max-age directive",
        });
      }

      // Check for immutable (great for versioned assets)
      if (directives.immutable) {
        checks.push({
          name: "cache-immutable",
          status: "pass",
          message: "Uses immutable directive for optimal caching",
        });
      }
    } else if (expires) {
      checks.push({
        name: "cache-expires",
        status: "info",
        message: "Uses legacy Expires header",
        value: expires,
        details: { note: "Consider using Cache-Control instead" },
      });
    }

    return { checks };
  },
};
