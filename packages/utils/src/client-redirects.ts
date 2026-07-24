// Client-side redirect detection (meta refresh, JavaScript)

/**
 * Find client-side redirects in HTML content
 * Detects:
 * - Meta refresh: <meta http-equiv="refresh" content="0;url=...">
 * - JavaScript: window.location = "...", window.location.href = "..."
 */
export function findClientRedirects(html: string, baseUrl: string): string | null {
  // 1. Check for meta refresh
  const metaRefresh = findMetaRefresh(html, baseUrl);
  if (metaRefresh) return metaRefresh;

  // 2. Check for JavaScript redirect
  const jsRedirect = findJavaScriptRedirect(html, baseUrl);
  if (jsRedirect) return jsRedirect;

  return null;
}

/**
 * Find meta refresh redirect
 * Examples:
 * <meta http-equiv="refresh" content="0;url=https://example.com">
 * <meta content="5; url=https://example.com" http-equiv="refresh">
 * <meta name="viewport" content="0;url=..." http-equiv="refresh">
 */
function findMetaRefresh(html: string, baseUrl: string): string | null {
  for (const tag of findStartTags(html, "meta")) {
    if (getAttribute(tag, "http-equiv")?.toLowerCase() !== "refresh") continue;
    const content = getAttribute(tag, "content");
    if (!content) continue;

    const separator = content.indexOf(";");
    if (separator < 0 || !isAsciiDigits(content.slice(0, separator).trim())) continue;
    const directive = content.slice(separator + 1);
    const equals = directive.indexOf("=");
    if (equals < 0 || directive.slice(0, equals).trim().toLowerCase() !== "url") continue;
    const target = directive.slice(equals + 1).trim();
    if (!target) continue;
    try {
      return new URL(target, baseUrl).toString();
    } catch {
      // Invalid URL, continue to the next tag.
    }
  }

  return null;
}

function isAsciiDigits(value: string): boolean {
  if (!value) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

function findStartTags(html: string, tagName: string): string[] {
  const lower = html.toLowerCase();
  const prefix = `<${tagName}`;
  const tags: string[] = [];
  let cursor = 0;

  while (cursor < html.length) {
    const start = lower.indexOf(prefix, cursor);
    if (start < 0) break;
    const boundary = lower[start + prefix.length];
    if (
      boundary &&
      boundary !== " " &&
      boundary !== "\t" &&
      boundary !== "\n" &&
      boundary !== "\r" &&
      boundary !== "/" &&
      boundary !== ">"
    ) {
      cursor = start + prefix.length;
      continue;
    }

    let quote: '"' | "'" | null = null;
    let end = start + prefix.length;
    for (; end < html.length; end++) {
      const char = html[end];
      if (quote) {
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === ">") {
        break;
      }
    }
    if (end >= html.length) break;
    tags.push(html.slice(start, end + 1));
    cursor = end + 1;
  }

  return tags;
}

function getAttribute(tag: string, attributeName: string): string | null {
  let cursor = 1;
  while (cursor < tag.length && !/\s/.test(tag[cursor]) && tag[cursor] !== ">") cursor++;
  while (cursor < tag.length) {
    while (/\s/.test(tag[cursor] ?? "")) cursor++;
    if (tag[cursor] === ">" || tag[cursor] === "/" || cursor >= tag.length) break;
    const nameStart = cursor;
    while (cursor < tag.length && !/[\s=>/]/.test(tag[cursor])) cursor++;
    const name = tag.slice(nameStart, cursor).toLowerCase();
    while (/\s/.test(tag[cursor] ?? "")) cursor++;
    if (tag[cursor] !== "=") {
      while (cursor < tag.length && !/\s/.test(tag[cursor]) && tag[cursor] !== ">") cursor++;
      continue;
    }
    cursor++;
    while (/\s/.test(tag[cursor] ?? "")) cursor++;
    const quote = tag[cursor] === '"' || tag[cursor] === "'" ? tag[cursor++] : null;
    const valueStart = cursor;
    if (quote) {
      while (cursor < tag.length && tag[cursor] !== quote) cursor++;
    } else {
      while (cursor < tag.length && !/[\s>]/.test(tag[cursor])) cursor++;
    }
    const value = tag.slice(valueStart, cursor);
    if (name === attributeName) return value;
    if (quote && tag[cursor] === quote) cursor++;
  }
  return null;
}

/**
 * Find JavaScript redirect
 * Detects patterns like:
 * - window.location = "url"
 * - window.location.href = "url"
 * - window.location.replace("url")
 * - location.href = "url"
 */
function findJavaScriptRedirect(html: string, baseUrl: string): string | null {
  // Match window.location.href = 'url' or window.location = 'url'
  // Looking for the pattern we saw: window.location.href = 'https://www.gymshark.com' + ...
  const patterns = [
    // window.location.href = "url" (with possible concatenation)
    /window\.location\.href\s*=\s*['"]([^'"]+)['"]/i,
    // window.location = "url"
    /window\.location\s*=\s*['"]([^'"]+)['"]/i,
    // window.location.replace("url")
    /window\.location\.replace\s*\(\s*['"]([^'"]+)['"]\s*\)/i,
    // location.href = "url"
    /(?:^|[^a-z])location\.href\s*=\s*['"]([^'"]+)['"]/i,
    // location = "url"
    /(?:^|[^a-z])location\s*=\s*['"]([^'"]+)['"]/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      try {
        // Filter out relative paths and pathname-only redirects
        const urlPart = match[1];

        // If it starts with http:// or https://, it's absolute
        if (urlPart.startsWith("http://") || urlPart.startsWith("https://")) {
          return new URL(urlPart).toString();
        }

        // If it's a relative path, resolve against base
        // But skip if it's just a pathname (common pattern is to redirect within same site)
        if (urlPart.startsWith("/")) {
          return new URL(urlPart, baseUrl).toString();
        }
      } catch {
        // Invalid URL, continue
      }
    }
  }

  return null;
}
