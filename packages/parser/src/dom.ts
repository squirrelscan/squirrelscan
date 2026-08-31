// The HTML parsing entry point: parse through `parseHTML` from here, never
// straight from linkedom, so attribute lookups follow the HTML case rules.
//
// A browser ASCII-lowercases attribute names while parsing HTML, and
// `getAttribute` lowercases its argument for any element in the HTML namespace.
// linkedom does neither: it stores the source spelling and compares it exactly,
// so `getAttribute("inputmode")` misses `inputMode="url"` and, on a page that
// spells it in lowercase, `getAttribute("inputMode")` misses it too (#1507).
// React-adjacent SSR passes unknown props straight through, so camelCase
// attributes are ordinary valid markup, and every rule reading an attribute by
// name had the exposure in both directions.
//
// Reading is where the fix lives: parsing never renames an attribute, so
// serialisation is byte-identical and anything walking `el.attributes` still
// sees the author's spelling. Writing through `setAttribute` does lowercase the
// name, because that is what a browser does and because linkedom recognises
// only the literal name `class` when it keeps `classList` in step.
//
// SVG is left alone, because there attribute names really are case-sensitive in
// a browser: `viewBox` and `preserveAspectRatio` keep matching only their exact
// spelling.
//
// The patch is on a prototype linkedom exports, so it reaches every linkedom
// element in the process, not only documents parsed here. Scoping it to those
// was tried and dropped: linkedom does not repoint `ownerDocument` when a node
// moves between documents, and `Document.cloneNode()` produces an unregistered
// one, so the scope check turned the fix silently OFF on exactly the paths it
// was meant to make precise — the failure mode of #1507 itself. Nothing in this
// repo parses XML (the guard test in tests/attribute-case.test.ts keeps
// linkedom reachable only through this module); anyone adding an XML parser
// should add it here and give it back its case-sensitive names.
//
// NOT covered, both deliberately:
//
// - MathML. linkedom's parser specialises SVG but not MathML, so a `<math>`
//   subtree reports the XHTML namespace and gets the HTML rules. Telling which
//   of its elements are really MathML needs the tree-construction context —
//   integration points, breakout tags — that linkedom never recorded, so every
//   approximation of it is wrong somewhere. The single attribute at stake is
//   `definitionURL`, the only camelCase name the HTML parser produces for
//   MathML, and no rule reads it.
// - `el.dataset`. linkedom builds its DOMStringMap by walking `el.attributes`
//   for a literal `data-` prefix, so `<div DATA-Foo="v">` is
//   `getAttribute("data-foo") === "v"` but `dataset.foo === undefined`. Nothing
//   in the engine reads `dataset`; read attributes by name instead.

import { Element as ElementFacade } from "linkedom";

export { parseHTML } from "linkedom";

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

// Minimal structural views of the linkedom internals touched here. linkedom's
// own types describe `attributes` as a NamedNodeMap that is not iterable, which
// it is at runtime.
interface AttrNode {
  name: string;
  value: string;
}

interface AttrElement {
  namespaceURI: string;
  className: string;
  attributes: Iterable<AttrNode>;
  classList: { clear(): void };
  getAttributeNode(name: string): AttrNode | null;
}

interface SharedState {
  installed: boolean;
  /**
   * Lowercased name -> attribute node, for the attributes of one element whose
   * names are NOT already lowercase. `null` records the overwhelmingly common
   * answer, "this element has none", so a repeat miss costs one WeakMap read
   * rather than a walk over `el.attributes` (which allocates a NamedNodeMap and
   * a Proxy per access, and a rule pass asks about absent attributes ~10^5
   * times a page).
   *
   * Keyed on the attribute SET, so every method that adds or removes one drops
   * the entry. linkedom leaves `Attr.name` writable, unlike the DOM, and
   * renaming one in place would go unnoticed here; nothing writes it.
   */
  mixedCaseAttrs: WeakMap<object, Map<string, AttrNode> | null>;
}

// State lives on the global, not in this module's closure, so that two
// evaluations of this file (a bundler emitting two copies) share one cache and
// one install flag rather than the second quietly shadowing the first.
const STATE_KEY = Symbol.for("squirrelscan.parser.html-attribute-case");
const globalScope = globalThis as unknown as Record<symbol, SharedState | undefined>;

const state: SharedState = (globalScope[STATE_KEY] ??= {
  installed: false,
  mixedCaseAttrs: new WeakMap<object, Map<string, AttrNode> | null>(),
});

const { mixedCaseAttrs } = state;

const NON_ASCII = /[^\u0000-\u007f]/;

/**
 * ASCII lowercase, which is all "case-insensitive" means in HTML.
 * `toLowerCase()` also folds non-ASCII — U+212A KELVIN SIGN becomes "k" — which
 * would let an authored `K="…"` answer to `getAttribute("k")` where a browser
 * says null, and would rewrite the name `getAttributeNames()` reports.
 */
function asciiLowerCase(value: string): string {
  if (!NON_ASCII.test(value)) return value.toLowerCase();
  return value.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** An element the HTML case rules apply to. */
function isHtmlElement(el: AttrElement): boolean {
  return el.namespaceURI === HTML_NAMESPACE;
}

/** A name that means `class` to a browser but not to linkedom. */
function isMixedCaseClass(name: string): boolean {
  return name !== "class" && asciiLowerCase(name) === "class";
}

/**
 * Rebuild the cached class list from whatever `class` attribute the element has
 * now. linkedom does this itself for the literal name `class` only, so any
 * write that reaches the attribute under another spelling would leave
 * `className` and every class selector answering the old value.
 */
function resyncClassList(el: AttrElement): void {
  const stored = el.getAttributeNode("class");
  el.classList.clear();
  if (!stored) return;
  // Rebuilding the token list writes its own joined spelling back to the
  // attribute; a browser leaves the value exactly as given, so put it back.
  const authored = stored.value;
  el.className = authored;
  stored.value = authored;
}

function mixedCaseIndexOf(el: AttrElement): Map<string, AttrNode> | null {
  const cached = mixedCaseAttrs.get(el);
  if (cached !== undefined) return cached;

  let index: Map<string, AttrNode> | null = null;
  for (const attr of el.attributes) {
    const lower = asciiLowerCase(attr.name);
    if (lower === attr.name) continue;
    index ??= new Map();
    // First spelling wins, as in a browser, where the second of two attributes
    // that differ only in case is dropped at parse time. Only among the
    // mixed-case ones, though: an exact match is tried before this index, so a
    // later lowercase twin still beats an earlier `DATA-Foo`. Being exact about
    // that would mean indexing every attribute of every element on every
    // lookup, to settle markup that is invalid either way.
    if (!index.has(lower)) index.set(lower, attr);
  }

  mixedCaseAttrs.set(el, index);
  return index;
}

/**
 * Make attribute lookup ASCII case-insensitive for HTML elements. Idempotent,
 * and run on import of this module, so importing `parseHTML` from here is
 * enough.
 *
 * Patching `getAttributeNode` covers the whole read surface in one place:
 * `getAttribute`, `hasAttribute`, `getAttributeNS`, `classList`/`className`,
 * and — because linkedom's css-select adapter routes selector matching through
 * it — `querySelector("[inputmode]")` too.
 */
export function installHtmlAttributeCaseInsensitivity(): void {
  if (state.installed) return;
  state.installed = true;

  const proto = (ElementFacade as unknown as { prototype: Record<PropertyKey, unknown> })
    .prototype;

  const getAttributeNode = proto.getAttributeNode as (
    this: AttrElement,
    name: string,
  ) => AttrNode | null;

  proto.getAttributeNode = function (this: AttrElement, name: string): AttrNode | null {
    const exact = getAttributeNode.call(this, name);
    if (exact) return exact;
    if (!isHtmlElement(this)) return null;

    const lower = asciiLowerCase(name);
    // The caller spelled it in mixed case; the document spells it plainly.
    if (lower !== name) {
      const lowered = getAttributeNode.call(this, lower);
      if (lowered) return lowered;
    }
    // The document spells it in mixed case.
    return mixedCaseIndexOf(this)?.get(lower) ?? null;
  };

  const getAttributeNames = proto.getAttributeNames as (this: AttrElement) => string[];

  proto.getAttributeNames = function (this: AttrElement): string[] {
    const names = getAttributeNames.call(this);
    if (!isHtmlElement(this)) return names;
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      if (name !== undefined) names[i] = asciiLowerCase(name);
    }
    return names;
  };

  const setAttribute = proto.setAttribute as (
    this: AttrElement,
    name: string,
    value: string,
  ) => void;

  proto.setAttribute = function (this: AttrElement, name: string, value: string): void {
    try {
      // A browser lowercases the name here, which matters beyond tidiness:
      // linkedom keeps its cached class list in step only for the literal name
      // `class`, so `setAttribute("CLASS", …)` would otherwise write the value
      // and leave `className` and every class selector on the old one. An
      // existing mixed-case twin is still updated in place rather than
      // duplicated, because linkedom resolves it through getAttributeNode.
      setAttribute.call(this, isHtmlElement(this) ? asciiLowerCase(name) : name, value);
    } finally {
      mixedCaseAttrs.delete(this);
    }
  };

  // `setAttributeNS` does NOT lowercase in a browser, and linkedom implements
  // it by delegating to `setAttribute` — which would now lowercase for it.
  proto.setAttributeNS = function (
    this: AttrElement,
    _namespace: string | null,
    name: string,
    value: string,
  ): void {
    try {
      setAttribute.call(this, name, value);
    } finally {
      mixedCaseAttrs.delete(this);
      // Without the lowercasing above, a `CLASS` written here reaches the
      // `class` attribute through getAttributeNode but not the class list.
      if (isHtmlElement(this) && isMixedCaseClass(name)) resyncClassList(this);
    }
  };

  const removeAttribute = proto.removeAttribute as (this: AttrElement, name: string) => void;

  proto.removeAttribute = function (this: AttrElement, name: string): void {
    // linkedom compares names exactly here and does not route through
    // getAttributeNode, so resolve the stored spelling first: otherwise an
    // attribute `hasAttribute` reports would refuse to be removed.
    const stored = this.getAttributeNode(name);
    const target = stored ? stored.name : name;
    try {
      if (isHtmlElement(this) && isMixedCaseClass(target)) this.classList.clear();
      removeAttribute.call(this, target);
    } finally {
      mixedCaseAttrs.delete(this);
    }
  };

  // These two take an Attr node, so they can install a name `setAttribute`
  // would have lowercased. linkedom rebuilds its cached class list for the
  // literal name `class` only, which leaves the mixed-case spelling stale;
  // and both change the attribute SET the index above is built from.
  //
  // Invalidate AFTER the call, never before: linkedom's own `setAttribute`
  // asks `getAttributeNode` whether the attribute already exists, which would
  // rebuild and re-cache the index from the pre-insert state and leave the new
  // attribute permanently invisible. Nothing in the audit engine mutates a
  // parsed document, but a cache that silently goes stale if something ever
  // does is a trap.
  for (const method of ["setAttributeNode", "removeAttributeNode"] as const) {
    const original = proto[method] as (this: AttrElement, attr: AttrNode) => unknown;
    proto[method] = function (this: AttrElement, attr: AttrNode): unknown {
      try {
        return original.call(this, attr);
      } finally {
        mixedCaseAttrs.delete(this);
        if (isHtmlElement(this) && isMixedCaseClass(attr.name)) resyncClassList(this);
      }
    };
  }
}

installHtmlAttributeCaseInsensitivity();
