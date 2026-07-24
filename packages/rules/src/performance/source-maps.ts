// performance/source-maps - Validate source map availability
// Detects exposed source maps that could reveal source code

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { resolveUrl } from "@squirrelscan/utils";

export const sourceMapsRule: Rule = {
  meta: {
    id: "perf/source-maps",
    name: "Source Maps",
    description: "Checks for source map availability and configuration",
    solution:
      "Source maps help debug minified code but can expose source code if publicly accessible. For production: 1) Either remove source maps entirely, 2) Restrict access via server config, or 3) Use 'hidden' source maps uploaded only to error tracking services. Exposed source maps can reveal business logic and security implementations to attackers.",
    category: "perf",
    scope: "page",
    severity: "info",
    weight: 3,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    const html = ctx.page.html;
    if (!doc || !html) return { checks: [] };

    const checks: CheckResult[] = [];
    const sourceMapsFound: Array<{ url: string; source: string }> = [];
    const inlineSourceMaps: string[] = [];
    const baseUrl = ctx.page.url;

    // Pattern to find sourceMappingURL in JS
    const jsSourceMapPattern = /\/\/[#@]\s*sourceMappingURL=(\S+)/g;
    // Pattern to find sourceMappingURL in CSS
    const cssSourceMapPattern = /\/\*[#@]\s*sourceMappingURL=(\S+)\s*\*\//g;

    // Check scripts for sourceMappingURL comments
    const scripts = doc.querySelectorAll("script");
    for (const script of scripts) {
      const src = script.getAttribute("src");
      const content = script.textContent || "";

      // Check inline script content for source map references
      if (content) {
        // Check for inline data: source maps
        if (content.includes("sourceMappingURL=data:")) {
          inlineSourceMaps.push(src || "inline script");
        }

        // Check for external source map references
        let match: RegExpExecArray | null;
        jsSourceMapPattern.lastIndex = 0;
        while ((match = jsSourceMapPattern.exec(content)) !== null) {
          const mapUrl = match[1];
          if (!mapUrl.startsWith("data:")) {
            const resolvedUrl = resolveUrl(mapUrl, baseUrl);
            sourceMapsFound.push({
              url: resolvedUrl || mapUrl,
              source: src || "inline script",
            });
          }
        }
      }

      // For external scripts, check if we have content from site.scripts
      // Only infer .map URL if we found sourceMappingURL in the actual content
      if (src && !src.includes("data:") && ctx.site?.scripts) {
        const resolvedSrc = resolveUrl(src, baseUrl);
        if (resolvedSrc) {
          // Find this script in site.scripts to check its content
          const scriptData = ctx.site.scripts.find(
            (s) => s.url === resolvedSrc || s.url === src
          );
          if (scriptData) {
            // Check for SourceMap HTTP header (highest priority)
            if (scriptData.sourceMapHeader) {
              const resolvedMapUrl = resolveUrl(
                scriptData.sourceMapHeader,
                scriptData.finalUrl || resolvedSrc
              );
              sourceMapsFound.push({
                url: resolvedMapUrl || scriptData.sourceMapHeader,
                source: `${src} (HTTP header)`,
              });
            }

            // Check content for sourceMappingURL comment
            if (scriptData.content) {
              jsSourceMapPattern.lastIndex = 0;
              let contentMatch: RegExpExecArray | null;
              while (
                (contentMatch = jsSourceMapPattern.exec(scriptData.content)) !==
                null
              ) {
                const mapUrl = contentMatch[1];
                if (!mapUrl.startsWith("data:")) {
                  const resolvedMapUrl = resolveUrl(mapUrl, resolvedSrc);
                  sourceMapsFound.push({
                    url: resolvedMapUrl || mapUrl,
                    source: src,
                  });
                } else {
                  inlineSourceMaps.push(src);
                }
              }
            }
          }
        }
      }
    }

    // Check stylesheets for source maps
    const styleElements = doc.querySelectorAll("style");
    for (const style of styleElements) {
      const content = style.textContent || "";
      let match: RegExpExecArray | null;
      cssSourceMapPattern.lastIndex = 0;
      while ((match = cssSourceMapPattern.exec(content)) !== null) {
        const mapUrl = match[1];
        if (!mapUrl.startsWith("data:")) {
          const resolvedUrl = resolveUrl(mapUrl, baseUrl);
          sourceMapsFound.push({
            url: resolvedUrl || mapUrl,
            source: "inline style",
          });
        } else {
          inlineSourceMaps.push("inline CSS");
        }
      }
    }

    // Note: External stylesheets are not checked for source maps because
    // CSS content is not fetched during the crawl. We only check inline <style> elements above.
    // If CSS content fetching is added in the future, this can be extended.

    // Check for SourceMap header on the page response
    const sourceMapHeader =
      ctx.page.headers["sourcemap"] || ctx.page.headers["x-sourcemap"];
    if (sourceMapHeader) {
      const resolvedUrl = resolveUrl(sourceMapHeader, baseUrl);
      sourceMapsFound.push({
        url: resolvedUrl || sourceMapHeader,
        source: "HTTP header",
      });
    }

    // Deduplicate by URL
    const uniqueSourceMaps = [
      ...new Map(sourceMapsFound.map((s) => [s.url, s])).values(),
    ];

    // Report findings - note that we can't verify accessibility without fetching
    // Future enhancement: verify via HEAD request
    if (uniqueSourceMaps.length > 0) {
      checks.push({
        name: "source-maps-exposed",
        status: "warn",
        message: `${uniqueSourceMaps.length} potential source map(s) detected`,
        items: uniqueSourceMaps.slice(0, 10).map((s) => ({
          id: s.url,
          label: `from ${s.source}`,
        })),
        details: {
          note: "Source maps may expose original source code. Verify these URLs are not publicly accessible.",
          ...(uniqueSourceMaps.length > 10
            ? { additional: uniqueSourceMaps.length - 10 }
            : {}),
        },
      });
    }

    if (inlineSourceMaps.length > 0) {
      checks.push({
        name: "source-maps-inline",
        status: "warn",
        message: `${inlineSourceMaps.length} inline source map(s) found`,
        items: inlineSourceMaps.slice(0, 3).map((id) => ({ id })),
        details: {
          note: "Inline source maps increase bundle size and expose code",
        },
      });
    }

    if (uniqueSourceMaps.length === 0 && inlineSourceMaps.length === 0) {
      checks.push({
        name: "source-maps",
        status: "pass",
        message: "No exposed source maps detected",
      });
    }

    return { checks };
  },
};
