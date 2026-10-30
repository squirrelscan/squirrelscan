// Framework data payloads inside a page's HTML (squirrelscan/squirrelscan#1143).
//
// A server-rendered page that hydrates carries its state twice: once as the
// markup the visitor reads, once as JSON or script the framework re-reads in the
// browser (`__NEXT_DATA__`, `window.__NUXT__`, Remix and Qwik state, Astro island
// props, the Next app router's `self.__next_f.push` flight chunks). On an
// interactive app that state is the cost of the interactivity. On a page that is
// only text, it is the page's content a second time.
//
// This module only measures: it names each payload and sizes it, with every read
// bounded (untrusted markup): the scripts and islands it looks at are capped, the
// prefix tests read a fixed number of characters, and nothing runs a pattern
// over a payload body. Sizes are JavaScript string lengths (UTF-16 code units),
// which is bytes to within a few percent on the ASCII-heavy JSON these hold.

import { querySelectorAllOutsideNoscript } from "@squirrelscan/utils";

import type { ParsedPage } from "../types";

type Doc = NonNullable<ParsedPage["document"]>;

/** Most inline `<script>` elements read per page. A page past it is read as far as it goes. */
const MAX_SCRIPTS = 2000;
/** Most `<astro-island>` elements read per page. */
const MAX_ISLANDS = 500;
/** Characters of a script's start the prefix tests read. */
const PREFIX_CHARS = 160;

export type FrameworkPayloadKind =
  | "next-pages"
  | "next-app"
  | "nuxt"
  | "remix"
  | "qwik"
  | "astro"
  | "sveltekit"
  | "global-state";

export interface FrameworkPayload {
  kind: FrameworkPayloadKind;
  /** What to call it in a message: `__NEXT_DATA__`, `self.__next_f`, ... */
  label: string;
  /** Combined size in characters of every element that makes it up. */
  bytes: number;
  /** How many elements (scripts or islands) that is. */
  count: number;
}

/** Window globals frameworks and state libraries assign their serialised state to. */
const STATE_GLOBALS: ReadonlyArray<{ kind: FrameworkPayloadKind; label: string; needle: string }> = [
  { kind: "nuxt", label: "window.__NUXT__", needle: "__NUXT__" },
  { kind: "remix", label: "window.__remixContext", needle: "__remixContext" },
  { kind: "remix", label: "window.__staticRouterHydrationData", needle: "__staticRouterHydrationData" },
  { kind: "sveltekit", label: "__sveltekit data", needle: "__sveltekit_" },
  { kind: "global-state", label: "window.__INITIAL_STATE__", needle: "__INITIAL_STATE__" },
  { kind: "global-state", label: "window.__PRELOADED_STATE__", needle: "__PRELOADED_STATE__" },
  { kind: "global-state", label: "window.__APOLLO_STATE__", needle: "__APOLLO_STATE__" },
];

/** `self.__next_f.push(` chunks the Next.js app router streams its server-component payload in. */
const NEXT_FLIGHT_NEEDLE = "__next_f";

interface Tally {
  label: string;
  bytes: number;
  count: number;
}

function add(map: Map<FrameworkPayloadKind, Tally>, kind: FrameworkPayloadKind, label: string, bytes: number) {
  const tally = map.get(kind);
  if (tally) {
    tally.bytes += bytes;
    tally.count += 1;
  } else {
    map.set(kind, { label, bytes, count: 1 });
  }
}

/**
 * Every framework data payload in the page, largest first. JSON-LD and other
 * data scripts that are not a framework's state are not counted.
 */
export function findFrameworkPayloads(doc: Doc): FrameworkPayload[] {
  const tallies = new Map<FrameworkPayloadKind, Tally>();

  let read = 0;
  for (const script of querySelectorAllOutsideNoscript(doc, "script:not([src])")) {
    if (++read > MAX_SCRIPTS) break;
    const text = script.textContent ?? "";
    if (text.length === 0) continue;
    const id = script.getAttribute("id") ?? "";
    const type = (script.getAttribute("type") ?? "").toLowerCase();

    if (id === "__NEXT_DATA__") {
      add(tallies, "next-pages", "__NEXT_DATA__", text.length);
      continue;
    }
    if (id === "__NUXT_DATA__") {
      add(tallies, "nuxt", "__NUXT_DATA__", text.length);
      continue;
    }
    if (type === "qwik/json" || type === "qwik/state") {
      add(tallies, "qwik", "qwik/json", text.length);
      continue;
    }
    if (type !== "" && type !== "text/javascript" && type !== "module" && type !== "application/javascript") {
      // JSON-LD, importmaps, speculation rules and the like are not framework state.
      continue;
    }
    const head = text.slice(0, PREFIX_CHARS);
    if (head.includes(NEXT_FLIGHT_NEEDLE)) {
      add(tallies, "next-app", "self.__next_f", text.length);
      continue;
    }
    for (const state of STATE_GLOBALS) {
      if (head.includes(state.needle)) {
        add(tallies, state.kind, state.label, text.length);
        break;
      }
    }
  }

  let islands = 0;
  for (const island of doc.querySelectorAll("astro-island")) {
    if (++islands > MAX_ISLANDS) break;
    const props = island.getAttribute("props") ?? "";
    if (props.length > 0) add(tallies, "astro", "astro-island props", props.length);
  }

  return [...tallies.entries()]
    .map(([kind, t]) => ({ kind, label: t.label, bytes: t.bytes, count: t.count }))
    .sort((a, b) => b.bytes - a.bytes);
}

/** What the page lets a visitor operate: the part of its state that is not just its text. */
export interface PageInteractivity {
  /** Form controls a visitor types into or picks from (hidden and submit-only inputs excluded). */
  fields: number;
  /** `<button>` elements and `role="button"` elements. */
  buttons: number;
  /** `<canvas>`, `<video>`, `<audio>`, `<iframe>`, `<embed>`, `<object>` and `<dialog>`. */
  embedded: number;
}

/** Most elements of each kind counted: past this the page is interactive however the count ends. */
const MAX_COUNTED = 200;

const count = (doc: Doc, selector: string): number =>
  Math.min(querySelectorAllOutsideNoscript(doc, selector).length, MAX_COUNTED);

export function measureInteractivity(doc: Doc): PageInteractivity {
  return {
    fields: count(
      doc,
      "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]), select, textarea, [contenteditable=true], [contenteditable='']",
    ),
    buttons: count(doc, "button, [role=button]"),
    embedded: count(doc, "canvas, video, audio, iframe, embed, object, dialog"),
  };
}

/**
 * The document's body, or its root when it has none, or null for an empty
 * document. linkedom's `doc.body` getter throws on a document with no root
 * element (empty or text-only HTML), so the read is guarded.
 */
export function documentBody(doc: Doc): Element | null {
  try {
    return doc.body ?? doc.documentElement ?? null;
  } catch {
    return null;
  }
}

/** The visible text of the page, in characters, without scripts, styles and templates. */
export function visibleTextLength(doc: Doc): number {
  const body = documentBody(doc);
  if (!body) return 0;
  let total = 0;
  // Text nodes only: no tag soup in the count, no regex over untrusted text.
  const stack: Node[] = [body];
  let visited = 0;
  while (stack.length > 0 && visited < 200_000) {
    const node = stack.pop()!;
    visited++;
    if (node.nodeType === 3) {
      const text = (node.textContent ?? "").trim();
      if (text.length > 0) total += text.length;
    } else if (node.nodeType === 1) {
      const tag = (node as Element).tagName.toLowerCase();
      if (tag === "script" || tag === "style" || tag === "template" || tag === "noscript") continue;
      for (const child of Array.from(node.childNodes)) stack.push(child);
    }
  }
  return total;
}
