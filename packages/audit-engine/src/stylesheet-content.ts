// Stylesheet bodies for rules (repo#1374): the shape `ctx.site.stylesheets` carries.

import type { StylesheetContentData } from "@squirrelscan/rules";
import type { ScriptFetchResult } from "./script-fetcher";

/**
 * One entry per stylesheet requested. `content` is set only for a CSS body that was
 * read in full; a skipped, refused, oversized, failed or HTML (soft-404) response
 * yields an entry with no `content`, never a throw.
 */
export function toStylesheetContentData(fetch: ScriptFetchResult): StylesheetContentData {
  const readable = fetch.content !== null && !/html/i.test(fetch.contentType ?? "");
  return readable ? { url: fetch.url, content: fetch.content as string } : { url: fetch.url };
}
