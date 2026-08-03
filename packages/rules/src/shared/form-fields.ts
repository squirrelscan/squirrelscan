// Shared form-field helpers for the forms rules (a11y/autocomplete-tokens,
// a11y/input-types).
//
// Purpose inference matches on name/id/label SEGMENTS, never raw substrings:
// "capacity" must not read as a "city" field and "hotel" must not read as a
// "tel" field. Segments come from splitting on non-alphanumerics, camelCase
// boundaries, and letter/digit boundaries, so `billingFirstName`,
// `billing_first_name` and `billing-first-name` all reduce to the same list.

/** The five field families this module can identify. */
export type FieldPurposeGroup = "name" | "email" | "tel" | "address" | "payment";

export interface FieldPurpose {
  /** The WHATWG autofill token this field should carry. */
  token: string;
  /** Other tokens that are also correct here (e.g. `username` for a login email). */
  alternatives: string[];
  group: FieldPurposeGroup;
  /** Human-readable purpose, used in messages. */
  label: string;
}

interface PurposeEntry extends FieldPurpose {
  seqs: string[][];
}

/**
 * Ordered most-specific-first: the first entry whose segment sequence matches
 * wins. Payment leads so "name on card" never reads as a person's name, and
 * email precedes address so "email address" never reads as a postal address.
 */
const PURPOSES: PurposeEntry[] = [
  {
    token: "cc-name",
    alternatives: [],
    group: "payment",
    label: "cardholder name",
    seqs: [
      ["name", "on", "card"],
      ["card", "holder"],
      ["cardholder"],
      ["cc", "name"],
      ["ccname"],
      ["card", "name"],
    ],
  },
  {
    token: "cc-number",
    alternatives: [],
    group: "payment",
    label: "card number",
    seqs: [
      ["card", "number"],
      ["cardnumber"],
      ["cc", "number"],
      ["ccnumber"],
      ["ccnum"],
      ["credit", "card"],
      ["creditcard"],
      ["card", "no"],
    ],
  },
  {
    token: "cc-exp",
    alternatives: ["cc-exp-month", "cc-exp-year"],
    group: "payment",
    label: "card expiry",
    seqs: [
      ["card", "expiry"],
      ["cc", "exp"],
      ["ccexp"],
      ["exp", "date"],
      ["expdate"],
      ["expiry"],
      ["expiration"],
    ],
  },
  {
    token: "cc-csc",
    alternatives: [],
    group: "payment",
    label: "card security code",
    seqs: [
      ["cvv"],
      ["cvv", "2"],
      ["cvc"],
      ["csc"],
      ["security", "code"],
      ["securitycode"],
      ["card", "code"],
    ],
  },
  {
    token: "email",
    alternatives: ["username"],
    group: "email",
    label: "email",
    seqs: [["email"], ["emailaddress"], ["e", "mail"], ["mail"]],
  },
  {
    token: "tel",
    alternatives: [
      "tel-national",
      "tel-local",
      "tel-country-code",
      "tel-area-code",
      "tel-extension",
    ],
    group: "tel",
    label: "phone number",
    seqs: [
      ["phone"],
      ["phonenumber"],
      ["telephone"],
      ["tel"],
      ["mobile"],
      ["mobilenumber"],
      ["cellphone"],
      ["cell"],
    ],
  },
  {
    token: "given-name",
    alternatives: [],
    group: "name",
    label: "first name",
    seqs: [
      ["first", "name"],
      ["firstname"],
      ["given", "name"],
      ["givenname"],
      ["fname"],
      ["forename"],
    ],
  },
  {
    token: "family-name",
    alternatives: [],
    group: "name",
    label: "last name",
    seqs: [
      ["last", "name"],
      ["lastname"],
      ["family", "name"],
      ["familyname"],
      ["surname"],
      ["lname"],
    ],
  },
  {
    token: "additional-name",
    alternatives: [],
    group: "name",
    label: "middle name",
    seqs: [["middle", "name"], ["middlename"], ["mname"]],
  },
  {
    token: "name",
    alternatives: [],
    group: "name",
    label: "full name",
    seqs: [
      ["full", "name"],
      ["fullname"],
      ["your", "name"],
    ],
  },
  {
    token: "address-line2",
    alternatives: [],
    group: "address",
    label: "address line 2",
    seqs: [
      ["address", "line", "2"],
      ["addressline", "2"],
      ["address", "2"],
      ["addr", "2"],
      ["street", "2"],
    ],
  },
  {
    token: "address-line1",
    alternatives: ["street-address"],
    group: "address",
    label: "address line 1",
    seqs: [
      ["address", "line", "1"],
      ["addressline", "1"],
      ["address", "1"],
      ["addr", "1"],
      ["street", "address"],
      ["streetaddress"],
      ["street"],
    ],
  },
  {
    token: "street-address",
    alternatives: ["address-line1"],
    group: "address",
    label: "street address",
    seqs: [["address"], ["addr"]],
  },
  {
    token: "address-level2",
    alternatives: [],
    group: "address",
    label: "city",
    seqs: [["city"], ["town"], ["suburb"]],
  },
  {
    token: "address-level1",
    alternatives: [],
    group: "address",
    label: "state or province",
    seqs: [["state"], ["province"], ["prefecture"]],
  },
  {
    token: "postal-code",
    alternatives: [],
    group: "address",
    label: "postal code",
    seqs: [
      ["zip", "code"],
      ["zipcode"],
      ["zip"],
      ["postal", "code"],
      ["postalcode"],
      ["post", "code"],
      ["postcode"],
    ],
  },
  {
    token: "country",
    alternatives: ["country-name"],
    group: "address",
    label: "country",
    seqs: [["country"]],
  },
];

/** Input `type` values implied by a field's evident purpose. */
export type ExpectedInputType = "email" | "tel" | "url" | "number";

const INPUT_TYPE_HINTS: Array<{ type: ExpectedInputType; seqs: string[][] }> = [
  {
    type: "email",
    seqs: [["email"], ["emailaddress"], ["e", "mail"], ["mail"]],
  },
  {
    type: "tel",
    seqs: [
      ["phone"],
      ["phonenumber"],
      ["telephone"],
      ["tel"],
      ["mobile"],
      ["mobilenumber"],
      ["cellphone"],
      ["cell"],
    ],
  },
  {
    type: "url",
    seqs: [
      ["url"],
      ["website"],
      ["web", "site"],
      ["weburl"],
      ["site", "url"],
      ["siteurl"],
      ["homepage"],
      ["home", "page"],
      ["web", "address"],
    ],
  },
  {
    type: "number",
    seqs: [["quantity"], ["qty"]],
  },
];

/**
 * `type="number"` silently mangles these: it strips leading zeros, applies
 * locale digit grouping, exposes a spinner, and drops the value entirely when
 * the string is not a valid float. They are digit strings, not numbers.
 */
const NUMBER_HOSTILE_TOKENS = new Set(["postal-code", "tel", "cc-number", "cc-csc"]);

/** WHATWG autofill field names (the token that follows any section/mode prefix). */
const AUTOFILL_TOKENS = new Set([
  "name",
  "honorific-prefix",
  "given-name",
  "additional-name",
  "family-name",
  "honorific-suffix",
  "nickname",
  "username",
  "new-password",
  "current-password",
  "one-time-code",
  "organization-title",
  "organization",
  "street-address",
  "address-line1",
  "address-line2",
  "address-line3",
  "address-level4",
  "address-level3",
  "address-level2",
  "address-level1",
  "country",
  "country-name",
  "postal-code",
  "cc-name",
  "cc-given-name",
  "cc-additional-name",
  "cc-family-name",
  "cc-number",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
  "cc-csc",
  "cc-type",
  "transaction-currency",
  "transaction-amount",
  "language",
  "bday",
  "bday-day",
  "bday-month",
  "bday-year",
  "sex",
  "url",
  "photo",
  "tel",
  "tel-country-code",
  "tel-national",
  "tel-area-code",
  "tel-local",
  "tel-local-prefix",
  "tel-local-suffix",
  "tel-extension",
  "email",
  "impp",
]);

const ADDRESS_MODES = new Set(["shipping", "billing"]);
const CONTACT_MODES = new Set(["home", "work", "mobile", "fax", "pager"]);

/** `webauthn` only trails a credential field name; anywhere else it is invalid. */
const WEBAUTHN_TOKENS = new Set(["username", "new-password", "current-password"]);

/** Input types that never carry a personal-data purpose or a text keyboard. */
const NON_DATA_INPUT_TYPES = new Set([
  "hidden",
  "submit",
  "button",
  "reset",
  "image",
  "file",
  "checkbox",
  "radio",
  "range",
  "color",
]);

/**
 * Split a raw attribute value into lowercase segments. `billingAddress2` and
 * `billing_address_2` both become `["billing", "address", "2"]`.
 */
export function segmentsOf(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([a-zA-Z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([a-zA-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase());
}

/** True when `needle` appears as a consecutive run inside `haystack`. */
function containsSequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/** `label[for]` text keyed by control id, built once per document. */
export type LabelIndex = Map<string, string>;

export function buildLabelIndex(doc: Document): LabelIndex {
  const index: LabelIndex = new Map();
  for (const label of doc.querySelectorAll("label[for]")) {
    const target = label.getAttribute("for");
    if (!target) continue;
    const text = label.textContent?.trim();
    if (!text) continue;
    // First label wins; a11y/form-field-multiple-labels owns the duplicate case.
    if (!index.has(target)) index.set(target, text);
  }
  return index;
}

/**
 * Ordered evidence for what a field is for, strongest first: the submitted
 * name, then the id, then the visible/assistive label, then the placeholder.
 */
function purposeEvidence(el: Element, labels: LabelIndex): string[] {
  const evidence: string[] = [];
  const push = (value: string | null | undefined): void => {
    if (value && value.trim()) evidence.push(value);
  };
  push(el.getAttribute("name"));
  const id = el.getAttribute("id");
  push(id);
  if (id) push(labels.get(id));
  const wrapping = el.closest("label");
  if (wrapping) push(wrapping.textContent);
  push(el.getAttribute("aria-label"));
  push(el.getAttribute("placeholder"));
  return evidence;
}

/** The control's effective `type`, lowercased (`text` when absent on an input). */
export function inputType(el: Element): string {
  if (el.tagName.toLowerCase() !== "input") return el.tagName.toLowerCase();
  return (el.getAttribute("type") || "text").trim().toLowerCase();
}

/**
 * User-editable data controls only: no hidden/submit/button/file/checkbox
 * inputs, nothing disabled, nothing inside `[hidden]` or `[aria-hidden="true"]`.
 */
export function isDataField(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag !== "input" && tag !== "select" && tag !== "textarea") return false;
  if (tag === "input" && NON_DATA_INPUT_TYPES.has(inputType(el))) return false;
  if (el.hasAttribute("disabled")) return false;
  if (el.closest("[hidden]") || el.closest('[aria-hidden="true"]')) return false;
  return true;
}

/** A stable, human-readable selector for one control. */
export function fieldSelector(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.getAttribute("id");
  if (id) return `${tag}#${id}`;
  const name = el.getAttribute("name");
  if (name) return `${tag}[name="${name}"]`;
  const type = el.getAttribute("type");
  if (type) return `${tag}[type="${type}"]`;
  const placeholder = el.getAttribute("placeholder");
  if (placeholder) return `${tag}[placeholder="${placeholder}"]`;
  return tag;
}

/**
 * The element's START TAG, length-capped — never `outerHTML`, which serializes
 * the whole subtree (a `<select>` of 200 countries, or an entire `<form>`) on
 * every page of a crawl. The attributes are the part a fix needs anyway.
 */
export function fieldSnippet(el: Element, max = 200): string {
  const tag = el.tagName.toLowerCase();
  let out = `<${tag}`;
  for (const attr of el.attributes) {
    // Slice before normalising: a hostile page can carry a multi-megabyte
    // attribute value, and the cap must not cost a full copy of it first.
    out += ` ${attr.name}="${attr.value.slice(0, max).replace(/\s+/g, " ").trim()}"`;
    if (out.length >= max) break;
  }
  out += ">";
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/** The evident autofill purpose of a field, or null when it is not identifiable. */
export function inferFieldPurpose(el: Element, labels: LabelIndex): FieldPurpose | null {
  const evidence = purposeEvidence(el, labels);
  if (evidence.length === 0) return null;
  // Evidence-major: the strongest evidence decides, and PURPOSES order only
  // breaks ties WITHIN one piece of it. Iterating purposes first would let a
  // weak placeholder outrank the submitted name whenever its purpose happens
  // to sit higher in the list.
  for (const segments of evidence.map(segmentsOf)) {
    for (const entry of PURPOSES) {
      for (const seq of entry.seqs) {
        if (containsSequence(segments, seq)) {
          return {
            token: entry.token,
            alternatives: entry.alternatives,
            group: entry.group,
            label: entry.label,
          };
        }
      }
    }
  }
  return null;
}

/** The `type` a field's evident purpose calls for, or null when text is fine. */
export function inferExpectedInputType(el: Element, labels: LabelIndex): ExpectedInputType | null {
  // Evidence-major for the same reason as inferFieldPurpose.
  for (const segments of purposeEvidence(el, labels).map(segmentsOf)) {
    for (const hint of INPUT_TYPE_HINTS) {
      for (const seq of hint.seqs) {
        if (containsSequence(segments, seq)) return hint.type;
      }
    }
  }
  return null;
}

/** True when `type="number"` would corrupt this field's value. */
export function isNumberHostile(purpose: FieldPurpose | null): boolean {
  return purpose !== null && NUMBER_HOSTILE_TOKENS.has(purpose.token);
}

export type AutocompleteParse =
  | { kind: "off" }
  | { kind: "on" }
  | { kind: "invalid" }
  | { kind: "field"; token: string };

/**
 * Parse an `autocomplete` value down to its field token, tolerating the
 * `section-*`, shipping/billing and home/work/mobile/fax/pager prefixes and a
 * trailing `webauthn`. Anything else is invalid: browsers ignore the whole
 * attribute rather than guessing.
 */
export function parseAutocomplete(raw: string): AutocompleteParse {
  const parts = raw.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { kind: "invalid" };
  if (parts.length === 1 && parts[0] === "off") return { kind: "off" };
  if (parts.length === 1 && parts[0] === "on") return { kind: "on" };

  let i = 0;
  const section = parts[i];
  if (section && section.startsWith("section-") && section.length > "section-".length) i++;
  const addressMode = parts[i];
  if (addressMode && ADDRESS_MODES.has(addressMode)) i++;
  const contactMode = parts[i];
  if (contactMode && CONTACT_MODES.has(contactMode)) i++;

  const token = parts[i];
  if (!token || !AUTOFILL_TOKENS.has(token)) return { kind: "invalid" };
  i++;
  if (parts[i] === "webauthn" && WEBAUTHN_TOKENS.has(token)) i++;
  if (i !== parts.length) return { kind: "invalid" };
  return { kind: "field", token };
}

/** A stable, human-readable selector for one form element. */
export function formSelector(form: Element, index: number): string {
  const id = form.getAttribute("id");
  if (id) return `form#${id}`;
  const name = form.getAttribute("name");
  if (name) return `form[name="${name}"]`;
  const action = form.getAttribute("action");
  if (action) return `form[action="${action}"]`;
  return `form:nth-of-type(${index + 1})`;
}

/** Every user-editable data control inside a form, in document order. */
export function formDataFields(form: Element): Element[] {
  return [...form.querySelectorAll("input, select, textarea")].filter(isDataField);
}
