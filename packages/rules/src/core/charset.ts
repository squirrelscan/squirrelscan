// core/charset - Check for charset declaration

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { getAttrCI, querySelectorByAttrValueCI } from "@squirrelscan/utils";

/** The `charset=` parameter of a Content-Type value, quotes dropped (`charset="utf-8"` is valid). */
function charsetParam(contentType: string): string | undefined {
  const raw = contentType.match(/charset\s*=\s*([^\s;]+)/i)?.[1];
  return raw?.replace(/^["']|["']$/g, "") || undefined;
}

function isUtf8(label: string): boolean {
  return /^utf-?8$/i.test(label);
}

/**
 * HTML Standard §4.2.5.4: the element holding the encoding declaration "must be
 * serialized completely within the first 1024 bytes of the document", the
 * window the browser prescans before it starts parsing.
 */
const PRESCAN_BYTES = 1024;

// One prescan token (HTML Standard §13.2.3.2): a comment; a `<meta>` tag; any
// other tag, skipped whole so a `<meta` inside its quoted attribute is not read;
// or a `<!…>`, `<?…>` construct. Quoted values may hold `>`, and one left open
// runs to the end of the window, so scanning never resumes inside it. A `<meta>`
// is complete only when `metaEnd` caught its closing `>`.
const PRESCAN_TOKEN =
  /<!--[\s\S]*?(?:-->|$)|<meta(?=[\s/>])(?:[^>"']|"[^"]*(?:"|$)|'[^']*(?:'|$))*(?<metaEnd>>)?|<\/?[a-z](?:[^>"']|"[^"]*(?:"|$)|'[^']*(?:'|$))*>?|<[!/?][^>]*>?/gi;
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

/** A raw `<meta …>` tag that declares a charset, by either attribute form. */
function isCharsetDeclaration(tag: string): boolean {
  const attrs = new Map<string, string>();
  for (const m of tag.slice("<meta".length).matchAll(ATTRIBUTE)) {
    const name = m[1].toLowerCase();
    if (!attrs.has(name)) attrs.set(name, m[2] ?? m[3] ?? m[4] ?? "");
  }
  if (attrs.has("charset")) return true;
  return (
    attrs.get("http-equiv")?.toLowerCase() === "content-type" &&
    /charset\s*=/i.test(attrs.get("content") ?? "")
  );
}

/**
 * Whether the first charset-declaring `<meta>` in the raw HTML ends within the
 * prescan window. Comments and other tags are skipped, as the prescan skips
 * them. A UTF-16 code unit is at least one UTF-8 byte, so only the first 1024
 * code units can hold a declaration that fits, and only they are scanned. The
 * decoded body has lost any UTF-8 BOM, so such a page is measured 3 bytes
 * short; its BOM decides the decoding anyway.
 */
function declaredWithinPrescan(html: string): boolean {
  const prefix = html.slice(0, PRESCAN_BYTES);
  for (const m of prefix.matchAll(PRESCAN_TOKEN)) {
    const tag = m[0];
    if (!/^<meta[\s/>]/i.test(tag) || !isCharsetDeclaration(tag)) continue;
    if (m.groups?.metaEnd === undefined) return false;
    const end = m.index + tag.length;
    return new TextEncoder().encode(prefix.slice(0, end)).length <= PRESCAN_BYTES;
  }
  return false;
}

export const charsetRule: Rule = {
  meta: {
    id: "core/charset",
    name: "Charset",
    description: "Checks for proper character encoding declaration",
    solution:
      'Add <meta charset="UTF-8"> as the first element in your <head> section. This tells browsers how to interpret the text on your page. UTF-8 is the standard encoding that supports all languages and special characters. Placing it first ensures browsers know the encoding before parsing any other content.',
    category: "core",
    // NOT "template", even though it is constant on both measured corpora and on
    // the authored one. The charset can come from the `Content-Type` RESPONSE
    // HEADER, which the template cluster key constrains in no way and which two
    // pages of one template routinely differ in — an origin that sets
    // `text/html; charset=utf-8` on some routes and a bare `text/html` on others
    // makes this rule pass on one and fail on the other. Every corpus in the gates
    // declares the charset in a `<meta>` tag, so the header branch is never
    // reached there and no measurement could have caught it. This is the same
    // disqualification VerdictScope already applies to `perf/cache-headers`,
    // `security/cookie-flags` and `perf/compression`; the counterexample is pinned
    // in packages/rules/tests/template-verdict-page-independence.test.ts (#1951).
    scope: "page",
    verdictScope: "page",
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
    const httpEquivCharset = charsetParam(contentValue);

    // Check Content-Type header
    const headerContentType = ctx.page.headers["content-type"] || "";
    const headerCharset = charsetParam(headerContentType);

    const pageCharset = charsetValue || httpEquivCharset;
    // The header decides the decoding when it names a charset: the browser
    // reads the transport encoding before it prescans for a meta (pub#659).
    const declaredCharset = headerCharset || pageCharset;

    if (
      headerCharset &&
      pageCharset &&
      isUtf8(headerCharset) !== isUtf8(pageCharset)
    ) {
      // Both non-UTF-8 under different labels (iso-8859-1 vs windows-1252) is
      // not reported as a conflict: the labels can name one encoding, and the
      // Non-UTF-8 warning below already covers the page.
      checks.push({
        name: "charset",
        status: "warn",
        message: `Conflicting charset declarations: header ${headerCharset}, page ${pageCharset}`,
        value: declaredCharset,
        expected: "UTF-8 in both the Content-Type header and the page",
      });
    } else if (declaredCharset) {
      if (isUtf8(declaredCharset)) {
        // Check if charset is early in head
        if (
          pageCharset &&
          !ctx.page.rendered &&
          ctx.page.html &&
          !declaredWithinPrescan(ctx.page.html)
        ) {
          if (headerCharset) {
            // The header decides the decoding before any prescan, and it agrees
            // with the meta (a conflict was handled above), so the position of
            // the meta is a conformance note only (pub#1220). Info is
            // score-neutral, like the placement advice below.
            checks.push({
              name: "charset",
              status: "info",
              message:
                "The Content-Type header already sets UTF-8; moving the charset meta into the first 1024 bytes is a conformance fix only",
              value: declaredCharset,
              expected: "charset meta serialized completely within the first 1024 bytes",
            });
          } else {
            // Without a header the browser has already guessed.
            checks.push({
              name: "charset",
              status: "warn",
              message: "Charset meta is not within the first 1024 bytes",
              value: declaredCharset,
              expected: "charset meta serialized completely within the first 1024 bytes",
            });
          }
        } else if (charsetMeta) {
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
            // Placement advice, not an encoding problem (pub#659): the page
            // decodes as UTF-8. Info is score-neutral, like other advice.
            checks.push({
              name: "charset",
              status: "info",
              message:
                "UTF-8 is declared correctly; consider placing the charset meta first in head (best practice)",
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
