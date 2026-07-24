// core/charset - Check for charset declaration

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { getAttrCI, querySelectorByAttrValueCI } from "@squirrelscan/utils";

export const charsetRule: Rule = {
  meta: {
    id: "core/charset",
    name: "Charset",
    description: "Checks for proper character encoding declaration",
    solution:
      'Add <meta charset="UTF-8"> as the first element in your <head> section. This tells browsers how to interpret the text on your page. UTF-8 is the standard encoding that supports all languages and special characters. Placing it first ensures browsers know the encoding before parsing any other content.',
    category: "core",
    scope: "page",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;

    if (!doc) {
      checks.push({
        name: "charset",
        status: "skipped",
        message: "No document available",
        skipReason: "Parse error",
      });
      return { checks };
    }

    // Check for <meta charset="..."> (case-insensitive for React SSR's charSet)
    const metaTags = doc.querySelectorAll("meta");
    let charsetMeta: Element | null = null;
    let charsetValue: string | null = null;
    for (const meta of metaTags) {
      const val = getAttrCI(meta, "charset");
      if (val !== null) {
        charsetMeta = meta;
        charsetValue = val;
        break;
      }
    }

    // Check for <meta http-equiv="Content-Type" ...> (case-insensitive for React SSR's httpEquiv)
    const httpEquivMeta = querySelectorByAttrValueCI(
      doc,
      "meta",
      "http-equiv",
      "Content-Type"
    );
    const contentValue = httpEquivMeta?.getAttribute("content") || "";
    const httpEquivCharset = contentValue.match(/charset=([^\s;]+)/i)?.[1];

    // Check Content-Type header
    const headerContentType = ctx.page.headers["content-type"] || "";
    const headerCharset = headerContentType.match(/charset=([^\s;]+)/i)?.[1];

    const declaredCharset = charsetValue || httpEquivCharset || headerCharset;

    if (declaredCharset) {
      const isUtf8 = /^utf-?8$/i.test(declaredCharset);

      if (isUtf8) {
        // Check if charset is early in head
        if (charsetMeta) {
          const head = doc.querySelector("head");
          const firstChild = head?.firstElementChild;
          const isFirst =
            firstChild === charsetMeta ||
            (firstChild?.tagName === "TITLE" &&
              firstChild?.nextElementSibling === charsetMeta);

          if (isFirst) {
            checks.push({
              name: "charset",
              status: "pass",
              message: "UTF-8 charset declared early in head",
              value: declaredCharset,
            });
          } else {
            checks.push({
              name: "charset",
              status: "warn",
              message: "UTF-8 charset declared but not at start of head",
              value: declaredCharset,
              expected: "charset meta should be first element in head",
            });
          }
        } else {
          // Declared via http-equiv or header
          checks.push({
            name: "charset",
            status: "pass",
            message: `UTF-8 charset declared${httpEquivCharset ? " via http-equiv" : " via header"}`,
            value: declaredCharset,
          });
        }
      } else {
        checks.push({
          name: "charset",
          status: "warn",
          message: `Non-UTF-8 charset declared: ${declaredCharset}`,
          value: declaredCharset,
          expected: "UTF-8",
        });
      }
    } else {
      checks.push({
        name: "charset",
        status: "fail",
        message: "No charset declaration found",
        expected: '<meta charset="UTF-8">',
      });
    }

    return { checks };
  },
};
