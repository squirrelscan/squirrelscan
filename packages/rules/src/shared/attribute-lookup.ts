// Look elements up by a page-controlled attribute value without building a
// selector string (#1276).
//
// An id, `for` or `role` value taken from the page can hold `"`, `\`, `]` or a
// space. Interpolated into `label[for="${id}"]` it throws ("Attribute selector
// didn't terminate") or quietly means something else, and `CSS.escape` does not
// exist in the compiled binary. Both helpers compare the attribute value as a
// plain string instead.

/** Elements whose `attr` equals `value` exactly, in document order. */
export function elementsWithAttribute(root: QueryRoot, attr: string, value: string): Element[] {
  const out: Element[] = [];
  for (const el of root.querySelectorAll(`[${attr}]`)) {
    if (el.getAttribute(attr) === value) out.push(el);
  }
  return out;
}

const labelsByFor = new WeakMap<Document, Map<string, Element[]>>();

/** The `<label for>` elements pointing at `id`, from one pass per document. */
export function labelsFor(doc: Document, id: string): Element[] {
  let index = labelsByFor.get(doc);
  if (!index) {
    index = new Map();
    for (const label of doc.querySelectorAll("label[for]")) {
      const target = label.getAttribute("for") ?? "";
      const list = index.get(target);
      if (list) list.push(label);
      else index.set(target, [label]);
    }
    labelsByFor.set(doc, index);
  }
  return index.get(id) ?? [];
}

/**
 * Structural stand-ins for the DOM `Element` and `ParentNode` parameters of the
 * rule helpers. Under `@cloudflare/workers-types` the global `Element` is the
 * HTMLRewriter class, which the parser's DOM elements are not assignable to
 * (repo#4562), so helpers that only read attributes and children type what they
 * use instead of the global name.
 */
export interface AttrReadable {
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  readonly textContent: string | null;
  closest(selector: string): { textContent: string | null } | null;
}

export interface QueryRoot {
  querySelectorAll(selector: string): Iterable<Element>;
}

export interface ChildrenParent {
  readonly children: ArrayLike<unknown>;
}
