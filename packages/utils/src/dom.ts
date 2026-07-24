// Case-insensitive DOM attribute helpers
//
// HTML attribute names are case-insensitive per spec, but React SSR outputs
// camelCase (e.g. charSet, tabIndex, httpEquiv). linkedom preserves original
// case, so querySelector("[tabindex]") misses React's "tabIndex".
// These helpers normalise attribute access across all frameworks.

/**
 * Case-insensitive getAttribute. Returns the value of the first attribute
 * whose name matches (ignoring case), or null.
 */
export function getAttrCI(el: Element, name: string): string | null {
  const lower = name.toLowerCase();
  for (const attr of el.attributes) {
    if (attr.name.toLowerCase() === lower) return attr.value;
  }
  return null;
}

/**
 * Check whether an element has an attribute (case-insensitive name match).
 */
export function hasAttrCI(el: Element, name: string): boolean {
  const lower = name.toLowerCase();
  for (const attr of el.attributes) {
    if (attr.name.toLowerCase() === lower) return true;
  }
  return false;
}

/**
 * Find all elements matching `tag` that have `attr` (case-insensitive).
 * Returns matching elements. Pass "*" for tag to search all elements.
 */
export function querySelectorAllByAttrCI(
  root: Element | Document,
  tag: string,
  attr: string
): Element[] {
  const elements = root.querySelectorAll(tag);
  const results: Element[] = [];
  for (const el of elements) {
    if (hasAttrCI(el, attr)) results.push(el);
  }
  return results;
}

/**
 * Find first element matching `tag` that has `attr` with `value` (case-insensitive
 * attribute name, exact value match).
 */
export function querySelectorByAttrValueCI(
  root: Element | Document,
  tag: string,
  attr: string,
  value: string
): Element | null {
  const elements = root.querySelectorAll(tag);
  for (const el of elements) {
    if (getAttrCI(el, attr) === value) return el;
  }
  return null;
}
