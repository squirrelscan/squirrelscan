// Shared, NON-MUTATING body text extraction for content rules.
//
// `ctx.parsed.document` is shared across every rule for a page, so removing
// nodes from it (the old `querySelectorAll("script, style, noscript")` +
// `el.remove()`) corrupted the DOM later rules saw — and, now that rules run
// concurrently, raced against them. This reads the same text without touching
// the DOM, reusing the parser's iterative walk (stack-safe on deep DOMs).

import type { Element } from "linkedom";

import { collectTextExcluding, tagExcluder } from "@squirrelscan/parser/extractors";

const isScriptLike = tagExcluder(new Set(["script", "style", "noscript"]));

/**
 * `element`'s text with `<script>`/`<style>`/`<noscript>` subtrees excluded —
 * equivalent to removing those elements then reading `.textContent`, without
 * mutating the (shared) DOM.
 */
export function getTextExcludingScripts(element: Element): string {
  return collectTextExcluding(element, isScriptLike);
}
