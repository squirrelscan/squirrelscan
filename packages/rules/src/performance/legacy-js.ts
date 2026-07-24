// performance/legacy-js - Legacy JavaScript detection

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { querySelectorAllByAttrCI } from "@squirrelscan/utils";

// Patterns that indicate legacy JavaScript or polyfills
const legacyPatterns = [
  { pattern: /core-js/i, name: "core-js polyfills" },
  { pattern: /regenerator-runtime/i, name: "regenerator-runtime" },
  { pattern: /babel-polyfill/i, name: "babel-polyfill" },
  { pattern: /polyfill\.io/i, name: "polyfill.io" },
  { pattern: /es5-shim/i, name: "es5-shim" },
  { pattern: /es6-shim/i, name: "es6-shim" },
  { pattern: /promise-polyfill/i, name: "promise-polyfill" },
  { pattern: /fetch-polyfill/i, name: "fetch-polyfill" },
  { pattern: /whatwg-fetch/i, name: "whatwg-fetch polyfill" },
  { pattern: /@babel\/runtime/i, name: "@babel/runtime" },
  { pattern: /tslib/i, name: "tslib helpers" },
];

// Inline code patterns that suggest ES5 targeting
const es5CodePatterns = [
  { pattern: /\.call\(this\)\s*\|\|\s*this/g, name: "ES5 class pattern" },
  {
    pattern: /Object\.defineProperty\([^,]+,\s*["']__esModule["']/g,
    name: "__esModule definition",
  },
  { pattern: /function\s+_classCallCheck/g, name: "Babel _classCallCheck" },
  { pattern: /function\s+_createClass/g, name: "Babel _createClass" },
  { pattern: /function\s+_inherits/g, name: "Babel _inherits" },
  { pattern: /function\s+_typeof/g, name: "Babel _typeof helper" },
  {
    pattern: /__spreadArrays|__spreadArray/g,
    name: "TypeScript spread helpers",
  },
  { pattern: /__awaiter\s*\(/g, name: "TypeScript __awaiter" },
  { pattern: /__generator\s*\(/g, name: "TypeScript __generator" },
];

export const legacyJsRule: Rule = {
  meta: {
    id: "perf/legacy-js",
    name: "Legacy JavaScript",
    description: "Detects ES5 polyfills and legacy JavaScript code",
    solution:
      "Consider removing legacy polyfills if you don't need to support old browsers. Use differential serving (module/nomodule) to send modern code to modern browsers. Update Babel/TypeScript target to ES2020+ if your audience uses modern browsers. Check browserslist configuration.",
    category: "perf",
    scope: "page",
    severity: "info",
    weight: 3,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const checks: CheckResult[] = [];
    const legacyFound: string[] = [];
    const es5PatternsFound: string[] = [];

    // Check script sources for polyfill libraries
    const scripts = doc.querySelectorAll("script[src]");
    for (const script of scripts) {
      const src = script.getAttribute("src") || "";

      for (const { pattern, name } of legacyPatterns) {
        if (pattern.test(src)) {
          legacyFound.push(name);
          break;
        }
      }
    }

    // Check inline scripts for ES5 patterns
    const inlineScripts = doc.querySelectorAll("script:not([src])");
    for (const script of inlineScripts) {
      const content = script.textContent || "";
      if (content.length < 500) continue; // Skip small scripts

      // Skip JSON-LD
      const type = script.getAttribute("type") || "";
      if (type.includes("json")) continue;

      for (const { pattern, name } of es5CodePatterns) {
        pattern.lastIndex = 0;
        if (pattern.test(content)) {
          if (!es5PatternsFound.includes(name)) {
            es5PatternsFound.push(name);
          }
        }
      }
    }

    // Check for module/nomodule differential serving
    const moduleScripts = doc.querySelectorAll('script[type="module"]');
    const nomoduleScripts = querySelectorAllByAttrCI(doc, "script", "nomodule");
    const hasDifferentialServing =
      moduleScripts.length > 0 && nomoduleScripts.length > 0;

    // Report findings
    if (legacyFound.length > 0) {
      checks.push({
        name: "legacy-polyfills",
        status: "warn",
        message: `${legacyFound.length} legacy polyfill(s) detected`,
        items: legacyFound.map((id) => ({ id })),
        details: {
          suggestion: "Remove if targeting modern browsers only",
        },
      });
    }

    if (es5PatternsFound.length > 0) {
      checks.push({
        name: "es5-code-patterns",
        status: "info",
        message: `${es5PatternsFound.length} ES5 transpilation pattern(s) found`,
        items: es5PatternsFound.slice(0, 5).map((id) => ({ id })),
        details: {
          note: "May indicate ES5 build target",
        },
      });
    }

    if (hasDifferentialServing) {
      checks.push({
        name: "differential-serving",
        status: "pass",
        message: "Uses module/nomodule differential serving",
        details: {
          moduleScripts: moduleScripts.length,
          nomoduleScripts: nomoduleScripts.length,
        },
      });
    } else if (moduleScripts.length > 0) {
      checks.push({
        name: "es-modules",
        status: "pass",
        message: `${moduleScripts.length} ES module script(s) detected`,
      });
    }

    if (
      legacyFound.length === 0 &&
      es5PatternsFound.length === 0 &&
      moduleScripts.length === 0
    ) {
      checks.push({
        name: "legacy-js",
        status: "info",
        message: "No legacy JavaScript patterns detected",
      });
    }

    return { checks };
  },
};
