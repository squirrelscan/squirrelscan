// The page map as one standalone HTML table (#701): sortable by any column, filterable by text and
// by flag. No network request, no CDN: the file is opened from disk and sent around. The rows come
// from audited pages, so they reach the page as escaped JSON and reach the DOM only through
// `textContent`.

import { escapeEntityJsonForScript } from "./entities-viewer";
import { cleanText, type PageMapMeta, type PageMapRow } from "./page-map";

/** Rows inlined in the page: a browser parses all of it before drawing, so the file is bounded. */
export const PAGE_MAP_HTML_ROW_CAP = 5_000;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLES = `
:root { color-scheme: light dark; --bg: #f7f7f5; --panel: #fff; --ink: #1c1c1a; --muted: #6b6b64; --line: #e2e2dc; --accent: #2b5fd9; --warn: #b3541e; }
@media (prefers-color-scheme: dark) { :root { --bg: #151514; --panel: #1e1e1c; --ink: #ecece8; --muted: #9a9a92; --line: #33332f; --accent: #7aa2ff; --warn: #e08a52; } }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.pm-wrap { max-width: 1480px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 20px; margin: 0 0 4px; letter-spacing: -0.01em; }
.pm-sub { color: var(--muted); margin: 0 0 16px; word-break: break-all; }
.pm-controls { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
.pm-controls input, .pm-controls select { font: inherit; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--ink); }
.pm-controls input { flex: 1 1 260px; min-width: 0; }
.pm-count { color: var(--muted); margin: 0 0 8px; }
.pm-scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { position: sticky; top: 0; background: var(--panel); cursor: pointer; white-space: nowrap; user-select: none; }
th[aria-sort="ascending"]::after { content: " \\25B2"; color: var(--accent); }
th[aria-sort="descending"]::after { content: " \\25BC"; color: var(--accent); }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
td.url { word-break: break-all; min-width: 220px; }
td.text { min-width: 200px; max-width: 360px; }
.pm-flag { display: inline-block; margin: 0 4px 2px 0; padding: 0 6px; border: 1px solid var(--line); border-radius: 999px; color: var(--warn); font-size: 12px; white-space: nowrap; }
.pm-note { color: var(--muted); margin-top: 12px; }
`;

const SCRIPT = `
(function () {
  var data = JSON.parse(document.getElementById("pm-data").textContent);
  var rows = data.rows;
  var cols = [
    ["url", "URL", "url"], ["status", "Status", "num"], ["title", "Title", "text"], ["titleLength", "Len", "num"],
    ["description", "Description", "text"], ["descriptionLength", "Len", "num"], ["h1Count", "H1", "num"],
    ["wordCount", "Words", "num"], ["schemaTypes", "Schema", "text"], ["inlinks", "In", "num"],
    ["internalOutlinks", "Out", "num"], ["externalOutlinks", "Ext", "num"], ["flags", "Flags", "text"]
  ];
  var sortKey = null, sortDir = 1;
  var q = document.getElementById("pm-q"), flagSel = document.getElementById("pm-flag");
  var thead = document.getElementById("pm-head"), tbody = document.getElementById("pm-body");
  var count = document.getElementById("pm-count");
  var flags = {};
  rows.forEach(function (r) { r.flags.forEach(function (f) { flags[f] = true; }); });
  Object.keys(flags).sort().forEach(function (f) {
    var o = document.createElement("option"); o.value = f; o.textContent = f; flagSel.appendChild(o);
  });
  function cellValue(r, key) {
    var v = r[key];
    if (Array.isArray(v)) return v.join(", ");
    return v === null || v === undefined ? "" : v;
  }
  cols.forEach(function (c) {
    var th = document.createElement("th"); th.textContent = c[1]; th.dataset.key = c[0];
    th.addEventListener("click", function () {
      if (sortKey === c[0]) sortDir = -sortDir; else { sortKey = c[0]; sortDir = 1; }
      render();
    });
    thead.appendChild(th);
  });
  function render() {
    var text = q.value.trim().toLowerCase(), flag = flagSel.value;
    var list = rows.filter(function (r) {
      if (flag && r.flags.indexOf(flag) < 0) return false;
      if (!text) return true;
      return (r.url + " " + (r.title || "") + " " + (r.description || "") + " " + r.flags.join(" ")).toLowerCase().indexOf(text) >= 0;
    });
    if (sortKey) {
      list = list.slice().sort(function (a, b) {
        var x = cellValue(a, sortKey), y = cellValue(b, sortKey);
        if (typeof x === "number" && typeof y === "number") return (x - y) * sortDir;
        x = String(x).toLowerCase(); y = String(y).toLowerCase();
        return (x < y ? -1 : x > y ? 1 : 0) * sortDir;
      });
    }
    Array.prototype.forEach.call(thead.children, function (th) {
      if (th.dataset.key === sortKey) th.setAttribute("aria-sort", sortDir > 0 ? "ascending" : "descending");
      else th.removeAttribute("aria-sort");
    });
    tbody.textContent = "";
    list.forEach(function (r) {
      var tr = document.createElement("tr");
      cols.forEach(function (c) {
        var td = document.createElement("td"); td.className = c[2];
        if (c[0] === "flags") {
          r.flags.forEach(function (f) { var s = document.createElement("span"); s.className = "pm-flag"; s.textContent = f; td.appendChild(s); });
        } else td.textContent = String(cellValue(r, c[0]));
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    count.textContent = list.length === data.total ? data.total + " pages" : list.length + " of " + data.total + " pages";
  }
  q.addEventListener("input", render);
  flagSel.addEventListener("change", render);
  render();
})();
`;

/**
 * The rows as a complete HTML document. At most {@link PAGE_MAP_HTML_ROW_CAP} rows are inlined;
 * the page says so when more matched, and `total` stays the audit's real page count.
 */
export function renderPageMapHtml(rows: readonly PageMapRow[], meta: PageMapMeta): string {
  const shown = rows.slice(0, PAGE_MAP_HTML_ROW_CAP);
  const payload = escapeEntityJsonForScript(
    JSON.stringify({
      total: meta.total,
      rows: shown.map((row) => ({
        // Cleaned: the viewer shows these as text, and a bidi override or an escape in a URL or
        // title would reorder or smuggle what a reader sees.
        url: cleanText(row.url),
        status: row.status,
        title: row.title === null ? null : cleanText(row.title),
        titleLength: row.titleLength,
        description: row.description === null ? null : cleanText(row.description),
        descriptionLength: row.descriptionLength,
        h1Count: row.h1Count,
        wordCount: row.wordCount,
        schemaTypes: row.schemaTypes.map(cleanText),
        inlinks: row.inlinks,
        internalOutlinks: row.internalOutlinks,
        externalOutlinks: row.externalOutlinks,
        flags: row.flags.map(cleanText),
      })),
    }),
  );
  const cut =
    rows.length > shown.length
      ? `<p class="pm-note">Showing the first ${shown.length} of ${rows.length} matching pages. Use <code>-f csv</code> or <code>-f json</code> for all of them.</p>`
      : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(`Page map: ${cleanText(meta.site)}`)}</title>
<style>${STYLES}</style>
</head>
<body>
<div class="pm-wrap">
  <h1>Page map</h1>
  <p class="pm-sub">${escapeHtml(cleanText(meta.site))} &middot; audit ${escapeHtml(cleanText(meta.crawlId.slice(0, 8)))}</p>
  <div class="pm-controls">
    <input id="pm-q" type="search" placeholder="Filter by URL, title, description or flag" aria-label="Filter pages">
    <select id="pm-flag" aria-label="Filter by flag"><option value="">Any flag</option></select>
  </div>
  <p class="pm-count" id="pm-count" aria-live="polite"></p>
  <div class="pm-scroll"><table><thead><tr id="pm-head"></tr></thead><tbody id="pm-body"></tbody></table></div>
  ${cut}
</div>
<script type="application/json" id="pm-data">${payload}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
