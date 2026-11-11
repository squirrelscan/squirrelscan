// Shared reading of machine-readable entities (JSON-LD, Microdata, RDFa) and of
// how completely the HTML was read, for the schema rules that report per-field
// evidence (schema/product, schema/organization). Everything here works on the
// raw HTML already in the rule context: nothing is fetched or rendered.
//
// Microdata and RDFa are normalised into the same plain-object shape JSON-LD
// has (`@type` array, one key per property, nested objects for nested items),
// so one evaluator reads all three representations the same way.

import { indexJsonLdIds, resolveJsonLdRef } from "@squirrelscan/utils";

import type { RuleContext } from "../types";

export type StructuredNode = Record<string, unknown>;

/** Where a field was read from. */
export type EvidenceSource = "json-ld" | "microdata" | "rdfa";

/** Why a field could not be checked. */
export type UnknownReason =
  | "incomplete-read"
  | "rendered-only"
  | "unsupported"
  | "unresolved-reference"
  | "no-organization";

/** How much of the page the rule could read. */
export type ReadState = "complete" | "truncated" | "failed";

const MAX_DEPTH = 40;
const MAX_VISITED = 5000;
const MAX_MARKUP_SCOPES = 2000;
const MAX_PROPS_PER_SCOPE = 200;
const MAX_TEXT = 300;
const TAIL_CHARS = 4096;

/**
 * Whether the HTML was read completely. A read that failed (no document, an
 * error status) or was cut short (no closing `</html>` in the tail, or an
 * unterminated `<script>`) cannot prove that a field is absent, so callers
 * report unchecked fields as unknown. A page that merely omits `</html>` is
 * also read as truncated: the cost is an `unknown` where `absent` might have
 * been said, never a false "missing".
 */
export function htmlReadState(ctx: RuleContext): ReadState {
  const { page, parsed } = ctx;
  if (!parsed.document) return "failed";
  if (page.statusCode >= 400 || page.statusCode === 0) return "failed";
  const html = page.html;
  // A pre-parsed page with no raw HTML kept: nothing to judge by.
  if (!html) return "complete";
  if (page.rendered) return "complete";
  const tail = html.length > TAIL_CHARS ? html.slice(-TAIL_CHARS) : html;
  if (!/<\/html\s*>/i.test(tail)) return "truncated";
  const lower = tail.toLowerCase();
  if (lower.lastIndexOf("<script") > lower.lastIndexOf("</script")) return "truncated";
  return "complete";
}

/** The last segment of a type or property name: `https://schema.org/Product` and `schema:Product` give `Product`. */
export function localName(name: string): string {
  const trimmed = name.trim();
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("#"), trimmed.lastIndexOf(":"));
  return cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
}

export function typesOf(node: StructuredNode): string[] {
  const raw = node["@type"];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter((t): t is string => typeof t === "string" && t !== "").map(localName);
}

export function hasType(node: StructuredNode, ...names: string[]): boolean {
  const own = typesOf(node);
  return names.some((n) => own.includes(n));
}

export function asList(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Every object reachable from `roots`, nested ones included, each once. JSON-LD
 * nests entities (an Offer's `seller`, a Product's `brand`) that
 * `flattenJsonLdNodes` leaves inside their parent.
 */
export function collectNestedNodes(roots: readonly StructuredNode[]): StructuredNode[] {
  const seen = new Set<object>();
  const out: StructuredNode[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || seen.size >= MAX_VISITED) return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const node = value as StructuredNode;
    out.push(node);
    for (const [key, child] of Object.entries(node)) {
      if (key === "@context" || key === "@id" || key === "@type") continue;
      if (child && typeof child === "object") visit(child, depth + 1);
    }
  };
  for (const root of roots) visit(root, 0);
  return out;
}

/** Resolver for `{"@id": ...}` references against every node on the page. */
export function makeRefResolver(
  nodes: readonly StructuredNode[],
  baseUrl: string,
): (value: unknown) => unknown {
  const ids = indexJsonLdIds(nodes, baseUrl);
  return (value) => resolveJsonLdRef(value, ids, baseUrl);
}

/** True for a bare `{"@id": ...}` reference that did not resolve to a node. */
export function isDanglingRef(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const node = value as StructuredNode;
  return typeof node["@id"] === "string" && Object.keys(node).every((k) => k === "@id" || k === "@type");
}

// ── Microdata and RDFa ──────────────────────────────────────────────────────

export interface MarkupRead {
  nodes: StructuredNode[];
  /** An `itemref` was seen: properties may live outside the item, which this reader does not follow. */
  unsupported: boolean;
}

interface ScopeSpec {
  scopeSelector: string;
  scopeAttr: string;
  propsOf: (el: Element) => string[];
  typesOf: (el: Element) => string[];
  valueOf: (el: Element) => string;
  unsupported?: (el: Element) => boolean;
}

const text = (el: Element): string => (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
const attr = (el: Element, name: string): string => (el.getAttribute(name) ?? "").trim();
const tokens = (value: string | null): string[] => (value ?? "").split(/\s+/).filter(Boolean);

function readScopes(doc: Document, spec: ScopeSpec): MarkupRead {
  let budget = MAX_MARKUP_SCOPES;
  let unsupported = false;

  const build = (scope: Element, depth: number): StructuredNode => {
    budget--;
    const node: StructuredNode = { "@type": spec.typesOf(scope) };
    if (spec.unsupported?.(scope)) unsupported = true;
    let props = 0;
    const add = (name: string, value: unknown): void => {
      if (props >= MAX_PROPS_PER_SCOPE) return;
      props++;
      const prior = node[name];
      node[name] = prior === undefined ? value : [...asList(prior), value];
    };
    const walk = (parent: Element, d: number): void => {
      if (d > MAX_DEPTH) return;
      for (const child of Array.from(parent.children)) {
        const names = spec.propsOf(child);
        const isScope = child.hasAttribute(spec.scopeAttr);
        if (names.length > 0) {
          if (isScope) {
            if (budget <= 0) continue;
            const nested = build(child, d + 1);
            for (const name of names) add(name, nested);
            continue;
          }
          const value = spec.valueOf(child);
          for (const name of names) add(name, value);
          walk(child, d + 1);
        } else if (isScope) {
          // A separate top-level item: read on its own, not as part of this one.
          continue;
        } else {
          walk(child, d + 1);
        }
      }
    };
    if (depth <= MAX_DEPTH) walk(scope, depth);
    return node;
  };

  const nodes: StructuredNode[] = [];
  for (const el of Array.from(doc.querySelectorAll(spec.scopeSelector))) {
    if (budget <= 0) break;
    if (spec.propsOf(el).length > 0) continue; // nested item, read through its parent
    nodes.push(build(el, 0));
  }
  return { nodes, unsupported };
}

function microdataValue(el: Element): string {
  switch (el.tagName.toLowerCase()) {
    case "meta":
      return attr(el, "content");
    case "img":
    case "audio":
    case "video":
    case "source":
    case "embed":
    case "iframe":
    case "track":
      return attr(el, "src");
    case "a":
    case "area":
    case "link":
      return attr(el, "href");
    case "object":
      return attr(el, "data");
    case "data":
    case "meter":
      return attr(el, "value");
    case "time":
      return attr(el, "datetime") || text(el);
    default:
      return text(el);
  }
}

export function readMicrodata(doc: Document): MarkupRead {
  return readScopes(doc, {
    scopeSelector: "[itemscope]",
    scopeAttr: "itemscope",
    propsOf: (el) => tokens(el.getAttribute("itemprop")).map(localName),
    typesOf: (el) =>
      tokens(el.getAttribute("itemtype"))
        .filter((t) => /schema\.org/i.test(t))
        .map(localName),
    valueOf: microdataValue,
    unsupported: (el) => el.hasAttribute("itemref"),
  });
}

function rdfaValue(el: Element): string {
  const content = attr(el, "content");
  if (content) return content;
  const tag = el.tagName.toLowerCase();
  if (tag === "img" || tag === "source" || tag === "audio" || tag === "video") {
    const src = attr(el, "src");
    if (src) return src;
  }
  return attr(el, "resource") || attr(el, "href") || text(el);
}

export function readRdfa(doc: Document): MarkupRead {
  return readScopes(doc, {
    scopeSelector: "[typeof]",
    scopeAttr: "typeof",
    propsOf: (el) => tokens(el.getAttribute("property")).map(localName),
    typesOf: (el) => {
      const inVocab = !!el.closest('[vocab*="schema.org" i]');
      return tokens(el.getAttribute("typeof"))
        .filter((t) => /schema\.org|^schema:/i.test(t) || (inVocab && !/[:/]/.test(t)))
        .map(localName);
    },
    valueOf: rdfaValue,
  });
}

/** Whether a value counts as declared: a non-blank string, a finite number, or a non-empty list or node. */
export function isFilled(value: unknown): boolean {
  if (typeof value === "string") return value.trim() !== "";
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.some(isFilled);
  if (value && typeof value === "object") {
    const node = value as StructuredNode;
    return Object.entries(node).some(([k, v]) => !k.startsWith("@") && isFilled(v)) || typeof node["@id"] === "string";
  }
  return false;
}

const MAX_VISIBLE_CHARS = 200_000;

/** The text a visitor sees (scripts, styles, templates and noscript removed), bounded. */
export function visibleText(doc: Document): string {
  const body = doc.body;
  if (!body) return "";
  const clone = body.cloneNode(true) as Element;
  for (const el of Array.from(clone.querySelectorAll("script, style, noscript, template"))) el.remove();
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_VISIBLE_CHARS);
}
