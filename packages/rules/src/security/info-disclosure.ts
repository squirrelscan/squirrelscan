// security/info-disclosure - stack traces, filesystem paths, debug pages and database errors in a response body (#2334)

import { collectTextExcluding } from "@squirrelscan/parser/extractors";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { classifyDisclosure, scansPathsFor } from "../shared/info-disclosure";

const NON_TEXT_TAGS = new Set(["script", "style", "template", "noscript"]);

// Phrasing elements whose text runs on in the same line. Every other element
// (a cell, row, paragraph, list item, div) ends a line, so a trace laid out one
// frame per cell keeps its line breaks instead of gluing `Exception` to `at`.
const INLINE_TAGS = new Set([
  "a",
  "abbr",
  "b",
  "bdi",
  "bdo",
  "cite",
  "code",
  "data",
  "dfn",
  "em",
  "i",
  "kbd",
  "mark",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "time",
  "u",
  "var",
]);

const isBoundary = (el: Element): boolean =>
  !INLINE_TAGS.has(el.tagName.toLowerCase());

export const infoDisclosureRule: Rule = {
  meta: {
    id: "security/info-disclosure",
    name: "Information disclosure",
    description:
      "Checks 2xx page bodies for stack traces, absolute filesystem paths, framework debug pages and database errors (error responses are not stored yet)",
    solution:
      'Turn debug output off in production (Laravel APP_DEBUG=false, Django DEBUG = False, Symfony APP_ENV=prod, Rails consider_all_requests_local = false, ASP.NET customErrors mode="RemoteOnly" or "On", PHP display_errors = Off) and serve a generic error page. Log the details server-side instead. Rotate any credential the output showed.',
    category: "security",
    scope: "page",
    findingScope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 5,
    checks: [
      { name: "info-disclosure", outcome: "problem" },
      {
        name: "info-disclosure",
        outcome: "clean",
        clears: ["info-disclosure"],
      },
    ],
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    let text = "";
    try {
      const root = doc.documentElement;
      if (root) {
        text = collectTextExcluding(
          root,
          (el) => NON_TEXT_TAGS.has(el.tagName.toLowerCase()),
          "\n",
          isBoundary
        );
      }
    } catch {
      return { checks: [] };
    }

    const found = classifyDisclosure(text, {
      paths: scansPathsFor(ctx.page.statusCode),
    });
    const checks: CheckResult[] = [];
    if (!found) {
      checks.push({
        name: "info-disclosure",
        status: "pass",
        message:
          "No stack trace, filesystem path, debug page or database error in the page",
      });
      return { checks };
    }
    checks.push({
      name: "info-disclosure",
      status: "fail",
      message: `${found.label} shown on the page (${found.kind}): ${found.snippet}`,
      details: {
        kind: found.kind,
        label: found.label,
        snippet: found.snippet,
        statusCode: ctx.page.statusCode,
      },
    });
    return { checks };
  },
};
