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

import { parseHTML as linkedomParseHTML } from "linkedom";

/**
 * `parseHTML` that never hands back a document with no root (#1270).
 *
 * Markup with no element in it (an empty or whitespace body, a comment, plain
 * text, JSON served as text/html, a bare doctype) leaves linkedom with
 * `documentElement === null`, and its `document.head` / `document.body`
 * getters then throw. Every DOM rule touching either one reported a bogus
 * "Rule error". A browser builds `<html><head></head><body></body></html>` for
 * the same input, with any text in the body, so parse it that way.
 */
export function parseHTML(
  ...args: Parameters<typeof linkedomParseHTML>
): ReturnType<typeof linkedomParseHTML> {
  const parsed = linkedomParseHTML(...args);
  if (parsed.document.documentElement) {
    if (typeof args[0] === "string" && SHADOW_ROOT_HINT.test(args[0])) flattenDeclarativeShadowRoots(parsed.document as never);
    return parsed;
  }
  const [html, ...rest] = args;
  return linkedomParseHTML(`<html><head></head><body>${String(html)}</body></html>`, ...rest);
}

const SHADOW_ROOT_HINT = /shadowroot/i;
/** Documents whose ids were scoped per shadow root (see {@link scopeIdsToRoot}). */
const SHADOW_SCOPED_DOCUMENTS = new WeakSet<object>();
const SHADOW_ID_SUFFIX = /__sr\d+(?![\w-])/g;

/**
 * Findings must name an element as the page's source does. The suffix {@link scopeIdsToRoot}
 * adds to the ids inside a shadow root is internal, so strip it from the strings of a rule's
 * checks (message, items, details) before they leave the rule runner. A no-op on a document
 * with no shadow roots, and in place: the checks are the rule's own, fresh from `run()`.
 */
export function stripShadowIdScopes(checks: unknown[], document: unknown): void {
  if (!document || !SHADOW_SCOPED_DOCUMENTS.has(document as object)) return;
  const scrub = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") return value.includes("__sr") ? value.replace(SHADOW_ID_SUFFIX, "") : value;
    if (depth > 6 || value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) value[i] = scrub(value[i], depth + 1);
      return value;
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) record[key] = scrub(record[key], depth + 1);
    return record;
  };
  for (const check of checks) scrub(check, 0);
}
/** Elements a browser lets host a shadow root, besides any custom element (a name with a hyphen). */
const SHADOW_HOSTS = new Set(["article", "aside", "blockquote", "body", "div", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "main", "nav", "p", "section", "span"]);
const MAX_SHADOW_TEMPLATES = 5000;
const MAX_SHADOW_DEPTH = 16;
/** Light DOM children that render nothing, so they never replace a slot's fallback. */
const UNRENDERED_LIGHT_TAGS = new Set(["style", "script", "template", "link", "meta", "noscript", "title", "base"]);

interface NodeLike {
  nodeType?: number;
  textContent?: string | null;
  childNodes?: ArrayLike<unknown>;
  getAttribute?(name: string): string | null;
  setAttribute?(name: string, value: string): void;
  querySelectorAll?(selector: string): ArrayLike<unknown>;
  remove?(): void;
}

interface TemplateLike {
  parentNode: { insertBefore(node: unknown, ref: unknown): unknown; removeChild(node: unknown): unknown; localName?: string; childNodes: ArrayLike<unknown> } | null;
  getAttribute(name: string): string | null;
  content?: { childNodes: ArrayLike<unknown>; querySelectorAll(selector: string): ArrayLike<unknown> };
}

/** Attributes whose value is one or more ids of the SAME tree (a shadow root is its own scope for them). */
const ID_REFERENCE_ATTRIBUTES = ["for", "aria-labelledby", "aria-describedby", "aria-controls", "aria-owns", "aria-details", "aria-activedescendant", "aria-errormessage", "aria-flowto", "headers", "list", "form"];

/**
 * Ids are scoped per shadow root: the same `id="q"` in three components is not a duplicate, and a
 * `<label for="q">` in one root does not point at the input of another. Inlining merges the scopes,
 * so the ids of one root's content (and the references to them from inside that root) get a
 * per-root suffix, `q__sr2`, keeping every root its own namespace for the id rules.
 */
function scopeIdsToRoot(content: NonNullable<TemplateLike["content"]>, root: number, document: object): void {
  const withIds = Array.from(content.querySelectorAll("[id]")) as NodeLike[];
  if (withIds.length === 0) return;
  SHADOW_SCOPED_DOCUMENTS.add(document);
  const ids = new Set<string>();
  for (const el of withIds) {
    const id = el.getAttribute?.("id");
    if (id) ids.add(id);
  }
  const suffix = `__sr${root}`;
  for (const el of withIds) {
    const id = el.getAttribute?.("id");
    if (id) el.setAttribute?.("id", `${id}${suffix}`);
  }
  const selector = ID_REFERENCE_ATTRIBUTES.map((a) => `[${a}]`).join(",");
  for (const el of Array.from(content.querySelectorAll(selector)) as NodeLike[]) {
    for (const attribute of ID_REFERENCE_ATTRIBUTES) {
      const value = el.getAttribute?.(attribute);
      if (!value) continue;
      const scoped = value.split(/\s+/).map((token) => (ids.has(token) ? `${token}${suffix}` : token)).join(" ");
      if (scoped !== value) el.setAttribute?.(attribute, scoped);
    }
  }
}

/**
 * A `<slot>` shows the host's light DOM children assigned to it instead of its own fallback
 * content: a default slot takes the host's children that have no `slot` attribute (and text), a
 * named one those with a matching `slot`. Where the host supplies content, the fallback is dropped
 * so it is not checked as if it rendered.
 */
function dropReplacedSlotFallback(content: NonNullable<TemplateLike["content"]>, host: NonNullable<TemplateLike["parentNode"]>, template: unknown): void {
  const slots = Array.from(content.querySelectorAll("slot")) as NodeLike[];
  if (slots.length === 0) return;
  const light = (Array.from(host.childNodes) as NodeLike[]).filter((n) => (n as unknown) !== template);
  const supplied = new Set<string>();
  for (const node of light) {
    if (node.nodeType === 1) {
      // Elements a browser never renders cannot be slotted content.
      if (UNRENDERED_LIGHT_TAGS.has(((node as { localName?: string }).localName ?? "").toLowerCase())) continue;
      supplied.add(node.getAttribute?.("slot") ?? "");
    } else if (node.nodeType === 3 && (node.textContent ?? "").trim() !== "") supplied.add("");
  }
  for (const slot of slots) {
    if (!supplied.has(slot.getAttribute?.("name") ?? "")) continue;
    for (const child of Array.from(slot.childNodes ?? []) as NodeLike[]) child.remove?.();
  }
}

/**
 * Declarative shadow DOM (#922): a browser attaches `<template shadowrootmode>`'s
 * content as the host's shadow root and renders it, but linkedom keeps it inside
 * the template's inert `content` fragment, so no `querySelectorAll` reaches the
 * controls, links, images and headings in it. Inline the content into the host in
 * place of the template: the rules then see what a visitor sees. Light DOM children
 * stay where they are. Like a browser, only the first such template of a host
 * counts, a host that cannot have a shadow root keeps it inert, and a plain
 * `<template>` is never touched. Ids stay scoped to their root, and a slot's
 * fallback content is dropped where the host supplies content for it. Bounded: at
 * most {@link MAX_SHADOW_TEMPLATES} roots are inlined, nested up to
 * {@link MAX_SHADOW_DEPTH} levels; templates that are skipped cost nothing against it.
 */
function flattenDeclarativeShadowRoots(document: { querySelectorAll(selector: string): ArrayLike<unknown> } & object): void {
  const hosted = new WeakSet<object>();
  let budget = MAX_SHADOW_TEMPLATES;
  let rootNumber = 0;
  // Nested templates appear as the outer ones are inlined: repeat until none is left (bounded).
  for (let round = 0; round < MAX_SHADOW_DEPTH && budget > 0; round++) {
    const templates = Array.from(document.querySelectorAll("template[shadowrootmode]")) as TemplateLike[];
    let changed = false;
    for (const template of templates) {
      if (budget <= 0) return;
      const host = template.parentNode;
      const mode = template.getAttribute("shadowrootmode")?.toLowerCase();
      if (!host || !template.content || (mode !== "open" && mode !== "closed")) continue;
      const name = host.localName ?? "";
      if (!SHADOW_HOSTS.has(name) && !name.includes("-")) continue;
      if (hosted.has(host)) continue;
      hosted.add(host);
      budget--;
      dropReplacedSlotFallback(template.content, host, template);
      scopeIdsToRoot(template.content, ++rootNumber, document);
      for (const child of Array.from(template.content.childNodes)) host.insertBefore(child, template);
      host.removeChild(template);
      changed = true;
    }
    if (!changed) return;
  }
}

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
