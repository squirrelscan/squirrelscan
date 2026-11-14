// The one anchor-text function every link extractor uses (#110). `parsePage` stores `html.ts`'s
// links and `extractors/links.ts` has its own variant; both must read the same text, and so must
// a rule that re-reads an anchor from the DOM and looks it up against the stored text.

import type { Element } from "linkedom";

// Elements a browser lays out as their own block or line. Text on either side of one is separate
// words even when the markup has no whitespace there. Inline elements (`b`, `span`, `em`, `a`) are
// deliberately absent: `Re<b>start</b>` is one word and `<b>world</b>!` has no gap before `!`.
const BOUNDARY_TAGS: ReadonlySet<string> = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "button",
  "caption",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "label",
  "li",
  "main",
  "nav",
  "ol",
  "option",
  "p",
  "pre",
  "section",
  "select",
  "summary",
  "svg",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

// Text a browser does not render as part of the link: its content is never anchor text.
const NON_TEXT_TAGS: ReadonlySet<string> = new Set(["script", "style", "template", "noscript"]);

// An inline `style="display:block"` (or flex, grid, ...) makes an element a layout block whatever
// its tag. Class-based CSS cannot be seen at parse time.
const INLINE_BLOCK_DISPLAY = /display\s*:\s*(?:block|flex|grid|table|list-item|flow-root)/i;

export interface AnchorTextResult {
  text: string;
  /**
   * Text from two or more elements was joined with no whitespace and no boundary between them
   * (`Re<b>start</b>`, or a card whose blocks come from class-based CSS this parse cannot see).
   * The words may really be separate, so a reader comparing the text should be lenient.
   */
  glued: boolean;
  /**
   * The text cut at each point where adjacent elements were joined without a separator, present
   * only when `glued`. A card of class-based blocks reads as its own words here ("LG", "See
   * details") where `text` has them fused ("LGSee details"). Capped in count and length.
   */
  parts?: string[];
}

/**
 * Caps on `parts`. A part cut at {@link MAX_ANCHOR_PART_LENGTH} characters, or a list that reached
 * {@link MAX_ANCHOR_PARTS} entries (blank parts are not stored, so a full list may have dropped
 * later ones), is incomplete: a reader must not treat a word's absence from it as evidence.
 */
export const MAX_ANCHOR_PARTS = 16;
export const MAX_ANCHOR_PART_LENGTH = 200;
const MAX_PARTS = MAX_ANCHOR_PARTS;
const MAX_PART_LENGTH = MAX_ANCHOR_PART_LENGTH;

/**
 * The anchor's text with a space at each block-level boundary between child nodes. `textContent`
 * glues them, so a card link wrapping a heading and a description reads
 * "CarpentryStructural & finish carpentry". A space is added only where neither side already has
 * whitespace; text that was already separated, and text split by inline elements, is returned
 * exactly as `textContent` gave it (trimmed). Text inside `script`, `style`, `template` and
 * `noscript` is skipped, so an icon's `<svg><style>..</style></svg>` does not glue into the label.
 *
 * Boundaries come from the tag name and an inline `style="display:block|flex|grid|table|list-item"`.
 * CSS from a stylesheet or a class (an inline `div`, a block `span`) cannot be seen at parse time;
 * `glued` reports when text from adjacent elements was joined without any boundary.
 *
 * A nested `<a>` (invalid HTML a browser would split into sibling links) is skipped: its text is
 * the inner link's, not this one's (#1844).
 *
 * Iterative with an explicit stack and linear in the text: an anchor holding tens of thousands of
 * nested or sibling elements must neither overflow the call stack nor rescan its text per node.
 */
export function anchorTextResult(element: Element): AnchorTextResult {
  const chunks: string[] = [];
  // Whether what is collected so far ends in whitespace (or is empty): tracked, never re-scanned.
  let endsWithSpace = true;
  let hasText = false;
  // Set at a block boundary; resolved to a space when the next text does not start with one.
  let pendingGap = false;
  let glued = false;
  // The current part's chunks and the finished parts; only kept when the text turns out glued.
  let partChunks: string[] = [];
  const parts: string[] = [];
  const pushPart = (): void => {
    const part = partChunks.join("").trim();
    if (part !== "" && parts.length < MAX_PARTS) parts.push(part.slice(0, MAX_PART_LENGTH));
  };
  let lastParent: Node | null = null;
  const stack: Array<{ nodes: NodeListOf<ChildNode>; i: number; boundary: boolean }> = [
    { nodes: element.childNodes, i: 0, boundary: false },
  ];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.i >= frame.nodes.length) {
      if (frame.boundary) pendingGap = true;
      stack.pop();
      continue;
    }
    const child = frame.nodes[frame.i++]!;
    if (child.nodeType === 3) {
      const text = child.textContent ?? "";
      if (text === "") continue;
      const startsWithSpace = /^\s/.test(text);
      if (pendingGap && hasText && !endsWithSpace && !startsWithSpace) {
        chunks.push(" ");
        partChunks.push(" ");
        endsWithSpace = true;
      } else if (
        hasText &&
        !pendingGap &&
        !endsWithSpace &&
        !startsWithSpace &&
        child.parentNode !== lastParent
      ) {
        glued = true;
        pushPart();
        partChunks = [];
      }
      pendingGap = false;
      chunks.push(text);
      partChunks.push(text);
      hasText = true;
      endsWithSpace = /\s$/.test(text);
      lastParent = child.parentNode;
    } else if (child.nodeType === 1) {
      const el = child as Element;
      const tag = el.tagName.toLowerCase();
      if (NON_TEXT_TAGS.has(tag)) continue;
      // A nested anchor is its own link, not text of this one (#1844). A browser never builds
      // `<a>` inside `<a>`: the HTML parser closes the open anchor when the next one starts
      // (the adoption agency algorithm), so its text belongs to the inner link alone. This parse
      // keeps the nesting, and reading every descendant anchor's text into each ancestor made
      // the stored text quadratic in nesting depth (about 1 GB, 45 s, at 20,000 nested links).
      // Stopping here reads each text node once per page. The skipped anchor separates the
      // outer anchor's text on either side of it, like a block.
      if (tag === "a") {
        pendingGap = true;
        continue;
      }
      const boundary =
        BOUNDARY_TAGS.has(tag) || INLINE_BLOCK_DISPLAY.test(el.getAttribute("style") ?? "");
      if (boundary) pendingGap = true;
      stack.push({ nodes: el.childNodes, i: 0, boundary });
    }
  }
  if (!glued) return { text: chunks.join("").trim(), glued };
  pushPart();
  return { text: chunks.join("").trim(), glued, parts };
}

/** The anchor's text; see {@link anchorTextResult}. */
export function anchorText(element: Element): string {
  return anchorTextResult(element).text;
}
