/**
 * Escaping for text the audited site controls on its way into the Markdown
 * report (squirrelscan/repo#3522): page URLs, item labels, a partial audit's
 * reason, a detected version. One module, so a link label, a plain value and a
 * link destination are escaped the same way at every sink.
 */

/**
 * Backslash-escaped in text: what could open or close a link or image
 * (`[ ] ( ) !`), a code span (backtick), raw HTML or an autolink (`< >`), an
 * entity (`&`, so `&#x5D;` renders as typed) or a table cell (`|`), and the
 * backslash itself, so a value cannot undo an escape.
 */
const TEXT_SPECIALS = new Set(["\\", "[", "]", "(", ")", "!", "`", "<", ">", "&", "|"]);

/**
 * Percent-encoded in a link destination: `( )` and whitespace end it, `< >`
 * open raw HTML or a pointy destination, a backtick can pair into a code span
 * that swallows the link, and `[ ]` and `\` go too for good measure.
 */
const DESTINATION_SPECIALS = new Set(["\\", "(", ")", "<", ">", "`", "[", "]"]);

function escapeSpecials(value: string): string {
  let out = "";
  for (const char of value) out += TEXT_SPECIALS.has(char) ? `\\${char}` : char;
  return out;
}

/**
 * A site-controlled value as inline Markdown text, as link text or on its own.
 * Every escaped character is ASCII punctuation, a valid CommonMark escape that
 * renders as itself. Line breaks collapse to one space, so a value cannot end a
 * list item early, and a leading block marker (`#`, `-`, `+`, `*`, `_`, `~`,
 * `=`, `1.`) is escaped, so a value after a `- ` cannot open a heading, a rule,
 * a fence or a nested list. Elsewhere `*`, `_` and `~` are left alone: they can
 * only emphasise, and URL paths full of underscores are read raw by agents.
 */
export function escapeMarkdownText(value: string): string {
  return escapeSpecials(value.replace(/\s+/g, " "))
    .replace(/^( ?)([#+\-*_~=])/, "$1\\$2")
    .replace(/^( ?)(\d+)([.)])/, "$1$2\\$3");
}

/**
 * A site-controlled value as a Markdown table cell: escaped like
 * {@link escapeMarkdownText}, with each line break as a `<br>` so a multi-line
 * value stays in its cell.
 */
export function escapeMarkdownCell(value: string): string {
  return value.split(/\r\n|\r|\n/).map(escapeSpecials).join("<br>");
}

/**
 * A site-controlled value inside raw HTML (`<summary>`, an `alt` attribute).
 * Line breaks collapse to one space: a blank line would end the HTML block,
 * and whatever followed would parse as Markdown again.
 */
export function escapeHtmlText(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * A URL as a Markdown link destination. `!` is left alone: it is inert in a
 * destination, and RFC 3986 does not treat `%21` as the same URL. Control
 * characters and spaces are encoded with the specials. An `&` that would read
 * as an entity (`&amp;`, `&#41;`) is backslash-escaped so the href keeps it as
 * typed; a query's plain `&` separators are left readable.
 */
export function escapeMarkdownDestination(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    out +=
      DESTINATION_SPECIALS.has(char) || code <= 0x20 || code === 0x7f
        ? `%${code.toString(16).toUpperCase().padStart(2, "0")}`
        : char;
  }
  // After the loop, so this backslash is not itself percent-encoded.
  return out.replace(/&(?=#?[0-9A-Za-z]+;)/g, "\\&");
}

/** An http(s) URL, or a root-relative path (not a protocol-relative `//host`). */
function isLinkable(url: string): boolean {
  if (url.startsWith("/")) return !url.startsWith("//");
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * `[label](url)`, both escaped, for an http(s) URL or a root-relative path;
 * the escaped label alone for anything else, so a `javascript:` or `data:` URL
 * in a stored report never becomes a link.
 */
export function markdownLink(label: string, url: string): string {
  const text = escapeMarkdownText(label);
  return isLinkable(url) ? `[${text}](${escapeMarkdownDestination(url)})` : text;
}

/**
 * A site-controlled value as a code span: fenced by one more backtick than the
 * longest run inside it, so nothing in it can close the span early.
 */
export function markdownCodeSpan(value: string): string {
  const flat = value.replace(/\s+/g, " ");
  const longest = Math.max(0, ...Array.from(flat.matchAll(/`+/g), (m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = flat.startsWith("`") || flat.endsWith("`") ? " " : "";
  return `${fence}${pad}${flat}${pad}${fence}`;
}
