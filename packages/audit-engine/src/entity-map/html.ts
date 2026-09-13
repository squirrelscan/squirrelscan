// Standalone HTML document for an entity map (#2061/#2091).
//
// The same viewer the HTML report embeds, wrapped in a complete page. The
// markup, styles and script all come from `@squirrelscan/report` so the two
// surfaces cannot drift; this file only supplies the document around them.
//
// One self-contained file: no network requests, no CDN, no build step.

// Subpath, not the package root: the root re-exports the JSX report renderer
// and this package does not compile with `--jsx`.
import {
  ENTITY_VIEWER_STYLES,
  entityViewerData,
  entityViewerMarkup,
  entityViewerScript,
} from "@squirrelscan/report/entities-viewer";
import type { EntityMap } from "@squirrelscan/core-contracts/entity-map";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Page chrome around the shared viewer. The viewer brings its own scoped CSS. */
const PAGE_STYLES = `
body {
  margin: 0;
  background: #f7f7f5;
  color: #1c1c1a;
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.em-wrap { max-width: 1180px; margin: 0 auto; padding: 28px 20px 64px; }
h1 { font-size: 20px; margin: 0 0 4px; letter-spacing: -0.01em; }
#em-header { word-break: break-all; margin: 0 0 20px; }
`;

/**
 * Render a standalone, offline HTML view of an entity map.
 *
 * Returns a complete document. Nothing is fetched at runtime and the map is the
 * page's only data source.
 */
export function renderEntityMapHtml(map: EntityMap): string {
  const title = `Entity map: ${map.site}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${PAGE_STYLES}${ENTITY_VIEWER_STYLES}</style>
</head>
<body>
<div class="em-wrap">
  <h1>Entity map</h1>
${entityViewerMarkup(true)}
</div>

<script type="application/json" id="em-data">${entityViewerData(map)}</script>
<script>${entityViewerScript()}</script>
</body>
</html>
`;
}
