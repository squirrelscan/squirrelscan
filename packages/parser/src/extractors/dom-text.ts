// Shared, non-mutating text extraction for the DOM extractors and rules.
//
// Replaces the `cloneNode(true)` + querySelectorAll-strip + `.textContent`
// pattern (a deep clone per call was the content-extraction bottleneck). The
// walk is iterative — not recursive — so it cannot blow the stack on
// adversarially deep DOMs.

import type { Element, Node } from "linkedom";

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/** Stack marker: a boundary element's children are done, close it. */
const BOUNDARY_CLOSE = Symbol("boundary-close");

/**
 * Concatenate `root`'s descendant text in document order, skipping any subtree
 * whose root element is excluded by `isExcluded`. Output is identical to
 * removing the excluded elements then reading `.textContent` (comments and
 * processing instructions are never visited, matching `.textContent`), but
 * without mutating or cloning the DOM.
 *
 * `separator` is emitted in place of each skipped subtree. It defaults to "",
 * which reproduces remove-then-`.textContent` exactly — including the fact that
 * removing an element GLUES its neighbours together, so `Ã<code>x</code>©` reads
 * back as `Ã©`. Callers that scan the result for character sequences must pass a
 * separator, or they will see sequences that exist in neither fragment.
 *
 * `isBoundary` (optional) wraps each matching element's text in `separator`, on
 * BOTH sides. `.textContent` joins adjacent blocks with nothing at all, so
 * `<td>Author</td><td>undefined</td>` reads back as `Authorundefined` and no
 * word-boundary pattern can see either cell, while `<p>a</p><p>b</p>` reads as
 * `ab` and a line-anchored pattern finds a line start only at offset 0.
 *
 * Entering alone looks sufficient — the next block's own entry closes the
 * previous one — but that only holds between two BLOCKS. A block followed by
 * INLINE content has nothing to close it, so `<h3>Price *</h3><a>terms* apply</a>`
 * reads back as `*terms*`, emphasis present in neither element. Closing on the
 * way out is what makes the separation unconditional.
 *
 * Callers that judge words or characters want this; callers reproducing
 * `.textContent` exactly must leave it off, and nothing changes for them.
 */
export function collectTextExcluding(
  root: Node,
  isExcluded: (el: Element) => boolean,
  separator = "",
  isBoundary?: (el: Element) => boolean
): string {
  const out: string[] = [];
  // Explicit stack of remaining child lists; index tracks position in each.
  // Pushing children in reverse preserves document order on a LIFO stack.
  const stack: (Node | typeof BOUNDARY_CLOSE)[] = [];
  const initial = root.childNodes;
  for (let i = initial.length - 1; i >= 0; i--) stack.push(initial[i] as Node);

  while (stack.length > 0) {
    const entry = stack.pop() as Node | typeof BOUNDARY_CLOSE;
    // A boundary element pushes this before its children, so it pops after them
    // and closes the boundary. See the note above on why entering is not enough.
    if (entry === BOUNDARY_CLOSE) {
      out.push(separator);
      continue;
    }
    const node = entry;
    const type = node.nodeType;
    if (type === TEXT_NODE) {
      out.push((node as { data?: string }).data ?? "");
    } else if (type === ELEMENT_NODE) {
      if (isExcluded(node as Element)) {
        if (separator) out.push(separator);
        continue;
      }
      if (separator && isBoundary?.(node as Element) === true) {
        out.push(separator);
        stack.push(BOUNDARY_CLOSE);
      }
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
