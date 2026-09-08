// performance/unminified-js - Detect unminified JavaScript
// Aligns with Lighthouse unminified-javascript audit

import { z } from "zod";

import { scanJsComments } from "../shared/comment-scan";
import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const optionsSchema = z.object({
  min_size_bytes: z
    .number()
    .default(2048)
    .describe("Minimum JS size in bytes to check for minification"),
});

// Thresholds for detecting unminified JavaScript
const NEWLINE_RATIO_THRESHOLD = 0.005; // 0.5% newlines = likely unminified
const COMMENT_COUNT_THRESHOLD = 3;
const LONG_FUNCTION_THRESHOLD = 5;
const LONG_VAR_THRESHOLD = 0.002; // Long vars per character

// Matches ONE leading `/*! ... */` or `//! ...` banner (plus surrounding whitespace), anchored to string start.
// `.` never crosses a line terminator, so CRLF needs the explicit `\r?` before `\n`.
const LEADING_BANNER_RE = /^\s*(?:\/\*!(?:[^*]|\*(?!\/))*\*\/|\/\/!.*(?:\r?\n|$))/;

const LONG_VAR_RE = /(?:var|let|const)\s+[a-zA-Z_$][a-zA-Z0-9_$]{5,}/g;
const LONG_FUNCTION_RE = /function\s+[a-zA-Z_$][a-zA-Z0-9_$]{10,}/g;
const INDENT_RE = /\n[ \t]{2,}/g;
const WHITESPACE_RUN_RE = /\s{2,}/g;

/** Occurrences of a single character, without materialising a match array. */
function countChar(text: string, ch: string): number {
  let n = 0;
  for (let i = text.indexOf(ch); i !== -1; i = text.indexOf(ch, i + 1)) n += 1;
  return n;
}

// #698: strips bundler-preserved license banners (leading only, never mid-file) before the minification heuristic runs.
function stripLeadingLicenseBanners(js: string): string {
  let rest = js;
  let match = LEADING_BANNER_RE.exec(rest);
  while (match) {
    rest = rest.slice(match[0].length);
    match = LEADING_BANNER_RE.exec(rest);
  }
  return rest;
}

/**
 * Analyze JavaScript content to determine if it's minified
 * Returns potential savings and reasons if unminified
 */
function analyzeJs(rawJs: string): {
  minified: boolean;
  reason?: string;
  potentialSavingsBytes?: number;
} {
  if (!rawJs || rawJs.length < 200) {
    return { minified: true }; // Too small to matter
  }

  const js = stripLeadingLicenseBanners(rawJs);
  if (js.length < 200) {
    return { minified: true }; // Nothing left but license banners
  }

  const issues: string[] = [];
  let potentialSavings = 0;

  // Every counter below used to run `String.match` with a /g pattern, which
  // builds an array of every match before throwing it away — on a 400 KB bundle
  // that is tens of thousands of throwaway strings per counter (#1864). The
  // counts and totals are identical; only the arrays are gone.
  const newlines = countChar(js, "\n");
  const newlineRatio = newlines / js.length;

  if (newlineRatio > NEWLINE_RATIO_THRESHOLD) {
    issues.push(`high newlines (${(newlineRatio * 100).toFixed(2)}%)`);
    potentialSavings += newlines;
  }

  // Count comments. #142: string-aware, because a plain /\/\/[^\n]*/ match counts
  // every `"https://..."` in the bundle as a comment running to end of line.
  const comments = scanJsComments(js);
  const totalCommentCount = comments.lineComments + comments.blockComments;

  if (totalCommentCount > COMMENT_COUNT_THRESHOLD) {
    issues.push(`${totalCommentCount} comments`);
    potentialSavings += comments.commentBytes;
  }

  // Check for readable variable names (minified typically has single-char vars)
  let longVarCount = 0;
  let longVarSavings = 0;
  LONG_VAR_RE.lastIndex = 0;
  for (let m = LONG_VAR_RE.exec(js); m !== null; m = LONG_VAR_RE.exec(js)) {
    longVarCount += 1;
    const varName = m[0].split(/\s+/)[1]!;
    longVarSavings += Math.max(0, varName.length - 2);
  }
  const longVarRatio = longVarCount / js.length;

  if (longVarRatio > LONG_VAR_THRESHOLD) {
    issues.push("long variable names");
    // Estimate savings: assume minified names are 1-2 chars
    potentialSavings += longVarSavings;
  }

  // Check for function declarations with long names. Only "more than five"
  // matters, so stop counting at six.
  let longFunctions = 0;
  LONG_FUNCTION_RE.lastIndex = 0;
  while (longFunctions <= LONG_FUNCTION_THRESHOLD && LONG_FUNCTION_RE.exec(js) !== null) {
    longFunctions += 1;
  }
  if (longFunctions > LONG_FUNCTION_THRESHOLD) {
    issues.push("long function names");
  }

  // Check for consistent indentation (sign of unminified code)
  let indentedLines = 0;
  INDENT_RE.lastIndex = 0;
  while (INDENT_RE.exec(js) !== null) indentedLines += 1;
  if (indentedLines > js.length / 200) {
    issues.push("formatted code");
    potentialSavings += indentedLines * 2; // Average 2 spaces per indent
  }

  // Check for excessive whitespace
  let excessiveWhitespace = 0;
  WHITESPACE_RUN_RE.lastIndex = 0;
  for (let m = WHITESPACE_RUN_RE.exec(js); m !== null; m = WHITESPACE_RUN_RE.exec(js)) {
    excessiveWhitespace += m[0].length - 1;
  }
  if (excessiveWhitespace > js.length * 0.05) {
    issues.push("excessive whitespace");
    potentialSavings += excessiveWhitespace;
  }

  if (issues.length > 0) {
    return {
      minified: false,
      reason: issues.join(", "),
      potentialSavingsBytes: potentialSavings,
    };
  }

  return { minified: true };
}

export const unminifiedJsRule: Rule = {
  meta: {
    id: "perf/unminified-js",
    name: "Unminified JavaScript",
    description: "Detects unminified JavaScript that could be optimized",
    solution:
      "Minify JavaScript to reduce file size and improve load times. Use build tools like Terser, esbuild, or UglifyJS. Most bundlers (Webpack, Vite, Rollup) minify automatically in production. Minification shortens variable names, removes whitespace, and dead code.",
    category: "perf",
    scope: "page",
    verdictScope: "template",
    severity: "warning",
    weight: 5,
    optionsSchema,
  },

  run(ctx: RuleContext): RuleResult {
    const opts = optionsSchema.parse(ctx.options);
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const checks: CheckResult[] = [];
    const unminifiedItems: Array<{
      source: string;
      sizeKb: number;
      savingsKb: number;
      reason: string;
    }> = [];

    // Check inline scripts
    const scripts = doc.querySelectorAll("script:not([src])");
    for (const script of scripts) {
      const content = script.textContent || "";
      if (content.length < opts.min_size_bytes) continue;

      // Skip JSON-LD and other data scripts
      const type = script.getAttribute("type") || "";
      if (type.includes("json") || type.includes("template")) continue;

      const result = analyzeJs(content);
      if (!result.minified) {
        const sizeKb = content.length / 1024;
        const savingsKb = (result.potentialSavingsBytes || 0) / 1024;
        unminifiedItems.push({
          source: "inline script",
          sizeKb,
          savingsKb,
          reason: result.reason || "unminified",
        });
      }
    }

    // Track which scripts we've already checked (by URL) to avoid duplicates
    const checkedScriptUrls = new Set<string>();

    // Check external scripts from site data (same-domain scripts with content)
    if (ctx.site?.scripts) {
      for (const script of ctx.site.scripts) {
        checkedScriptUrls.add(script.url);
        const content = script.content;
        const sizeBytes = script.sizeBytes || 0;

        if (sizeBytes < opts.min_size_bytes) continue;

        // If we have content, analyze it
        if (content) {
          const result = analyzeJs(content);
          if (!result.minified) {
            const filename = script.url.split("/").pop()?.split("?")[0] || script.url;
            unminifiedItems.push({
              source: filename,
              sizeKb: sizeBytes / 1024,
              savingsKb: (result.potentialSavingsBytes || 0) / 1024,
              reason: result.reason || "unminified",
            });
          }
        } else {
          // No content - check filename patterns
          const url = script.url;
          const filename = url.split("/").pop()?.split("?")[0] || url;

          const hasMinIndicator =
            filename.includes(".min.") || filename.includes("-min.") || filename.includes(".prod.");

          // Check for hash patterns (bundler output is usually minified)
          const hasHash = /[.-][a-f0-9]{8,}\./i.test(filename);

          // Check for common bundler output patterns
          const isBundlerOutput =
            filename.includes("chunk") ||
            filename.includes("bundle") ||
            filename.includes("vendor");

          // Check for CDN patterns
          const isCdn =
            url.includes("cdn") ||
            url.includes("unpkg") ||
            url.includes("jsdelivr") ||
            url.includes("cloudflare");

          if (!hasMinIndicator && !hasHash && !isBundlerOutput && !isCdn) {
            if (filename.endsWith(".js") || filename.endsWith(".mjs")) {
              unminifiedItems.push({
                source: filename,
                sizeKb: sizeBytes / 1024,
                savingsKb: 0,
                reason: "no .min indicator",
              });
            }
          }
        }
      }
    }

    // ALWAYS check DOM for external scripts not in site data (CDN/external resources)
    const externalScripts = doc.querySelectorAll("script[src]");
    for (const script of externalScripts) {
      const src = script.getAttribute("src") || "";
      if (!src) continue;

      // Skip if already checked via site.scripts
      if (checkedScriptUrls.has(src)) continue;

      const filename = src.split("/").pop()?.split("?")[0] || src;

      const hasMinIndicator =
        filename.includes(".min.") || filename.includes("-min.") || filename.includes(".prod.");

      const hasHash = /[.-][a-f0-9]{8,}\./i.test(filename);
      const isBundlerOutput =
        filename.includes("chunk") || filename.includes("bundle") || filename.includes("vendor");
      const isCdn = src.includes("cdn") || src.includes("unpkg") || src.includes("jsdelivr");

      if (!hasMinIndicator && !hasHash && !isBundlerOutput && !isCdn) {
        if (filename.endsWith(".js") || filename.endsWith(".mjs")) {
          unminifiedItems.push({
            source: filename,
            sizeKb: 0,
            savingsKb: 0,
            reason: "no .min indicator",
          });
        }
      }
    }

    // Report findings
    const confirmedUnminified = unminifiedItems.filter((i) => i.reason !== "no .min indicator");
    const suspectedUnminified = unminifiedItems.filter((i) => i.reason === "no .min indicator");

    if (confirmedUnminified.length > 0) {
      const totalSavingsKb = confirmedUnminified.reduce((sum, i) => sum + i.savingsKb, 0);
      checks.push({
        name: "unminified-js",
        status: "warn",
        message: `${confirmedUnminified.length} JavaScript file(s) appear unminified`,
        items: confirmedUnminified.slice(0, 5).map((i) => ({
          id: i.source,
          label: `${i.sizeKb.toFixed(1)}KB${i.savingsKb > 0 ? `, ~${i.savingsKb.toFixed(1)}KB savings` : ""}`,
          meta: { reason: i.reason },
        })),
        details: {
          totalPotentialSavingsKb: totalSavingsKb.toFixed(1),
          ...(confirmedUnminified.length > 5 ? { additional: confirmedUnminified.length - 5 } : {}),
        },
      });
    }

    if (suspectedUnminified.length > 0) {
      checks.push({
        name: "potentially-unminified-js",
        status: "info",
        message: `${suspectedUnminified.length} script(s) may not be minified`,
        items: suspectedUnminified.slice(0, 5).map((i) => ({
          id: i.source,
          label: i.sizeKb > 0 ? `${i.sizeKb.toFixed(1)}KB` : undefined,
        })),
        details: { note: "Files without .min in name - verify if minified" },
      });
    }

    if (confirmedUnminified.length === 0 && suspectedUnminified.length === 0) {
      checks.push({
        name: "minified-js",
        status: "pass",
        message: "JavaScript appears to be minified",
      });
    }

    return { checks };
  },
};
