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
