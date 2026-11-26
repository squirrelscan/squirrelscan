// Single definition of "is this the root page", shared by the featurizer (urlIsRoot) and the
// rules fallback so training/export features and inference agree. Kept in its own module because
// rules-fallback imports from featurize.

const ROOT_DOCUMENT_PATH = "/index.html";

/**
 * Query parameters that make `/?...` a different document from the home page: WordPress-style
 * permalinks and search (`/?p=123`, `/?page_id=7`, `/?s=shoes`, `/?cat=3`). Tracking parameters
 * (`utm_*`, `fbclid`, ...) are not in the list, so `/?utm_source=x` is still the home page
 * (repo#3363).
 */
const CONTENT_QUERY_KEYS: ReadonlySet<string> = new Set([
  "p",
  "page_id",
  "attachment_id",
  "s",
  "cat",
  "tag",
  "m",
  "author",
  "post_type",
]);

/** True for "/", an empty path and the root `/index.html` document, unless the query selects other
 *  content (see CONTENT_QUERY_KEYS). Exported because
 *  predict.ts applies the homepage rule ahead of the model, not only as a fallback. */
export function isRootPath(url: string): boolean {
  try {
    // The platform parser normalizes backslashes for special schemes before
    // exposing the path, matching how browsers interpret those URLs. The query and
    // the fragment are not part of the path.
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (path !== "/" && path !== ROOT_DOCUMENT_PATH) return false;
    for (const key of parsed.searchParams.keys()) {
      if (CONTENT_QUERY_KEYS.has(key)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
