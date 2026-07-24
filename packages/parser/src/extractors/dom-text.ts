// Shared, non-mutating text extraction for the DOM extractors and rules.
//
// Replaces the `cloneNode(true)` + querySelectorAll-strip + `.textContent`
// pattern (a deep clone per call was the content-extraction bottleneck). The
// walk is iterative — not recursive — so it cannot blow the stack on
// adversarially deep DOMs.

import type { Element, Node } from "linkedom";

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/**
 * Concatenate `root`'s descendant text in document order, skipping any subtree
 * whose root element is excluded by `isExcluded`. Output is identical to
 * removing the excluded elements then reading `.textContent` (comments and
 * processing instructions are never visited, matching `.textContent`), but
 * without mutating or cloning the DOM.
 */
export function collectTextExcluding(
  root: Node,
  isExcluded: (el: Element) => boolean
): string {
  const out: string[] = [];
  // Explicit stack of remaining child lists; index tracks position in each.
  // Pushing children in reverse preserves document order on a LIFO stack.
  const stack: Node[] = [];
  const initial = root.childNodes;
  for (let i = initial.length - 1; i >= 0; i--) stack.push(initial[i] as Node);

  while (stack.length > 0) {
    const node = stack.pop() as Node;
    const type = node.nodeType;
    if (type === TEXT_NODE) {
      out.push((node as { data?: string }).data ?? "");
    } else if (type === ELEMENT_NODE) {
      if (isExcluded(node as Element)) continue;
      const children = node.childNodes;
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push(children[i] as Node);
      }
    }
  }

  return out.join("");
}

/**
 * Build an exclusion predicate that drops elements whose lowercased tag name is
 * in `tags`.
 */
export function tagExcluder(tags: ReadonlySet<string>): (el: Element) => boolean {
  return (el) => {
    const tag = el.tagName?.toLowerCase();
    return !!tag && tags.has(tag);
  };
}
