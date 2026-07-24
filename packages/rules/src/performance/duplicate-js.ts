// performance/duplicate-js - Duplicate JavaScript modules

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

// Extract library name and version from script URL
function extractLibraryInfo(
  src: string
): { name: string; version?: string } | null {
  // Try to extract from common CDN patterns
  const patterns = [
    // unpkg.com/react@18.2.0/umd/react.production.min.js
    /unpkg\.com\/(@?[^@/]+)@?([^/]*)/i,
    // cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js
    /jsdelivr\.net\/npm\/(@?[^@/]+)@?([^/]*)/i,
    // cdnjs.cloudflare.com/ajax/libs/jquery/3.6.0/jquery.min.js
    /cdnjs\.cloudflare\.com\/ajax\/libs\/([^/]+)\/([^/]+)/i,
    // Example: /static/js/react.123abc.js
    /\/([a-z][-a-z0-9]+)(?:[.-]([0-9]+(?:\.[0-9]+)*))?\.(?:min\.)?js/i,
  ];

  for (const pattern of patterns) {
    const match = src.match(pattern);
    if (match) {
      return {
        name: match[1].toLowerCase(),
        version: match[2] || undefined,
      };
    }
  }

  // Fallback: extract filename
  const filename = src.split("/").pop()?.split("?")[0];
  if (filename) {
    const nameMatch = filename.match(/^([a-z][-a-z0-9]*)/i);
    if (nameMatch) {
      return { name: nameMatch[1].toLowerCase() };
    }
  }

  return null;
}

export const duplicateJsRule: Rule = {
  meta: {
    id: "perf/duplicate-js",
    name: "Duplicate JavaScript",
    description: "Detects duplicate JavaScript libraries loaded multiple times",
    solution:
      "Remove duplicate JavaScript library loads to reduce page weight and avoid conflicts. Check for the same library loaded from different CDNs or versions. Use a single source for each dependency. Consider using a module bundler to deduplicate shared dependencies.",
    category: "perf",
    scope: "page",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const checks: CheckResult[] = [];

    // Track loaded libraries
    const libraries = new Map<
      string,
      Array<{ src: string; version?: string }>
    >();

    // Check external scripts
    const scripts = doc.querySelectorAll("script[src]");

    for (const script of scripts) {
      const src = script.getAttribute("src") || "";
      const info = extractLibraryInfo(src);

      if (info) {
        const existing = libraries.get(info.name) || [];
        existing.push({ src, version: info.version });
        libraries.set(info.name, existing);
      }
    }

    // Find duplicates
    const duplicates: string[] = [];
    const versionMismatches: string[] = [];

    for (const [name, instances] of libraries) {
      if (instances.length > 1) {
        // Check if versions differ
        const versions = new Set(
          instances.map((i) => i.version).filter(Boolean)
        );

        if (versions.size > 1) {
          versionMismatches.push(
            `${name} (versions: ${Array.from(versions).join(", ")})`
          );
        } else {
          duplicates.push(`${name} (${instances.length}x)`);
        }
      }
    }

    // Report findings
    if (versionMismatches.length > 0) {
      checks.push({
        name: "duplicate-js-version-mismatch",
        status: "fail",
        message: `${versionMismatches.length} library(s) loaded with different versions`,
        items: versionMismatches.map((id) => ({ id })),
        details: {
          note: "Different versions may cause conflicts",
        },
      });
    }

    if (duplicates.length > 0) {
      checks.push({
        name: "duplicate-js-same-version",
        status: "warn",
        message: `${duplicates.length} library(s) loaded multiple times`,
        items: duplicates.map((id) => ({ id })),
        details: {
          note: "Remove duplicates to reduce page weight",
        },
      });
    }

    if (versionMismatches.length === 0 && duplicates.length === 0) {
      checks.push({
        name: "duplicate-js",
        status: "pass",
        message: "No duplicate JavaScript libraries detected",
        details: { scriptsAnalyzed: scripts.length },
      });
    }

    return { checks };
  },
};
