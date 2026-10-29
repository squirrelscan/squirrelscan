import type { Detector } from "../types";

// Lazy, up to the next script tag open or close: each body is scanned once, so a
// flood of unclosed tags stays linear, and a config far into a big blob still matches.
export const SCRIPT_BODY = String.raw`(?:(?!<\/?script)[\s\S])*?`;
export const STYLE_BODY = String.raw`(?:(?!<\/?style)[\s\S])*?`;

/**
 * A script URL matched two ways: anchored at the start of a `script-url` entry,
 * and as the `src` of a real `<script>` tag in the HTML. The engine scans the raw
 * HTML for `script-url` when no script list is passed, so an unanchored pattern
 * would also fire on a code sample or a link in prose; both forms here need a
 * script tag or a whole script URL. `\s` before `src` rules out `data-src`.
 */
export function scriptSrc(urlSource: string): Detector[] {
  return [
    { type: "script-url", pattern: new RegExp(`^${urlSource}`, "i") },
    {
      type: "html",
      pattern: new RegExp(`<script\\s(?:[^>]{0,300}\\s)?src\\s*=\\s*["']${urlSource}`, "i"),
    },
  ];
}

/** `bodySource` inside the body of a `<script>` element, not in prose or `<pre>`. `requires` is a literal the body must contain. */
export function inScript(bodySource: string, requires: string): Detector {
  return {
    type: "html",
    requires,
    pattern: new RegExp(`<script\\b[^>]{0,300}>${SCRIPT_BODY}${bodySource}`, "i"),
  };
}

/**
 * `source` in a fetched first-party bundle, as code: not inside a comment or a
 * string literal, so a docs snippet or a commented-out call does not match.
 */
export function inBundle(source: string, hint: string): Detector {
  return { type: "script-content", pattern: new RegExp(source), inCode: true, hint };
}

/** `bodySource` inside the body of a `<style>` element. */
export function inStyle(bodySource: string, requires: string): Detector {
  return {
    type: "html",
    requires,
    pattern: new RegExp(`<style\\b[^>]{0,300}>${STYLE_BODY}${bodySource}`, "i"),
  };
}

/** `urlSource` as the value of a resource attribute on one of `tags`, never an `<a href>`. */
export function resourceAttr(tags: string, attrs: string, urlSource: string): Detector {
  return {
    type: "html",
    pattern: new RegExp(
      `<(?:${tags})\\s(?:[^>]{0,400}\\s)?(?:${attrs})\\s*=\\s*["'](?:[^"']{0,200}[\\s,])?${urlSource}`,
      "i",
    ),
  };
}
