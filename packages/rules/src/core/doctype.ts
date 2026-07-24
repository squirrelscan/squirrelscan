// core/doctype - Check for valid HTML5 doctype
// Aligns with Lighthouse doctype audit

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

// BOM (Byte Order Mark) characters that may appear at start of file
// eslint-disable-next-line no-control-regex
const BOM_PATTERNS = /^[\uFEFF\uFFFE\u0000]/;

// XML declaration that may precede doctype in XHTML
const XML_DECLARATION = /^<\?xml[^>]*\?>/i;

export const doctypeRule: Rule = {
  meta: {
    id: "core/doctype",
    name: "Doctype",
    description: "Checks for valid HTML5 doctype declaration",
    solution:
      "Add <!DOCTYPE html> at the very start of your HTML document, before the <html> tag. This declaration tells browsers to render the page in standards mode rather than quirks mode, ensuring consistent rendering across browsers. Without a proper doctype, browsers may render the page inconsistently.",
    category: "core",
    scope: "page",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    let html = ctx.page.html;

    if (!html) {
      checks.push({
        name: "doctype",
        status: "skipped",
        message: "No HTML content available",
        skipReason: "Empty response",
      });
      return { checks };
    }

    // Check for and strip BOM
    const hasBom = BOM_PATTERNS.test(html);
    if (hasBom) {
      html = html.replace(BOM_PATTERNS, "");
    }

    // Check for XML declaration (allowed in XHTML served as application/xhtml+xml)
    const xmlDeclMatch = html.match(XML_DECLARATION);
    let afterXmlDecl = html;
    if (xmlDeclMatch) {
      afterXmlDecl = html.slice(xmlDeclMatch[0].length);
    }

    // Check for HTML5 doctype at the beginning (allowing whitespace)
    // Case-insensitive: <!DOCTYPE html>, <!doctype html>, <!DocType HTML>
    const html5DoctypeRegex = /^\s*<!DOCTYPE\s+html\s*>/i;
    const hasHtml5Doctype = html5DoctypeRegex.test(afterXmlDecl);

    // Also check for any doctype (including older versions)
    const anyDoctypeRegex = /<!DOCTYPE[^>]*>/i;
    const anyDoctypeMatch = afterXmlDecl.match(anyDoctypeRegex);

    // Check if doctype appears at start (critical for standards mode)
    const doctypeAtStart = anyDoctypeMatch
      ? afterXmlDecl.trim().startsWith(anyDoctypeMatch[0])
      : false;

    if (hasHtml5Doctype && doctypeAtStart) {
      const details: Record<string, unknown> = {};
      if (hasBom) {
        details.note = "BOM character found before doctype";
      }
      if (xmlDeclMatch) {
        details.xmlDeclaration = xmlDeclMatch[0];
      }

      checks.push({
        name: "doctype",
        status: "pass",
        message: "Valid HTML5 doctype found",
        value: "<!DOCTYPE html>",
        details: Object.keys(details).length > 0 ? details : undefined,
      });
    } else if (anyDoctypeMatch) {
      // Has a doctype but not HTML5 or not at start
      const foundDoctype = anyDoctypeMatch[0];
      const isHtml4 = /html\s*4/i.test(foundDoctype);
      const isXhtml = /xhtml/i.test(foundDoctype);

      // Check if it's technically HTML5 but has extra content
      const isHtml5ish = /<!DOCTYPE\s+html\s*>/i.test(foundDoctype);

      if (isHtml5ish && !doctypeAtStart) {
        checks.push({
          name: "doctype",
          status: "warn",
          message: "HTML5 doctype not at document start",
          value: foundDoctype,
          expected: "<!DOCTYPE html> at very start",
          details: {
            hasBom,
            hasXmlDecl: !!xmlDeclMatch,
          },
        });
      } else {
        checks.push({
          name: "doctype",
          status: "warn",
          message: `Non-HTML5 doctype found: ${isXhtml ? "XHTML" : isHtml4 ? "HTML4" : "legacy"}`,
          value:
            foundDoctype.slice(0, 50) + (foundDoctype.length > 50 ? "..." : ""),
          expected: "<!DOCTYPE html>",
        });
      }
    } else {
      checks.push({
        name: "doctype",
        status: "fail",
        message: "Missing doctype declaration",
        expected: "<!DOCTYPE html>",
        details: hasBom ? { hasBom: true } : undefined,
      });
    }

    return { checks };
  },
};
