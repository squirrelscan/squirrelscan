// Serialising part of a page without serialising all of it (squirrelscan/repo#1864).
//
// On a script-heavy page most of the serialised HTML is inline script: about
// 800 KB of a 1.1 MB storefront page. `body.innerHTML` read all of it to look at
// the first two kilobytes, and `doc.toString()` handed every script's text to a
// rule that had just scanned each script on its own. These build the same
// characters child by child, and can stop early or leave a script's text out.

const ELEMENT_NODE = 1;

export interface SerializeOptions {
  /** Stop once at least this many characters are built (the result may run past it). */
  need?: number;
  /**
   * Text to serialise in place of an element's own text (a script's), by element. Only elements that serialise
   * themselves (script, style, title, textarea) are looked up; they are replaced in page order.
   */
  replaceText?: ReadonlyMap<Element, string>;
}

/**
 * The serialisation of `parent`'s children, joined: `el.innerHTML` for an
 * element and `doc.toString()` for a document, character for character, unless
 * `need` stops it early or `replaceText` swaps an element's text.
 *
 * The DOM's (linkedom's) serialisation of an element is its open tag, its
 * children's serialisations in order, and its close tag, and `innerHTML` and a
 * document's `toString()` are the children's serialisations joined. So a child
 * that holds more children is descended into: its open tag (read from a
 * childless copy of it), then its own children, then its close tag. Any other
 * child, an element with a serialisation of its own (script, style, title,
 * textarea), a text node, a comment or a doctype, is serialised whole.
 * tests/serialized-prefix.test.ts holds this to `innerHTML` and `toString()`
 * over the rule fixtures.
 */
export function serializeChildren(parent: Node, options: SerializeOptions = {}): string {
  const need = options.need ?? Number.POSITIVE_INFINITY;
  const replaceText = options.replaceText;
  // Without a length to stop at, only the elements holding a replaced one need
  // to be taken apart: everything else serialises whole, as fast as it can.
  const holders = new Set<Node>();
  if (replaceText) {
    for (const el of replaceText.keys()) {
      for (let up = el.parentNode; up && up !== parent && !holders.has(up); up = up.parentNode) holders.add(up);
    }
  }
  const bounded = need !== Number.POSITIVE_INFINITY;
  const out: string[] = [];
  let length = 0;
  const push = (s: string): void => {
    out.push(s);
    length += s.length;
  };
  let generic: unknown;
  const visit = (node: Node): boolean => {
    for (const child of Array.from(node.childNodes)) {
      if (length >= need) return true;
      if (child.nodeType === ELEMENT_NODE) {
        const element = child as Element;
        // The serialisation every ordinary element inherits; the elements that
        // carry raw text (TextElement in linkedom) override it.
        generic ??= genericToString(element);
        if (protoToString(element) === generic) {
          if (element.firstChild && (bounded || holders.has(element))) {
            const open = openTag(element);
            if (open !== null) {
              push(open);
              if (visit(element)) return true;
              push(`</${element.localName}>`);
              continue;
            }
          }
        } else if (replaceText) {
          const text = replaceText.get(element);
          if (text !== undefined) {
            // Exactly how the element serialises itself: its childless copy
            // with the text put in at the first `><`.
            push(String(element.cloneNode(false)).replace("><", () => `>${text}<`));
            continue;
          }
        }
      }
      push(String(child));
    }
    return length >= need;
  };
  visit(parent);
  return out.join("");
}

/**
 * At least the first `need` characters of `el.innerHTML` (all of it when it is
 * shorter), identical to `el.innerHTML.slice(0, need)` once sliced to `need`.
 */
export function serializedPrefix(el: Element, need: number): string {
  return serializeChildren(el, { need });
}

/**
 * The `toString` an element with no serialisation of its own inherits: the root
 * element's, which never overrides it (only the raw-text elements do).
 */
function genericToString(el: Element): unknown {
  return protoToString(el.ownerDocument?.documentElement ?? el);
}

/** The element's class's `toString`, whatever may be set on the element itself. */
function protoToString(el: Element): unknown {
  return (Object.getPrototypeOf(el) as { toString: unknown }).toString;
}

/** `<name attrs>` as the element's own serialisation opens it, or null when it cannot be read off a childless copy. */
function openTag(el: Element): string | null {
  const shallow = String(el.cloneNode(false));
  const close = `></${el.localName}>`;
  if (shallow.endsWith(close)) return `${shallow.slice(0, -close.length)}>`;
  // A childless SVG element serialises self-closed; with children it opens like any other.
  if (shallow.endsWith(" />")) return `${shallow.slice(0, -3)}>`;
  return null;
}
