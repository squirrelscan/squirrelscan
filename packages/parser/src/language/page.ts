// Per-page and per-block content language for the rule context
// (squirrelscan/repo#2360). Lazy and memoised: nothing is detected until a rule
// asks, and each page is detected at most once however many rules ask.
//
// The text comes from the main content root (`getMainContentWithRoot`): site
// chrome (nav, header, footer, aside), scripts and code are skipped. When the
// classifier-driven extractor (squirrelscan/repo#2359) lands, it replaces the
// root and block segmentation here; the view's shape stays the same.

import type { Document, Element, Node } from "linkedom";

import { collectTextExcluding } from "../extractors/dom-text";
import { getMainContentWithRoot } from "../extractors/content";
import {
  withLanguageFloor,
  type DetectedLanguage,
  type LanguageDetector,
} from "./detector";
import { createFrancDetector, FRANC_WEB_LANGUAGES } from "./franc";

/** The production detector: franc over the web language list, behind the abstention floor. */
export const defaultContentLanguageDetector: LanguageDetector = withLanguageFloor(
  createFrancDetector({ only: FRANC_WEB_LANGUAGES }),
);

/** Detect the language `text` is written in with the production detector; null = abstained. */
export function detectContentLanguage(text: string): DetectedLanguage | null {
  return defaultContentLanguageDetector.detectLanguage(text);
}

/** Most blocks a page reports a language for, in document order. */
export const CONTENT_LANGUAGE_MAX_BLOCKS = 200;

// Elements whose text is not prose in the page's language.
const LANGUAGE_EXCLUDED_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "nav",
  "header",
  "footer",
  "aside",
  "pre",
  "code",
  "kbd",
  "samp",
]);

/** Blocks a language is reported for. The outermost match wins: an `li` holding a `p` is one block. */
const LANGUAGE_BLOCK_TAGS = new Set([
  "p",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "td",
  "th",
  "dd",
  "dt",
  "figcaption",
  "caption",
  "summary",
]);

// Block-level elements whose text is separated by a space so neighbouring
// blocks do not glue into one word (and into trigrams in neither).
const SEPARATED_TAGS = new Set([
  ...LANGUAGE_BLOCK_TAGS,
  "div",
  "section",
  "article",
  "main",
  "br",
  "tr",
  "ul",
  "ol",
  "dl",
  "table",
]);

const tagOf = (el: Element): string => el.tagName?.toLowerCase() ?? "";
const isExcluded = (el: Element): boolean =>
  LANGUAGE_EXCLUDED_TAGS.has(tagOf(el)) || el.getAttribute?.("aria-hidden") === "true";
const isSeparated = (el: Element): boolean => SEPARATED_TAGS.has(tagOf(el));

function languageText(root: Element): string {
  return collectTextExcluding(root as unknown as Node, isExcluded, " ", isSeparated);
}

/**
 * The text the page-level detection reads: the main content root's prose, with
 * chrome, scripts and code skipped. Exported so the benchmark measures exactly
 * what production detects on.
 */
export function mainContentLanguageText(doc: Document): string {
  const { root } = getMainContentWithRoot(doc);
  return root ? languageText(root) : "";
}

/** One block of the main content and its detected language (null = abstained). */
export interface ContentLanguageBlock {
  /** Position among the reported blocks, in document order. */
  index: number;
  /** Lowercase tag name of the block element. */
  tag: string;
  element: Element;
  language: DetectedLanguage | null;
}

/** What rules read from `ctx.contentLanguage`. */
export interface ContentLanguageView {
  /** Id of the detector behind the view. */
  readonly detectorId: string;
  /** The main content's language; null when the detector abstains or the page has no text. */
  page(): DetectedLanguage | null;
  /**
   * Per-block languages over the main content, at most
   * {@link CONTENT_LANGUAGE_MAX_BLOCKS}. Empty when the DOM is not available.
   * Short blocks usually abstain: the floor applies per block.
   */
  blocks(): readonly ContentLanguageBlock[];
}

/** The parsed-page fields the view reads. */
export interface ContentLanguageSource {
  document: Document | null;
  content?: { textContent?: string } | null;
}

/** Outermost block elements under `root`, in document order, skipping excluded subtrees. */
function collectBlocks(root: Element, max: number): Element[] {
  const out: Element[] = [];
  const stack: Element[] = [];
  const initial = Array.from(root.children ?? []) as Element[];
  for (let i = initial.length - 1; i >= 0; i--) stack.push(initial[i]);
  while (stack.length > 0 && out.length < max) {
    const el = stack.pop() as Element;
    if (isExcluded(el)) continue;
    if (LANGUAGE_BLOCK_TAGS.has(tagOf(el))) {
      out.push(el);
      continue;
    }
    const children = Array.from(el.children ?? []) as Element[];
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return out;
}

/**
 * Build the lazy content-language view for one parsed page. Without a DOM (a
 * page read back from storage) the page language comes from the stored
 * `content.textContent` and there are no blocks.
 */
export function createContentLanguageView(
  source: ContentLanguageSource,
  detector: LanguageDetector = defaultContentLanguageDetector,
): ContentLanguageView {
  let root: Element | null | undefined;
  const mainRoot = (): Element | null => {
    if (root === undefined) {
      root = source.document ? getMainContentWithRoot(source.document).root : null;
    }
    return root;
  };

  let pageDone = false;
  let pageResult: DetectedLanguage | null = null;
  let blockResult: ContentLanguageBlock[] | undefined;

  return {
    detectorId: detector.id,
    page() {
      if (!pageDone) {
        const el = mainRoot();
        const text = el ? languageText(el) : (source.content?.textContent ?? "");
        pageResult = detector.detectLanguage(text);
        pageDone = true;
      }
      return pageResult;
    },
    blocks() {
      if (!blockResult) {
        const el = mainRoot();
        blockResult = el
          ? collectBlocks(el, CONTENT_LANGUAGE_MAX_BLOCKS).map((block, index) => ({
              index,
              tag: tagOf(block),
              element: block,
              language: detector.detectLanguage(languageText(block)),
            }))
          : [];
      }
      return blockResult;
    },
  };
}
