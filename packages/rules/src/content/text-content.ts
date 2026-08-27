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
