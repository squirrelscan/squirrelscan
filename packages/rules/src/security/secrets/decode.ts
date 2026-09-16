// security/leaked-secrets — content decoders (#360).
//
// A credential does not have to be spelled out in the bytes a crawl receives.
// Three encodings hide one from a byte-level scan while leaving it perfectly
// usable to the page:
//
// - HTML entities in an attribute or text node: `data-config="{&quot;apiKey
//   &quot;:&quot;sk_live_…&quot;}"`. The DOM decodes these, but the scanner
//   reads the serialized document and the serializer writes them back.
// - JavaScript string escapes: `"sk_live_…"` and `"\x73k_live_…"`, which
//   a minifier or an obfuscation pass emits and the engine decodes at parse.
// - percent-encoding: a settings object embedded URL-encoded,
//   `data-settings="%7B%22key%22%3A%22pk_live_…"`, read back with
//   decodeURIComponent.
// - base64: a whole config object handed to the client as one blob,
//   `window.__CONFIG__="eyJhcGlLZXkiOi…"` or `data-state="…"`, decoded by a
//   line of bootstrap code.
//
// Each decoder here is a pure function of the text, bounded in cost, and
// never touches the network. The scanner applies the first three in place as
// the content enters it (so every pattern sees the decoded form once, at no
// extra pass) and the base64 decoder after its own passes, recursing on what
// it finds.

import type { LeakedSecret } from "../leaked-secrets";

/** The three places the scanner reads. */
export type SecretLocation = "html" | "inline-script" | "external-script"; // pragma: allowlist secret

/**
 * Where a finding is reported: one of the three locations, with a `(base64)`
 * suffix when the value only existed inside a decoded blob. One suffix, however
 * deep the blob sat: what matters to the reader is that the page carries the
 * key in an encoded form, not how many times it was wrapped.
 */
export type ReportedLocation = SecretLocation | `${SecretLocation} (base64)`;

export const BASE64_SUFFIX = " (base64)";

/** The location a decoded finding reports under. */
export function base64Location(location: ReportedLocation): ReportedLocation {
  return location.endsWith(BASE64_SUFFIX)
    ? location
    : (`${location}${BASE64_SUFFIX}` as ReportedLocation);
}

// ── HTML entities ───────────────────────────────────────────────────────────

// The named entities a serializer emits and the few a hand-written page uses
// around a JSON value. Anything else is left as written: a `&foo;` that this
// table does not know is far more likely to be a literal than an entity, and a
// wrong decode can only hide a key, never reveal one.
const NAMED_ENTITIES: Record<string, string> = {
  quot: '"',
  amp: "&",
  lt: "<",
  gt: ">",
  apos: "'",
  nbsp: " ",
  sol: "/",
  equals: "=",
  colon: ":",
  semi: ";",
  comma: ",",
  lbrace: "{",
  rbrace: "}",
  lsqb: "[",
  rsqb: "]",
  lpar: "(",
  rpar: ")",
  grave: "`",
  bsol: "\\",
  num: "#",
  percnt: "%",
  plus: "+",
  excl: "!",
  quest: "?",
  dollar: "$",
  ast: "*",
  lowbar: "_",
  period: ".",
  hyphen: "-",
  dash: "-",
  tilde: "~",
  verbar: "|",
  Tab: "\t",
  NewLine: "\n",
};

// `&#39;`, `&#x27;`, `&quot;`. The name is bounded so a stray `&` in front of
// a long word costs a bounded look, and the numeric forms are bounded because
// no code point needs more digits than that.
const ENTITY_RE = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,15}));/g;

function codePointToString(code: number): string | null {
  // Surrogates and out-of-range values are not characters; keep the entity.
  if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null;
  // NUL would make the string binary for anything that reads it later.
  if (code === 0) return null;
  return String.fromCodePoint(code);
}

/**
 * Decode the character references a serialized document carries. Cheap on a
 * page without any: one `indexOf` and the regex never allocates.
 */
export function decodeHtmlEntities(text: string): string {
  if (text.indexOf("&") === -1) return text;
  return text.replace(ENTITY_RE, (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (dec !== undefined) return codePointToString(Number.parseInt(dec, 10)) ?? whole;
    if (hex !== undefined) return codePointToString(Number.parseInt(hex, 16)) ?? whole;
    if (name !== undefined) return NAMED_ENTITIES[name] ?? whole;
    return whole;
  });
}

// ── JavaScript string escapes ───────────────────────────────────────────────

// `\uXXXX`, `\u{X…}` and `\xXX`. Nothing else: `\n`, `\"` and `\\` are not how
// a key gets hidden, and decoding `\\u0041` (an escaped backslash followed by
// the letter u) would invent text the engine never sees. The odd-backslash
// check below handles that case.
const JS_ESCAPE_RE = /\\(?:u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2}))/g;

/**
 * Decode the Unicode and hex escapes in script text. Applied to the whole text
 * rather than to string literals only: finding the literals costs a tokenizer,
 * and an escape outside a string (in a regex literal, say) decodes to the same
 * character the engine would read there anyway.
 */
export function unescapeJsStrings(text: string): string {
  if (text.indexOf("\\u") === -1 && text.indexOf("\\x") === -1) return text;
  return text.replace(
    JS_ESCAPE_RE,
    (whole, braced: string | undefined, four: string | undefined, two: string | undefined, offset: number) => {
      // An even run of backslashes before this one means the backslash that
      // opens the escape is itself escaped, and the `u` is a literal `u`.
      let slashes = 0;
      for (let i = offset - 1; i >= 0 && text.charCodeAt(i) === 92; i--) slashes++;
      if (slashes % 2 === 1) return whole;
      const code = Number.parseInt(braced ?? four ?? two ?? "", 16);
      // `😀` is how a script spells one astral character as two
      // code units; the engine joins them and so does this.
      if (four !== undefined && code >= 0xd800 && code <= 0xdfff) return String.fromCharCode(code);
      return codePointToString(code) ?? whole;
    },
  );
}

// ── Percent-encoding ────────────────────────────────────────────────────────

// A settings object handed to the client URL-encoded, `%7B%22key%22%3A…`, is
// decoded in place like an entity: the value is where it was, only readable.
// A run is the span of URL-safe text around a `%XX`; it has to carry at least
// this many escapes (one `%20` in a query string is not an encoded document)
// and decode to text.
const PERCENT_MIN_ESCAPES = 3;
const PERCENT_MAX_RUNS = 256;
const PERCENT_MAX_RUN_CHARS = 1024 * 1024;

function isHexAt(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

// What ends a URL-encoded run: whitespace, a quote, an angle bracket, a
// backtick, and the punctuation encodeURIComponent never leaves raw —
// `;{}()[],` — so that a `%2F` in the middle of a minified statement bounds
// its run at the statement's own brackets rather than at the next quote, a
// kilobyte away. `&`, `=`, `+`, `.`, `-`, `_`, `~`, `*`, `!` stay in: a query
// string is made of them.
const PERCENT_RUN_STOP = new Uint8Array(128);
for (const ch of " \t\n\r\v\f\"'<>`;{}()[],") PERCENT_RUN_STOP[ch.charCodeAt(0)] = 1;
function endsPercentRun(code: number): boolean {
  return code < 128 && PERCENT_RUN_STOP[code] === 1;
}

/**
 * Decode the `%XX` escapes of one run into text, or null when the result is
 * not text. A `%` not followed by two hex digits is kept as written.
 */
export function decodePercentRun(run: string): string | null {
  const bytes: number[] = [];
  let escapes = 0;
  for (let i = 0; i < run.length; i++) {
    const code = run.charCodeAt(i);
    if (code === 37 && i + 2 < run.length && isHexAt(run, i + 1) && isHexAt(run, i + 2)) {
      bytes.push(Number.parseInt(run.slice(i + 1, i + 3), 16));
      escapes++;
      i += 2;
      continue;
    }
    if (code > 0x7f) {
      // A non-ASCII character inside a URL-encoded run: encode it as UTF-8 so
      // the byte check and the decode below see one consistent stream.
      const point = run.codePointAt(i) ?? code;
      for (const byte of Buffer.from(String.fromCodePoint(point), "utf8")) bytes.push(byte);
      if (point > 0xffff) i++;
      continue;
    }
    bytes.push(code);
  }
  if (escapes < PERCENT_MIN_ESCAPES) return null;
  for (const byte of bytes) {
    if (!isTextByte(byte)) return null;
  }
  const decoded = Buffer.from(bytes).toString("utf8");
  return decoded.includes("�") ? null : decoded;
}

/**
 * Decode every URL-encoded run in the text, in place. Runs are located from
 * their `%` characters, so text without one costs a single `indexOf`.
 */
export function decodePercentRuns(text: string): string {
  let at = text.indexOf("%");
  if (at === -1) return text;
  const out: string[] = [];
  let copied = 0;
  // Where the last run examined ended: the walk back from the next `%` stops
  // there, so a long run that failed to decode is not re-walked from each of
  // its own escapes.
  let scanned = 0;
  let runs = 0;
  const length = text.length;
  while (at !== -1 && runs < PERCENT_MAX_RUNS) {
    // Only a `%XX` opens a run; a lone `%` is a percent sign.
    if (!(at + 2 < length && isHexAt(text, at + 1) && isHexAt(text, at + 2))) {
      at = text.indexOf("%", at + 1);
      continue;
    }
    let start = at;
    const floor = Math.max(copied, scanned);
    while (start > floor && !endsPercentRun(text.charCodeAt(start - 1))) start--;
    let end = at + 3;
    while (end < length && !endsPercentRun(text.charCodeAt(end))) end++;
    if (end - start <= PERCENT_MAX_RUN_CHARS) {
      const decoded = decodePercentRun(text.slice(start, end));
      if (decoded !== null) {
        out.push(text.slice(copied, start), decoded);
        copied = end;
        runs++;
      }
    }
    scanned = end;
    at = text.indexOf("%", end);
  }
  if (copied === 0) return text;
  out.push(text.slice(copied));
  return out.join("");
}

/**
 * The decoding the scanner applies as content enters it, by location.
 *
 * The serialized document gets all three: its inline scripts are scanned
 * inside it as well as on their own, and unescaping them in one place but not
 * the other would report the escaped text under the generic assignment
 * pattern as a second, different "value" of the same key.
 */
export function decodeForLocation(content: string, location: ReportedLocation): string {
  if (location === "html") return unescapeJsStrings(decodePercentRuns(decodeHtmlEntities(content)));
  // Script text, and the inside of a decoded blob whatever it came from: a
  // JSON config blob escapes the same way a script string does.
  return unescapeJsStrings(decodePercentRuns(content));
}

// ── base64 blobs ────────────────────────────────────────────────────────────

/** How many levels of base64 the scanner unwraps. */
export const BASE64_MAX_DEPTH = 2;

/** A blob shorter than this decodes to too little to hold a key worth finding. */
export const BASE64_MIN_CHARS = 64;

// Bounds per scanned text, so that a page cannot make the scanner decode more
// than it read. A blob past the size cap is skipped whole rather than clipped:
// a clipped decode would land the scan on a boundary the page never had.
const BASE64_MAX_BLOBS = 256;
const BASE64_MAX_BLOB_CHARS = 4 * 1024 * 1024;
const BASE64_MAX_DECODED_TOTAL = 8 * 1024 * 1024;

// A byte a decoded blob may carry and still be text. Tab, LF, CR, and the
// printable ASCII range; anything above 0x7f is settled by UTF-8 validity.
function isTextByte(byte: number): boolean {
  return (byte >= 0x20 && byte !== 0x7f) || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

// The base64 and base64url alphabets together, as a lookup on the code unit.
const B64_CHAR = new Uint8Array(128);
for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/-_") { // pragma: allowlist secret
  B64_CHAR[ch.charCodeAt(0)] = 1;
}

/** A run of base64 alphabet in the text: where it starts and ends (exclusive). */
export interface Base64Run {
  start: number;
  end: number;
}

// Text that says the run in front of it is not a config blob: the body of a
// `data:` URI, or a Subresource Integrity hash. Both are base64 by definition
// and neither ever decodes to text worth scanning; the data URI in particular
// can be hundreds of kilobytes of image, and reading its prefix is what keeps
// that under a millisecond.
const DATA_URI_LEAD = "base64,";
// `-` is base64url alphabet, so `sha384-` is usually the head of the run
// itself rather than the text before it; both positions are checked.
const SRI_LEAD_RE = /sha(?:256|384|512)-$/;
const SRI_HEAD_RE = /^sha(?:256|384|512)-/;

/** Is the run at `start` the payload of a data: URI or an SRI hash? */
export function isExcludedBase64Run(text: string, start: number): boolean {
  if (start >= DATA_URI_LEAD.length && text.startsWith(DATA_URI_LEAD, start - DATA_URI_LEAD.length)) {
    return true;
  }
  if (SRI_HEAD_RE.test(text.slice(start, start + 7))) return true;
  return SRI_LEAD_RE.test(text.slice(Math.max(0, start - 7), start));
}

function isB64At(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code < 128 && B64_CHAR[code] === 1;
}

// Sampling stride and window. A run of L alphabet characters holds a sampled
// position with HALF run characters on either side of it whenever
// L - 2 * HALF >= STRIDE, whatever residue the samples fall on. The shortest
// run worth finding is BASE64_MIN_CHARS, of which two may be `=` padding
// (which is not alphabet), so L is 62: HALF = 15 leaves exactly STRIDE = 32
// qualifying positions. A window in ordinary code fails on its first
// punctuation mark.
const SAMPLE_STRIDE = 32;
const SAMPLE_HALF = 15;

// The rest of a run from a known start, matched natively rather than a
// character at a time: a 200 KB image data URI is one exec, not 200k steps.
const B64_RUN_RE = /[A-Za-z0-9+/_-]*={0,2}/y;

/**
 * Every run of base64 alphabet of at least `minChars` characters, with any
 * `=` padding folded into the run.
 *
 * Neither a global regex nor a character loop is cheap enough here: the regex
 * retries every shorter run from its second character (a hidden quadratic on
 * identifier-dense code), and the loop touches every code unit of a 5 MB
 * bundle from JavaScript. So the text is sampled instead. Every `STRIDE`th
 * character is checked, and only a sample whose surrounding window is all
 * base64 is worth expanding: back to the run's start (at most `STRIDE + HALF`
 * characters, because the first qualifying sample sits that close to it) and
 * forward with one sticky regex exec. Sampling then resumes past the run.
 */
export function findBase64Runs(text: string, minChars = BASE64_MIN_CHARS): Base64Run[] {
  const runs: Base64Run[] = [];
  const length = text.length;
  if (length < minChars) return runs;

  let sample = SAMPLE_STRIDE;
  while (sample < length) {
    // The centre first: in code it is punctuation a third of the time.
    if (!isB64At(text, sample)) {
      sample += SAMPLE_STRIDE;
      continue;
    }
    let windowOk = true;
    const lo = Math.max(0, sample - SAMPLE_HALF);
    const hi = Math.min(length - 1, sample + SAMPLE_HALF);
    for (let i = lo; i <= hi; i++) {
      if (!isB64At(text, i)) {
        windowOk = false;
        break;
      }
    }
    if (!windowOk) {
      sample += SAMPLE_STRIDE;
      continue;
    }

    // Inside a run at least a window wide. Walk back to where it begins.
    let start = lo;
    while (start > 0 && isB64At(text, start - 1)) start--;
    B64_RUN_RE.lastIndex = start;
    const end = start + (B64_RUN_RE.exec(text)?.[0].length ?? 0);
    if (end - start >= minChars) {
      runs.push({ start, end });
      if (runs.length >= BASE64_MAX_BLOBS) break;
    }
    // Resume at the first sample past the run.
    sample = Math.max(sample + SAMPLE_STRIDE, end + 1);
  }
  return runs;
}

/**
 * Could the first 64 characters be base64 of text at all? Read before
 * anything is allocated, because the alphabet includes `/`, `-` and `_`, so
 * most runs on a real page are URL paths (`com/cdn/shopifycloud/storefront/
 * assets/…`), and a Shopify product page carries three hundred of them.
 *
 * base64 of printable text always mixes upper- and lower-case (the first
 * sextet of any printable byte lands in `I…f`), draws `/` about once in 64
 * characters (six or more in the first 64 is a path, not text), and comes
 * from ONE alphabet: `+`/`/` or `-`/`_`, never both.
 */
export function looksLikeBase64Text(blob: string): boolean {
  let upper = 0;
  let lower = 0;
  let slashes = 0;
  let standard = 0;
  let urlSafe = 0;
  const end = Math.min(blob.length, BASE64_MIN_CHARS);
  for (let i = 0; i < end; i++) {
    const code = blob.charCodeAt(i);
    if (code >= 65 && code <= 90) upper++;
    else if (code >= 97 && code <= 122) lower++;
    else if (code === 47) {
      slashes++;
      standard++;
    } else if (code === 43) standard++;
    else if (code === 45 || code === 95) urlSafe++;
  }
  return upper > 0 && lower > 0 && slashes < 6 && !(standard > 0 && urlSafe > 0);
}

/**
 * Decode one run as base64 if, and only if, the result is text. The first 48
 * bytes are decoded and checked on their own first, so a hash, a signature or
 * a compressed payload is rejected for the price of 64 characters and never
 * allocates its full length.
 */
export function decodeBase64Text(blob: string): string | null {
  if (blob.length < BASE64_MIN_CHARS || blob.length > BASE64_MAX_BLOB_CHARS) return null;
  if (!looksLikeBase64Text(blob)) return null;
  const head = Buffer.from(blob.slice(0, BASE64_MIN_CHARS), "base64");
  if (head.length < 40) return null;
  for (const byte of head) {
    if (!isTextByte(byte)) return null;
  }
  const bytes = Buffer.from(blob, "base64");
  for (const byte of bytes) {
    if (!isTextByte(byte)) return null;
  }
  // High bytes were accepted above; this is where a Latin-1 blob or binary
  // that happened to avoid the control range is rejected.
  const decoded = bytes.toString("utf8");
  return decoded.includes("�") ? null : decoded;
}

/** The scanner, as the blob pass sees it: one more argument, the depth. */
export type BlobScanner = (
  content: string,
  location: ReportedLocation,
  sourceUrl: string | undefined,
  depth: number,
) => LeakedSecret[];

/**
 * Find the base64 blobs in `content`, decode the ones that are text, and scan
 * each decoded text with `scan` at `depth + 1`. `scan` is the scanner itself,
 * handed in rather than imported so the blob pass and the scanner do not
 * depend on each other's module.
 */
export function scanBase64Blobs(
  content: string,
  location: ReportedLocation,
  sourceUrl: string | undefined,
  depth: number,
  scan: BlobScanner,
): LeakedSecret[] {
  if (depth >= BASE64_MAX_DEPTH) return [];
  const found: LeakedSecret[] = [];
  const decodedLocation = base64Location(location);
  let decodedTotal = 0;

  for (const run of findBase64Runs(content)) {
    if (isExcludedBase64Run(content, run.start)) continue;
    // Charged before decoding, on the size the blob will decode to, so the
    // budget bounds what is allocated and not only what was already read.
    const bytes = Math.floor(((run.end - run.start) * 3) / 4);
    if (decodedTotal + bytes > BASE64_MAX_DECODED_TOTAL) break;
    decodedTotal += bytes;
    const decoded = decodeBase64Text(content.slice(run.start, run.end));
    if (decoded === null) continue;
    // Appended one at a time: a decoded blob can carry thousands of findings,
    // and spreading that many arguments is an engine-dependent RangeError.
    for (const finding of scan(decoded, decodedLocation, sourceUrl, depth + 1)) {
      found.push(finding);
    }
  }
  return found;
}
