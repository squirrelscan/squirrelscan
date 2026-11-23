// Elements that render apart from their siblings, so text on either side is two words.
const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
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
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "td",
  "th",
  "tr",
  "ul",
]);
const INLINE_BLOCK_DISPLAY =
  /display\s*:\s*(?:block|flex|grid|table|list-item|flow-root)/i;

export function getVisibleText(el: Element): string {
  // Get only visible text content (excluding aria-hidden)
  let text = "";

  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      // Text node
      text += node.textContent || "";
    } else if (node.nodeType === 1) {
      // Element node
      const element = node as Element;
      const ariaHidden = element.getAttribute("aria-hidden");
      const hidden = element.getAttribute("hidden");

      if (ariaHidden === "true" || hidden !== null) return;

      const apart =
        BLOCK_TAGS.has(element.tagName.toLowerCase()) ||
        INLINE_BLOCK_DISPLAY.test(element.getAttribute("style") ?? "");
      if (apart) text += " ";
      for (const child of Array.from(node.childNodes)) {
        walk(child);
      }
      if (apart) text += " ";
    }
  };

  walk(el);
  return text.trim().toLowerCase();
}

// Visible text with no letter or digit (✕ × ✖ ☰ › punctuation, emoji) is a symbol used as an icon,
// not a label a user would speak: WCAG 2.5.3 excludes it, as does axe-core's rule of the same name.
export const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

// True when a control's visible text is missing from its aria-label: the condition
// a11y/label-content-name-mismatch flags (WCAG 2.5.3), before its visibility check.
export function visibleTextMissingFromAriaLabel(el: Element): boolean {
  const ariaLabel = el.getAttribute("aria-label")?.toLowerCase().trim() || "";
  if (!ariaLabel) return false;
  const visibleText = getVisibleText(el);
  if (!visibleText || !HAS_LETTER_OR_DIGIT.test(visibleText)) return false;
  const normalizedVisible = visibleText.replace(/\s+/g, " ");
  const normalizedAriaLabel = ariaLabel.replace(/\s+/g, " ");
  // Class-based flex/block children cannot be seen statically and may join with no space,
  // so whitespace differences alone are not a mismatch.
  const squash = (v: string) => v.replace(/\s+/g, "");
  return (
    !normalizedAriaLabel.includes(normalizedVisible) &&
    !squash(normalizedAriaLabel).includes(squash(normalizedVisible))
  );
}
