// The place of an element in the page, as a selector path (#1440).
//
// A rule that reports a DOM element puts `elementSelector(el)` on the item as `CheckItem.selector` when
// `ctx.wantsItemSelectors` is set (an `[[ignore]]` entry with `selectors` names the rule), so an entry can waive that
// element and no other. The path is the element's ancestry from the document root, `html > body > form#localization-form >
// select#country.picker`: tag, then `#id` and `.class` tokens made only of letters, digits, `_` and `-` (anything else is
// left out, so the text is always parseable). It is bounded in every dimension, because the markup is the page's: the
// nearest ANCESTOR_LIMIT ancestors, only the first MAX_CLASS_SCAN characters of a class attribute are read (a
// 400 KB class attribute costs a slice, not a split), at most MAX_CLASSES classes of MAX_TOKEN_CHARS characters, and
// MAX_PATH_CHARS characters of path in all (the nearest ancestors that fit). The engine strips it from the item before
// the report, so no output carries it.

/** Ancestors kept, counting the element itself: the nearest ones decide what an ignore can say. */
export const ANCESTOR_LIMIT = 16;
/** Characters of the whole path. */
export const MAX_PATH_CHARS = 1_000;
const MAX_CLASSES = 6;
const MAX_TOKEN_CHARS = 40;
/** Characters of a class attribute that are read at all. */
const MAX_CLASS_SCAN = 1_024;
const TOKEN_CHARS = /^[A-Za-z0-9_-]+$/;

/** Segments by element: a shared ancestor (the form, the wrapper) is read once however many controls sit under it. */
const segments = new WeakMap<Element, string>();

function segment(el: Element): string {
  const known = segments.get(el);
  if (known !== undefined) return known;
  let out = el.tagName.toLowerCase().slice(0, MAX_TOKEN_CHARS);
  const id = el.getAttribute("id");
  if (id && id.length <= MAX_TOKEN_CHARS && TOKEN_CHARS.test(id)) out += `#${id}`;
  const classes = el.getAttribute("class");
  if (classes) {
    let kept = 0;
    for (const token of classes.slice(0, MAX_CLASS_SCAN).split(/\s+/)) {
      if (kept >= MAX_CLASSES) break;
      if (token && token.length <= MAX_TOKEN_CHARS && TOKEN_CHARS.test(token)) {
        out += `.${token}`;
        kept++;
      }
    }
  }
  segments.set(el, out);
  return out;
}

/** `html > body > form#f > select#s.c`: the element's ancestry (nearest {@link ANCESTOR_LIMIT}, at most {@link MAX_PATH_CHARS} characters), root first. */
export function elementSelector(el: Element): string {
  const parts: string[] = [];
  let length = 0;
  let node: Element | null = el;
  while (node && parts.length < ANCESTOR_LIMIT) {
    const part = segment(node);
    // The element itself is always kept; an ancestor that would pass the cap ends the path there.
    if (parts.length > 0 && length + part.length + 3 > MAX_PATH_CHARS) break;
    parts.push(part);
    length += part.length + 3;
    node = node.parentElement;
  }
  return parts.reverse().join(" > ");
}
