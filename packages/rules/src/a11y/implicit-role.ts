// Implicit ARIA roles of native HTML elements, per HTML-AAM and ARIA in HTML.
//
// A native element carries a role without any `role` attribute: an
// `<input type="radio">` IS a radio to assistive technology, an `<li>` a
// listitem, a `<tr>` a row. A rule that only matches `[role="radio"]` reports
// markup that is correct (#435).

import { globalAriaAttributes, validAriaRoles } from "./aria-data";

/** The parts of an element the role mapping reads. */
interface RoleElement {
  localName: string;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  parentElement: RoleElement | null;
}

// Maps, not object literals: a tag or type spelled `constructor` must miss.
const BY_TAG = new Map<string, string>([
  ["address", "group"],
  ["article", "article"],
  ["aside", "complementary"],
  ["blockquote", "blockquote"],
  ["button", "button"],
  ["caption", "caption"],
  ["code", "code"],
  ["datalist", "listbox"],
  ["dd", "definition"],
  ["del", "deletion"],
  ["details", "group"],
  ["dfn", "term"],
  ["dialog", "dialog"],
  ["dt", "term"],
  ["em", "emphasis"],
  ["fieldset", "group"],
  ["figure", "figure"],
  ["form", "form"],
  ["h1", "heading"],
  ["h2", "heading"],
  ["h3", "heading"],
  ["h4", "heading"],
  ["h5", "heading"],
  ["h6", "heading"],
  ["hgroup", "group"],
  ["hr", "separator"],
  ["ins", "insertion"],
  // ARIA in HTML scopes `li` to a list parent; browsers expose it as a
  // listitem wherever it sits, and so does this.
  ["li", "listitem"],
  ["main", "main"],
  ["math", "math"],
  ["menu", "list"],
  ["meter", "meter"],
  ["nav", "navigation"],
  ["ol", "list"],
  ["optgroup", "group"],
  ["option", "option"],
  ["output", "status"],
  ["p", "paragraph"],
  ["progress", "progressbar"],
  ["search", "search"],
  ["strong", "strong"],
  ["sub", "subscript"],
  ["sup", "superscript"],
  ["table", "table"],
  ["tbody", "rowgroup"],
  ["textarea", "textbox"],
  ["tfoot", "rowgroup"],
  ["thead", "rowgroup"],
  ["time", "time"],
  ["tr", "row"],
  ["ul", "list"],
]);

const INPUT_BY_TYPE = new Map<string, string>([
  ["button", "button"],
  ["checkbox", "checkbox"],
  ["image", "button"],
  ["number", "spinbutton"],
  ["radio", "radio"],
  ["range", "slider"],
  ["reset", "button"],
  ["submit", "button"],
]);

// Input states with no corresponding role. Any type not listed here or above
// (missing, `text`, `email`, `tel`, `url`, or a value the browser does not
// know) is the text state.
const INPUT_TYPES_WITHOUT_ROLE = new Set([
  "color",
  "date",
  "datetime-local",
  "file",
  "hidden",
  "month",
  "password",
  "time",
  "week",
]);

/** Ancestors that take `header`/`footer` out of banner/contentinfo. */
const SECTIONING = new Set(["article", "aside", "main", "nav", "section"]);

function hasSectioningAncestor(el: RoleElement): boolean {
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (SECTIONING.has(node.localName)) return true;
  }
  return false;
}

function inputRole(el: RoleElement): string | null {
  // ASCII case-insensitive and NOT trimmed: `type=" radio "` is an invalid
  // value, which is the text state.
  const type = (el.getAttribute("type") ?? "").toLowerCase();
  const mapped = INPUT_BY_TYPE.get(type);
  if (mapped) return mapped;
  if (INPUT_TYPES_WITHOUT_ROLE.has(type)) return null;
  // Text-like inputs become a combobox when they carry a suggestion list.
  const hasList = el.hasAttribute("list");
  if (type === "search") return hasList ? "combobox" : "searchbox";
  return hasList ? "combobox" : "textbox";
}

/** Whether the nearest ancestor table is an ARIA grid or treegrid. */
function inGridTable(el: RoleElement): boolean {
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (node.localName !== "table") continue;
    const role = explicitRole(node);
    return role === "grid" || role === "treegrid";
  }
  return false;
}

/**
 * The role a native element exposes with no `role` attribute, or null for
 * elements with no corresponding role (`div`, `span`, `a` without `href`, ...).
 */
export function implicitRole(el: RoleElement): string | null {
  switch (el.localName) {
    case "a":
    case "area":
      return el.hasAttribute("href") ? "link" : null;
    case "footer":
      return hasSectioningAncestor(el) ? null : "contentinfo";
    case "header":
      return hasSectioningAncestor(el) ? null : "banner";
    case "img":
      return el.getAttribute("alt") === "" ? "presentation" : "img";
    case "input":
      return inputRole(el);
    case "section":
      return el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby")
        ? "region"
        : null;
    case "select": {
      const size = Number.parseInt(el.getAttribute("size") ?? "", 10);
      return el.hasAttribute("multiple") || size > 1 ? "listbox" : "combobox";
    }
    case "td":
      return inGridTable(el) ? "gridcell" : "cell";
    case "th": {
      const scope = (el.getAttribute("scope") ?? "").trim().toLowerCase();
      return scope === "row" || scope === "rowgroup" ? "rowheader" : "columnheader";
    }
    default:
      return BY_TAG.get(el.localName) ?? null;
  }
}

/** The first token of `role` that names a real ARIA role, if any. */
export function explicitRole(el: RoleElement): string | null {
  const tokens = (el.getAttribute("role") ?? "").trim().toLowerCase().split(/\s+/);
  return tokens.find((token) => validAriaRoles.has(token)) ?? null;
}

const NATIVELY_FOCUSABLE = new Set([
  "button",
  "iframe",
  "input",
  "select",
  "summary",
  "textarea",
]);

// The HTML rules for parsing an integer: optional leading whitespace and sign.
const VALID_TABINDEX = /^[\t\n\f\r ]*[+-]?\d/;
const EDITING_HOST_VALUES = new Set(["", "true", "plaintext-only"]);

/**
 * Focusable without script: a valid tabindex, an editing host, a link, an
 * enabled form control.
 */
function isFocusable(el: RoleElement): boolean {
  if (VALID_TABINDEX.test(el.getAttribute("tabindex") ?? "")) return true;
  const editable = el.getAttribute("contenteditable");
  if (editable !== null && EDITING_HOST_VALUES.has(editable.toLowerCase())) return true;
  const tag = el.localName;
  if (tag === "a" || tag === "area") return el.hasAttribute("href");
  if (!NATIVELY_FOCUSABLE.has(tag)) return false;
  if (tag === "input" && (el.getAttribute("type") ?? "").toLowerCase() === "hidden") return false;
  return !el.hasAttribute("disabled");
}

function hasGlobalAriaAttribute(el: RoleElement): boolean {
  for (const name of globalAriaAttributes) {
    if (el.hasAttribute(name)) return true;
  }
  return false;
}

/**
 * The role an element exposes: the first valid token of its `role` attribute
 * (the attribute is a fallback list), otherwise its implicit role. A `role`
 * with no valid token is ignored, as browsers ignore it. So is `none` or
 * `presentation` on an element that is focusable or carries a global ARIA
 * attribute (WAI-ARIA, presentational role conflict resolution).
 */
export function effectiveRole(el: RoleElement): string | null {
  const explicit = explicitRole(el);
  if (
    (explicit === "none" || explicit === "presentation") &&
    (isFocusable(el) || hasGlobalAriaAttribute(el))
  ) {
    return implicitRole(el);
  }
  return explicit ?? implicitRole(el);
}
