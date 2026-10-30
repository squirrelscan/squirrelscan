// Re-export from @squirrelscan/utils
import { redactUrl } from "@squirrelscan/core-contracts/seed-redirect";
import { parseUserUrl } from "@squirrelscan/utils/url";

export * from "@squirrelscan/utils/url";

/**
 * The start URL as typed, safe to print or log: normalised like the crawl sees it
 * (`example.com` becomes `https://example.com/`), then userinfo, query and fragment removed.
 */
export function redactStartUrl(raw: string): string {
  const parsed = parseUserUrl(raw);
  return redactUrl(parsed.ok ? parsed.url : raw);
}
