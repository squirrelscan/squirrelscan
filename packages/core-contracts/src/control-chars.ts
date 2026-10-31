// Control-character stripping for untrusted, page-derived text that reaches a
// terminal, a report file, or an agent's context.
//
// Audited pages control the strings we echo back: rule messages, snippets, page
// titles, meta values, URLs. A raw ESC (0x1b) in any of those is executed by the
// terminal, not displayed. `ESC[2J ESC[1;1H` clears the screen and homes the
// cursor, which is enough to blank real findings and repaint forged ones.
//
// JSON, HTML and Markdown output already escape these as a side effect of their
// own encoding. The console, text and llm outputs do not, which is what this is
// for.

/**
 * C0 controls (0x00-0x1F) minus tab and newline, plus DEL (0x7F).
 *
 * TAB and LF are kept because report output is legitimately laid out with them.
 * CR is NOT kept: on its own it returns the cursor to column zero, letting
 * page content overwrite a line that was already printed. Dropping it from a
 * CRLF pair leaves the LF, so ordinary text is unaffected.
 */
const C0_EXCEPT_TAB_LF = /[\x00-\x08\x0b-\x1f\x7f]/g;

/**
 * Strip terminal control characters from untrusted text.
 *
 * Strips rather than escapes: these characters carry no meaning worth
 * preserving in page-derived content, and a visible `\x1b` escape would just
 * be noise in a finding message.
 */
export function stripControlChars(text: string): string {
  return text.replace(C0_EXCEPT_TAB_LF, "");
}

/**
 * `stripControlChars` for a value that may not be a string.
 *
 * Rendering code interpolates numbers, nulls and undefined freely, so this
 * keeps call sites from having to type-guard before sanitising.
 */
export function stripControlCharsUnknown(value: unknown): unknown {
  return typeof value === "string" ? stripControlChars(value) : value;
}

/**
 * An SGR sequence: `ESC [ <digits and semicolons> m`. This is the only escape
 * the console renderer emits, and it is the only one worth allowing through.
 *
 * SGR sets colour and weight. It cannot move the cursor, clear the screen,
 * rewrite the window title, or drive the clipboard — so page content that
 * happens to carry one can recolour its own text and nothing more. Every other
 * escape (CUP, ED, OSC…) is what makes forged output possible, and is stripped.
 */
const SGR_SEQUENCE = /\x1b\[[0-9;]*m/g;

/**
 * Strip control characters from a line that legitimately contains our own
 * colour codes.
 *
 * Splits on the allowed SGR sequences and strips only the text between them, so
 * formatting survives while page-derived escapes do not. Use this for terminal
 * output; use `stripControlChars` for file and pipe output, which has no
 * business carrying escapes at all.
 */
export function stripControlCharsPreservingSgr(text: string): string {
  let out = "";
  let last = 0;
  // `matchAll` needs the /g flag, which SGR_SEQUENCE has; lastIndex is not
  // shared because matchAll clones the regex internally.
  for (const match of text.matchAll(SGR_SEQUENCE)) {
    const start = match.index ?? 0;
    out += stripControlChars(text.slice(last, start)) + match[0];
    last = start + match[0].length;
  }
  return out + stripControlChars(text.slice(last));
}

/**
 * Everything a one-line cell of untrusted text must not carry: all C0 controls (tab and newline
 * included), DEL, the C1 controls (`U+009B` is an 8-bit CSI that some terminals run as ESC `[`), the invisible characters below,
 * the bidirectional overrides and isolates that reorder what a reader sees (`U+202A` to `U+202E`,
 * `U+2066` to `U+2069`, the marks `U+200E`, `U+200F` and `U+061C`), and the line and paragraph
 * separators. A table cell, a CSV field or a report line built from a page value goes through
 * this first.
 */
const UNSAFE_LINE_TEXT = new RegExp(
  "[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]",
  "g",
);

/**
 * Characters that draw nothing, so a value can carry text a reader cannot see: the zero-width
 * space, the word joiner, the deprecated formatting characters and the invisible math operators,
 * the BOM, the soft hyphen, the combining grapheme joiner, the Hangul and Khmer fillers, the
 * Mongolian free variation selectors and vowel separator, the interlinear annotation marks, the
 * musical formatting characters, the Unicode tag block (invisible ASCII, used to smuggle
 * instructions to a model) and the supplementary variation selectors (the same trick, one byte
 * per selector). They are removed, not replaced by a space, so a word they sat inside stays one
 * word. The zero-width joiner and non-joiner and the basic variation selectors (`U+FE00` to
 * `U+FE0F`, which make an emoji an emoji) stay: scripts and emoji need them.
 */
const INVISIBLE_SOURCE =
  "[\\u00ad\\u034f\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180f\\u200b\\u2060-\\u2064\\u206a-\\u206f\\u3164\\ufeff\\uffa0\\ufff9-\\ufffb\\u{1d173}-\\u{1d17a}\\u{e0000}-\\u{e007f}\\u{e0100}-\\u{e01ef}]";
const INVISIBLE_TEXT = new RegExp(INVISIBLE_SOURCE, "gu");

/**
 * `text` as one safe line: each unsafe character becomes `replacement` (a space by default, so
 * words a newline separated stay apart). Unlike {@link stripControlChars} it also removes C1
 * controls and bidirectional overrides, and it removes newlines and tabs too.
 *
 * Every character is judged on its own, in one pass per class, never by matching an escape
 * sequence: an input that nests or splits one (`ESC ESC [`, an ESC with an invisible character
 * between it and `[`) cannot leave an ESC or a C1 control behind, because each of those characters
 * is removed wherever it stands. What is left of an escape is plain text (`[2J`), which a
 * terminal prints and does not run.
 */
export function stripUnsafeLineText(text: string, replacement = " "): string {
  return text.replace(INVISIBLE_TEXT, "").replace(UNSAFE_LINE_TEXT, replacement);
}

/** Every character {@link stripUnsafeLineText} acts on, plus the joiners it leaves: what JSON output escapes. */
const JSON_UNSAFE = new RegExp(
  `${INVISIBLE_SOURCE.slice(0, -1)}\\u007f-\\u009f\\u061c\\u200c-\\u200f\\u2028-\\u202e\\u2066-\\u2069]`,
  "gu",
);

/**
 * JSON text with every character `JSON.stringify` leaves raw but a terminal or a reader treats
 * specially written as a `\\uXXXX` escape (a surrogate pair for the tag block and the variation
 * selector supplement). Lossless: it is the same JSON value, and safe to print to a terminal.
 */
export function escapeJsonUnsafe(json: string): string {
  return json.replace(JSON_UNSAFE, (ch) => {
    const code = ch.codePointAt(0) ?? 0;
    const unit = (n: number) => `\\u${n.toString(16).padStart(4, "0")}`;
    if (code <= 0xffff) return unit(code);
    const offset = code - 0x10000;
    return unit(0xd800 + (offset >> 10)) + unit(0xdc00 + (offset & 0x3ff));
  });
}
