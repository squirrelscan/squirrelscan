// Path prefix extraction for breadth-first crawling
// Used to track and throttle URLs per site section

/**
 * Extract top-level path prefix from URL
 * /news/2024/article -> /news
 * /about -> /about
 * / -> /
 */
export function getPathPrefix(url: string): string {
  try {
    const parsedUrl = new URL(url);
    const path = parsedUrl.pathname;

    // Root path
    if (path === "/" || path === "") {
      return "/";
    }

    // Get first path segment
    const segments = path.split("/").filter(Boolean);
    if (segments.length === 0) {
      return "/";
    }

    return `/${segments[0]}`;
  } catch {
    return "/";
  }
}

/**
 * Group URLs by their top-level prefix
 */
export function groupByPrefix(urls: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();

  for (const url of urls) {
    const prefix = getPathPrefix(url);
    const existing = groups.get(prefix) ?? [];
    existing.push(url);
    groups.set(prefix, existing);
  }

  return groups;
}
