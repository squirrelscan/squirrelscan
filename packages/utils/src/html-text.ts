export interface HtmlTextOptions {
  /** Element bodies that are not visible or useful for the caller. */
  exclude?: readonly string[];
}

function findTagEnd(html: string, start: number): number {
  let quote: '"' | "'" | null = null;
  for (let i = start; i < html.length; i++) {
    const char = html[i];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return i;
    }
  }
  return -1;
}

function openingTagName(lowerHtml: string, start: number, end: number): string | null {
  let cursor = start + 1;
  while (cursor < end && /\s/.test(lowerHtml[cursor])) cursor++;
  if (lowerHtml[cursor] === "/" || lowerHtml[cursor] === "!" || lowerHtml[cursor] === "?") {
    return null;
  }
  const nameStart = cursor;
  while (cursor < end) {
    const code = lowerHtml.charCodeAt(cursor);
    const valid =
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      lowerHtml[cursor] === "-" ||
      lowerHtml[cursor] === ":";
    if (!valid) break;
    cursor++;
  }
  return cursor > nameStart ? lowerHtml.slice(nameStart, cursor) : null;
}

function findClosingTagEnd(lowerHtml: string, html: string, tag: string, start: number): number {
  const prefix = `</${tag}`;
  let cursor = start;
  while (cursor < html.length) {
    const closeStart = lowerHtml.indexOf(prefix, cursor);
    if (closeStart < 0) return html.length;
    const boundary = lowerHtml[closeStart + prefix.length];
    if (
      boundary === ">" ||
      boundary === " " ||
      boundary === "\t" ||
      boundary === "\n" ||
      boundary === "\r"
    ) {
      const closeEnd = findTagEnd(html, closeStart + prefix.length);
      return closeEnd < 0 ? html.length : closeEnd + 1;
    }
    cursor = closeStart + prefix.length;
  }
  return html.length;
}

/**
 * Strip comments, tags, and selected element bodies in linear passes. This is
 * intentionally an approximate text extractor for hot paths that do not need a
 * DOM; it avoids backtracking regexes on hostile or malformed response bodies.
 */
export function stripHtmlForText(html: string, options: HtmlTextOptions = {}): string {
  const excluded = new Set((options.exclude ?? []).map((tag) => tag.toLowerCase()));
  const lowerHtml = html.toLowerCase();
  const parts: string[] = [];
  let cursor = 0;

  while (cursor < html.length) {
    const tagStart = html.indexOf("<", cursor);
    if (tagStart < 0) {
      parts.push(html.slice(cursor));
      break;
    }
    if (tagStart > cursor) parts.push(html.slice(cursor, tagStart));

    if (lowerHtml.startsWith("<!--", tagStart)) {
      const commentEnd = lowerHtml.indexOf("-->", tagStart + 4);
      cursor = commentEnd < 0 ? html.length : commentEnd + 3;
      parts.push(" ");
      continue;
    }

    const tagEnd = findTagEnd(html, tagStart + 1);
    if (tagEnd < 0) {
      parts.push(html.slice(tagStart));
      break;
    }

    const tagName = openingTagName(lowerHtml, tagStart, tagEnd);
    cursor =
      tagName && excluded.has(tagName)
        ? findClosingTagEnd(lowerHtml, html, tagName, tagEnd + 1)
        : tagEnd + 1;
    parts.push(" ");
  }

  return parts.join("");
}
