// Types a page declares beyond the parser's top-level JSON-LD list.
//
// `ctx.parsed.schemas.types` holds the `@type` of each top-level and `@graph` node
// and nothing else. A rule that says "this page declares no Product" must not say
// it about a page that declares one nested in another node (`WebPage.mainEntity`),
// or in microdata (`itemtype`) or RDFa (`typeof`) markup, so the rules that make a
// "declares none" claim read these too.
//
// Every scan is bounded, because the input is a hostile page. A scan that hit a
// bound reports `complete: false`, and a caller must read that as "could not look",
// never as "nothing there": a truncated list is not proof of absence.

import { getAttrCI } from "@squirrelscan/utils";

/** Elements visited by the microdata and RDFa walk. */
export const MAX_VISITED_NODES = 50_000;
/** Elements carrying an `itemtype` or `typeof` attribute that are read. */
export const MAX_ANNOTATED_ELEMENTS = 5_000;
/** Space-separated tokens read from one `itemtype` or `typeof` attribute. */
export const MAX_TOKENS_PER_ATTRIBUTE = 64;
/** Nesting depth of a JSON-LD node that is read. */
export const MAX_JSONLD_DEPTH = 8;
/** Objects and arrays visited in the JSON-LD of a page (primitives are free). */
export const MAX_JSONLD_VALUES = 2_000;

/** The info check message when a scan hit a bound: the page's markup was not read in full, so no schema is claimed missing. */
export const UNREADABLE_MESSAGE = "Page markup too large to judge structured data";

export interface TypeScan {
  /** Bare type names, in the spelling the page used. May hold duplicates. */
  types: string[];
  /** False when a bound was hit (or nothing could be read): `types` may be missing some. */
  complete: boolean;
}

/** `https://schema.org/Product`, `schema:Product` and `Product` all read as `Product`. */
export function bareTypeName(raw: string): string {
  const parts = raw.trim().split(/[/#:]/);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i]) return parts[i]!;
  }
  return "";
}

/** The bare names in a JSON-LD `@type` value: a string, or an array that may hold other things. */
export function typeNames(value: unknown): string[] {
  const names: string[] = [];
  const add = (raw: unknown): void => {
    if (typeof raw !== "string") return;
    const bare = bareTypeName(raw);
    if (bare) names.push(bare);
  };
  if (Array.isArray(value)) {
    for (const item of value.slice(0, MAX_TOKENS_PER_ATTRIBUTE)) add(item);
  } else {
    add(value);
  }
  return names;
}

/**
 * Every `@type` in the given JSON-LD nodes, nested ones included: depth at most
 * {@link MAX_JSONLD_DEPTH}, at most {@link MAX_JSONLD_VALUES} objects and arrays.
 * Iterative, so a deeply nested document cannot overflow the stack.
 */
export function jsonLdTypes(nodes: readonly unknown[]): TypeScan {
  const types: string[] = [];
  let complete = true;
  let visited = 0;
  const stack: Array<{ value: unknown; depth: number }> = [];
  for (let i = nodes.length - 1; i >= 0; i--) stack.push({ value: nodes[i], depth: 0 });

  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (value === null || typeof value !== "object") continue;
    if (++visited > MAX_JSONLD_VALUES || depth > MAX_JSONLD_DEPTH) {
      complete = false;
      if (visited > MAX_JSONLD_VALUES) break;
      continue;
    }
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) stack.push({ value: value[i], depth });
      continue;
    }
    const record = value as Record<string, unknown>;
    types.push(...typeNames(record["@type"]));
    for (const key of Object.keys(record)) {
      // `@context` holds term definitions, whose `@type` is a coercion (`@id`), not a type.
      if (key === "@type" || key === "@context") continue;
      stack.push({ value: record[key], depth: depth + 1 });
    }
  }
  return { types, complete };
}

/**
 * The bare type names from every `itemtype` and `typeof` attribute. Both hold a
 * space-separated list. The walk is incremental (an explicit stack, no
 * `querySelectorAll` that would materialise every match first) with a visited-node
 * budget, an annotated-element budget and a per-attribute token cap. A page with no
 * document cannot be read at all, which is `complete: false`.
 */
export function microdataAndRdfaTypes(doc: Document | null | undefined): TypeScan {
  const root = doc?.documentElement;
  if (!root) return { types: [], complete: false };

  const types: string[] = [];
  let complete = true;
  let visited = 0;
  let annotated = 0;
  const stack: Element[] = [root];

  walk: while (stack.length > 0) {
    const el = stack.pop()!;
    if (++visited > MAX_VISITED_NODES) {
      complete = false;
      break;
    }
    let isAnnotated = false;
    for (const attr of ["itemtype", "typeof"] as const) {
      const value = getAttrCI(el, attr);
      if (!value) continue;
      if (!isAnnotated) {
        isAnnotated = true;
        if (++annotated > MAX_ANNOTATED_ELEMENTS) {
          complete = false;
          break walk;
        }
      }
      // A limit one past the cap tells "exactly at the cap" from "over it".
      const tokens = value.trim().split(/\s+/, MAX_TOKENS_PER_ATTRIBUTE + 1);
      if (tokens.length > MAX_TOKENS_PER_ATTRIBUTE) complete = false;
      for (const token of tokens.slice(0, MAX_TOKENS_PER_ATTRIBUTE)) {
        const bare = bareTypeName(token);
        if (bare) types.push(bare);
      }
    }
    const children = el.children;
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
  }
  return { types, complete };
}
