import { CHALLENGE_INTERSTITIAL_MAX_TEXT } from "./providers";
import { tagEnd } from "./views";

function skipElement(lower: string, html: string, tag: string, start: number): number {
  const prefix = `</${tag}`;
  let cursor = start;
  while (cursor < html.length) {
    const close = lower.indexOf(prefix, cursor);
    if (close < 0) return html.length;
    const boundary = lower[close + prefix.length];
    if (boundary === ">" || /\s/.test(boundary ?? "")) {
      return tagEnd(html, close + prefix.length) + 1;
    }
    cursor = close + prefix.length;
  }
  return html.length;
}

/**
 * Approximate visible-text length without backtracking over hostile markup.
 * Stops counting past `limit`, so the result only says "more than limit".
 */
export function visibleTextLength(html: string, limit = CHALLENGE_INTERSTITIAL_MAX_TEXT): number {
  const lower = html.toLowerCase();
  let cursor = 0;
  let length = 0;
  let pendingSpace = false;

  while (cursor < html.length) {
    if (html[cursor] === "<") {
      if (lower.startsWith("<!--", cursor)) {
        const end = lower.indexOf("-->", cursor + 4);
        cursor = end < 0 ? html.length : end + 3;
        pendingSpace = true;
        continue;
      }

      const end = tagEnd(html, cursor + 1);
      let nameStart = cursor + 1;
      while (/\s/.test(lower[nameStart] ?? "")) nameStart++;
      let nameEnd = nameStart;
      while (/[a-z]/.test(lower[nameEnd] ?? "")) nameEnd++;
      const name = lower.slice(nameStart, nameEnd);
      cursor =
        name === "script" || name === "style" ? skipElement(lower, html, name, end + 1) : end + 1;
      pendingSpace = true;
      continue;
    }

    if (html[cursor] === "&") {
      const entityEnd = html.indexOf(";", cursor + 1);
      if (entityEnd > cursor && entityEnd - cursor <= 32) {
        cursor = entityEnd + 1;
        pendingSpace = true;
        continue;
      }
    }

    if (/\s/.test(html[cursor])) {
      pendingSpace = true;
    } else {
      if (pendingSpace && length > 0) length++;
      length++;
      pendingSpace = false;
      if (length > limit) return length;
    }
    cursor++;
  }

  return length;
}
