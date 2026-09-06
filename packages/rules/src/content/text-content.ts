// Shared, NON-MUTATING body text extraction for content rules.
//
// `ctx.parsed.document` is shared across every rule for a page, so removing
// nodes from it (the old `querySelectorAll("script, style, noscript")` +
// `el.remove()`) corrupted the DOM later rules saw — and, now that rules run
// concurrently, raced against them. This reads the same text without touching
// the DOM, reusing the parser's iterative walk (stack-safe on deep DOMs).

import type { Element } from "linkedom";

import { collectTextExcluding, tagExcluder } from "@squirrelscan/parser/extractors";

const SCRIPT_LIKE_TAGS = ["script", "style", "noscript"] as const;

/**
 * Markup that says "this is a literal, not prose": whatever is inside was written
 * to be read as source, so a rule that judges the words a visitor reads must not
 * judge these. `<code>` and `<pre>` cover the common cases; `<samp>` (program
 * output) and `<kbd>` (keys to press) are the same promise in different words.
 */
const CODE_LIKE_TAGS = ["code", "pre", "samp", "kbd"] as const;

const isScriptLike = tagExcluder(new Set<string>(SCRIPT_LIKE_TAGS));
const isScriptOrCodeLike = tagExcluder(new Set<string>([...SCRIPT_LIKE_TAGS, ...CODE_LIKE_TAGS]));

/**
 * `element`'s text with `<script>`/`<style>`/`<noscript>` subtrees excluded —
 * equivalent to removing those elements then reading `.textContent`, without
 * mutating the (shared) DOM.
 */
export function getTextExcludingScripts(element: Element): string {
  return collectTextExcluding(element, isScriptLike);
}

/**
 * A newline, never a space, stands in for each skipped subtree.
 *
 * Skipping a subtree glues its neighbours: `Ã<code>x</code>©` would otherwise
 * read back as `Ã©` and look like corruption that is in neither fragment. A
 * space does not fix that — `"Ã "` (à) and `"Â "` (nbsp) are themselves mojibake
 * sequences, so a space boundary trades one false positive for another. No
 * mojibake sequence contains a newline.
 */
const SKIPPED_SUBTREE_BOUNDARY = "\n";

/**
 * `element`'s PROSE text: `getTextExcludingScripts` minus code-like subtrees
 * (`<code>`, `<pre>`, `<samp>`, `<kbd>`), with a newline where each skipped
 * subtree was.
 *
 * For rules that judge the sentences a visitor reads rather than every character
 * on the page. A page documenting a string — a changelog quoting the exact bytes
 * a rule detects, a docs page listing shell output — should not be judged as if
 * it had written that string by accident.
 */
export function getProseTextExcludingCode(element: Element): string {
  return collectTextExcluding(element, isScriptOrCodeLike, SKIPPED_SUBTREE_BOUNDARY);
}

/**
 * Markup the browser parses but never renders. `<template>` content is inert —
 * it exists to be cloned by JavaScript — yet linkedom keeps it in `childNodes`,
 * so a plain text walk reads it as if a visitor saw it. Every Vue, Alpine,
 * Handlebars and htmx page carries unrendered `{{ }}` in there, which is
 * exactly what a placeholder rule is looking for and exactly what it must not
 * report.
 */
const NON_RENDERED_TAGS = ["template"] as const;

/**
 * Container classes used by in-page code editors and syntax highlighters. They
 * make the same promise `<code>` makes — what follows is source, read it as a
 * literal — but CodeMirror and Monaco build their view out of plain divs and
 * spans with no `<pre>` or `<code>` anywhere in the chain. Without this a Liquid
 * or Handlebars tutorial reads as a page full of unrendered template syntax.
 */
const CODE_CONTAINER_CLASSES = new Set([
  "hljs",
  "shiki",
  "prism",
  "torchlight",
  "codeblock",
  "code-block",
  "cm-editor",
  "monaco-editor",
]);

/** Prefixes of the same thing, where the suffix names the language or the part. */
const CODE_CONTAINER_PREFIXES = ["language-", "cm-", "monaco-"] as const;

const isCodeContainerClass = (token: string): boolean =>
  CODE_CONTAINER_CLASSES.has(token) || CODE_CONTAINER_PREFIXES.some((p) => token.startsWith(p));

const isTagExcluded = tagExcluder(
  new Set<string>([...SCRIPT_LIKE_TAGS, ...CODE_LIKE_TAGS, ...NON_RENDERED_TAGS]),
);

function isScriptCodeOrUnrendered(el: Element): boolean {
  if (isTagExcluded(el)) return true;
  const className = el.getAttribute?.("class");
  if (!className) return false;
  // split() over classList: linkedom exposes both, and the split is the cheaper
  // of the two on an element that usually has no interesting class at all.
  return className.split(/\s+/).some(isCodeContainerClass);
}

/**
 * Elements a browser lays out on their own line. A reader sees a break between
 * two table cells; `.textContent` does not, and joins them into one word. Rules
 * that judge WORDS have to see the break, or `<td>Author</td><td>undefined</td>`
 * is the single token `Authorundefined`.
 */
const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "br", "caption", "dd", "details",
  "dialog", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer",
  "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "li",
  "main", "nav", "ol", "option", "p", "section", "summary", "table", "tbody",
  "td", "tfoot", "th", "thead", "tr", "ul",
]);

const isBlockElement = tagExcluder(BLOCK_TAGS);

/**
 * `element`'s RENDERED prose: `getProseTextExcludingCode` minus `<template>`
 * subtrees and code containers, with a newline where each skipped subtree was
 * AND at every block boundary.
 *
 * For rules that judge only what a visitor's eyes land on. Kept separate from
 * `getProseTextExcludingCode` so existing callers keep their exact behaviour.
 */
export function getRenderedProseText(element: Element): string {
  return collectTextExcluding(
    element,
    isScriptCodeOrUnrendered,
    SKIPPED_SUBTREE_BOUNDARY,
    isBlockElement,
  );
}
