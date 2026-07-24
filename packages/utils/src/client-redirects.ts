// Client-side redirect detection (meta refresh, JavaScript)

/**
 * Find client-side redirects in HTML content
 * Detects:
 * - Meta refresh: <meta http-equiv="refresh" content="0;url=...">
 * - JavaScript: window.location = "...", window.location.href = "..."
 */
export function findClientRedirects(
  html: string,
  baseUrl: string
): string | null {
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
  // Match meta tag with http-equiv="refresh" (attributes in any order)
  const metaTagRegex = /<meta\s+([^>]*http-equiv=["']refresh["'][^>]*)>/gi;
  const metaTags = html.matchAll(metaTagRegex);

  for (const metaMatch of metaTags) {
    // Extract content attribute value from the matched tag
    const contentRegex = /content=["']([^"']+)["']/i;
    const contentMatch = contentRegex.exec(metaMatch[1]);
    if (contentMatch) {
      // Parse the content value: "0;url=..."
      const urlRegex = /(\d+)\s*;\s*url=([^"';]+)/i;
      const urlMatch = urlRegex.exec(contentMatch[1]);
      if (urlMatch?.[2]) {
        try {
          // Resolve relative URLs
          return new URL(urlMatch[2].trim(), baseUrl).toString();
        } catch {
          // Invalid URL, continue to next match
          continue;
        }
      }
    }
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
