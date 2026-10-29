// Look elements up by a page-controlled attribute value without building a
// selector string (#1276).
//
// An id, `for` or `role` value taken from the page can hold `"`, `\`, `]` or a
// space. Interpolated into `label[for="${id}"]` it throws ("Attribute selector
// didn't terminate") or quietly means something else, and `CSS.escape` does not
// exist in the compiled binary. Both helpers compare the attribute value as a
// plain string instead.

/** Elements whose `attr` equals `value` exactly, in document order. */
export function elementsWithAttribute(root: ParentNode, attr: string, value: string): Element[] {
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
