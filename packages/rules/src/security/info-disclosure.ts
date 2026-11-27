// security/info-disclosure - stack traces, filesystem paths, debug pages and database errors in a response body (#2334)

import { collectTextExcluding } from "@squirrelscan/parser/extractors";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { classifyDisclosure } from "../shared/info-disclosure";

const NON_TEXT_TAGS = new Set(["script", "style", "template", "noscript"]);

export const infoDisclosureRule: Rule = {
  meta: {
    id: "security/info-disclosure",
    name: "Information disclosure",
    description:
      "Checks page and error-page bodies for stack traces, absolute filesystem paths, framework debug pages and database errors",
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
          "\n"
        );
      }
    } catch {
      return { checks: [] };
    }

    const found = classifyDisclosure(text, {
      // A bare path on a 200 page is usually documentation; on an error response it is a leak.
      paths: ctx.page.statusCode >= 400,
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
