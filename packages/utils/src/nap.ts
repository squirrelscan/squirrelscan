// NAP (Name / Address / Phone) signal extraction — the ONE definition of how a
// page's contact identity is read off a parsed page.
//
// It has two callers that MUST agree byte-for-byte: `local/nap-consistency`'s
// legacy `ctx.site.pages` path reads it live, and `extractPageFeatures` stores it
// into `page_features` for the same rule's streaming `ctx.siteQuery` path. Any
// divergence between them shows up as a v1↔v2 golden failure, so the extraction
// lives here rather than being written twice.
//
// Sources are deliberately limited to DECLARED contact data — `tel:`/`mailto:`
// links and JSON-LD `telephone`/`address` — never a regex over visible body text.
// Free-text phone/address scraping produces false positives (order numbers, dates,
// prices) that would then be reported as NAP drift, which is worse than silence.

import type { ParsedPage } from "@squirrelscan/core-contracts";

import { flattenJsonLdNodes } from "./schema-rich-results";

/** Schema @types that mark a page as declaring a business identity. */
export const NAP_BUSINESS_SCHEMA_TYPES = [
  "LocalBusiness",
  "Organization",
  "Restaurant",
  "Store",
];

/** Schema @types the business NAME is read from (subset of the above). */
export const NAP_NAME_SCHEMA_TYPES = ["LocalBusiness", "Organization"];

/** Shortest digit run accepted as a phone number — below this it is an extension/id. */
export const NAP_PHONE_MIN_DIGITS = 7;

/**
 * How many trailing digits form the comparison key. The subscriber tail is the
 * part that stays put across country-code, trunk-prefix and punctuation variants
 * ("+1 (555) 123-4567", "555.123.4567", "01555 1234567" all key on "1234567"), so
 * one number written many ways stays ONE number and only the display form differs
 * — which is precisely the format-drift signal this rule reports as a warning.
 */
const NAP_PHONE_KEY_DIGITS = 7;

/** Per-page cap on carried phone numbers — bounds the stored page_features row. */
export const NAP_MAX_PHONES_PER_PAGE = 4;

/** Per-page cap on the carried address string — bounds the stored row. */
export const NAP_MAX_ADDRESS_CHARS = 200;

/**
 * Street-type / directional / unit abbreviations folded into their long form for
 * the comparison key. This is what lets "123 Main St." and "123 Main Street" be
 * recognised as the SAME address rendered two ways (a warning) rather than two
 * different addresses (a failure) — the exact drift the rule's solution text
 * calls out.
 *
 * A Map, not an object literal: the lookup key is a token off an audited page, so
 * `TABLE[token]` on a `{}` would resolve "constructor"/"__proto__" through the
 * prototype chain and fold a whole function body into the address key.
 */
const NAP_ADDRESS_ABBREVIATIONS = new Map<string, string>(Object.entries({
  st: "street",
  str: "street",
  ave: "avenue",
  av: "avenue",
  rd: "road",
  blvd: "boulevard",
  blv: "boulevard",
  dr: "drive",
  ln: "lane",
  ct: "court",
  pl: "place",
  sq: "square",
  hwy: "highway",
  pkwy: "parkway",
  ter: "terrace",
  cir: "circle",
  ste: "suite",
  apt: "apartment",
  fl: "floor",
  bldg: "building",
  rm: "room",
  n: "north",
  s: "south",
  e: "east",
  w: "west",
  ne: "northeast",
  nw: "northwest",
  se: "southeast",
  sw: "southwest",
}));

/** PostalAddress fields joined, in schema.org's own reading order, for display. */
const NAP_ADDRESS_FIELDS = [
  "streetAddress",
  "addressLocality",
  "addressRegion",
  "postalCode",
  "addressCountry",
];

/** One page's declared contact identity, as stored on `PageFeatureRow`. */
export interface NapSignal {
  /** Business name from LocalBusiness/Organization JSON-LD, or null. */
  name: string | null;
  /** Canonical phone keys, first-seen order, deduped, capped. */
  phones: string[];
  /** Display form of `phones[i]` exactly as the page rendered it (parallel array). */
  phoneFormats: string[];
  /** Canonical postal-address key, or null when the page declares none. */
  address: string | null;
  /** The postal address exactly as the page rendered it. */
  addressFormat: string | null;
  /** The page carries at least one `tel:` link. */
  telLink: boolean;
  /** The page carries at least one `mailto:` link. */
  mailtoLink: boolean;
}

/** An empty signal — the value for a page that declares no contact data. */
export function emptyNapSignal(): NapSignal {
  return {
    name: null,
    phones: [],
    phoneFormats: [],
    address: null,
    addressFormat: null,
    telLink: false,
    mailtoLink: false,
  };
}

/**
 * Canonical comparison key for a phone number: its trailing
 * {@link NAP_PHONE_KEY_DIGITS} digits. Null when the input holds too few digits
 * to be a phone number at all.
 */
export function napPhoneKey(raw: string): string | null {
  const digits = raw.replace(/[^0-9]/g, "");
  if (digits.length < NAP_PHONE_MIN_DIGITS) return null;
  return digits.slice(-NAP_PHONE_KEY_DIGITS);
}

/**
 * Canonical comparison key for a postal address: lowercased, punctuation
 * flattened to single spaces, and street-type/directional abbreviations expanded
 * (see {@link NAP_ADDRESS_ABBREVIATIONS}). Null for input with no alphanumerics.
 */
export function napAddressKey(raw: string): string | null {
  const tokens = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((token) => token.length > 0)
    .map((token) => NAP_ADDRESS_ABBREVIATIONS.get(token) ?? token);
  return tokens.length > 0 ? tokens.join(" ") : null;
}

/** Collapse whitespace and cap length — the stored display form of an address. */
function displayAddress(raw: string): string | null {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.slice(0, NAP_MAX_ADDRESS_CHARS);
}

/** Render a JSON-LD `address` value (string or PostalAddress node) for display. */
function readSchemaAddress(value: unknown): string | null {
  if (typeof value === "string") return displayAddress(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const node = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const field of NAP_ADDRESS_FIELDS) {
    const part = node[field];
    if (typeof part === "string" && part.trim()) parts.push(part.trim());
  }
  return parts.length > 0 ? displayAddress(parts.join(", ")) : null;
}

/**
 * Cheap pre-filter over the raw JSON-LD string. Every field this module reads
 * (`name` on a business node, `telephone`, `address`) requires one of these
 * substrings to be present, so a raw blob containing none of them cannot
 * contribute a signal and does not need parsing. Site rules run this per page, so
 * skipping the JSON.parse on the (common) no-NAP page matters at crawl scale.
 */
function mayCarryNap(raw: string): boolean {
  return (
    raw.includes("telephone") ||
    raw.includes("address") ||
    raw.includes("LocalBusiness") ||
    raw.includes("Organization")
  );
}

/**
 * Distil one parsed page's declared NAP into its {@link NapSignal}. Pure and
 * synchronous — reads only already-extracted ParsedPage fields, no DOM, no I/O.
 *
 * Extraction order is fixed (contact links first, then JSON-LD nodes in document order)
 * because the FIRST phone/address found is the one treated as the page's primary
 * contact by the rule; a stable order keeps both rule paths agreeing.
 */
export function extractNapSignal(parsed: ParsedPage | null | undefined): NapSignal {
  const signal = emptyNapSignal();
  if (!parsed) return signal;

  const phoneKeys = new Map<string, string>();
  const addPhone = (key: string | null, display: string): void => {
    if (!key || phoneKeys.size >= NAP_MAX_PHONES_PER_PAGE || phoneKeys.has(key)) return;
    phoneKeys.set(key, display);
  };

  // `parsed.contactLinks`, NOT `parsed.links` — the parser drops non-crawlable
  // schemes from the link graph, so tel:/mailto: only exist on this field.
  for (const link of parsed.contactLinks ?? []) {
    if (link.scheme === "mailto") {
      signal.mailtoLink = true;
      continue;
    }
    signal.telLink = true;
    // The href payload is the fallback display; the visible anchor text wins
    // when it spells out the same number, since that is the citable rendering
    // a directory (or an agent) copies off the page.
    const payload = decodeTelPayload(link.value);
    const key = napPhoneKey(payload);
    const text = link.text.trim();
    addPhone(key, key && napPhoneKey(text) === key ? text : payload);
  }

  const raw = parsed.schema?.raw;
  if (raw && mayCarryNap(raw)) {
    const nodes = flattenJsonLdNodes(raw);
    for (const node of nodes) {
      if (
        signal.name === null &&
        NAP_NAME_SCHEMA_TYPES.includes(node["@type"] as string) &&
        typeof node.name === "string" &&
        node.name
      ) {
        signal.name = node.name;
      }
      if (typeof node.telephone === "string") {
        const phone = node.telephone.trim();
        addPhone(napPhoneKey(phone), phone);
      }
      if (signal.address === null && node.address !== undefined) {
        const display = readSchemaAddress(node.address);
        if (display) {
          signal.address = napAddressKey(display);
          signal.addressFormat = signal.address ? display : null;
        }
      }
    }
  }

  signal.phones = [...phoneKeys.keys()];
  signal.phoneFormats = [...phoneKeys.values()];
  return signal;
}

/** `tel:` payloads may be percent-encoded; fall back to the raw text on bad input. */
function decodeTelPayload(payload: string): string {
  try {
    return decodeURIComponent(payload).trim();
  } catch {
    return payload.trim();
  }
}
