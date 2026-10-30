// The pages the CLI's loopback server shows during `squirrel auth login`
// (squirrelscan/squirrelscan#1286): one branded shell for the success page and
// the pending, expired and already-used ones.
//
// Self-contained on purpose: the server has no assets to serve and the page
// must work offline, so the mark is inline SVG, the type is the brand stack
// with system fallbacks (nothing is fetched), and the styles are one inline
// block. A Content-Security-Policy meta pins that down: nothing loads from
// anywhere, and the one inline script (when a page has one) runs only because
// its hash is listed, so markup injected into the page could not run script.

import { createHash } from "node:crypto";

/**
 * Escape a string for interpolation into the callback page HTML. The email
 * comes from the API response: almost certainly benign, but never trust
 * interpolated input even on a 127.0.0.1-only page.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The 8-bit squirrel (the brand mark, apps/web/public/brand/logo-mark.svg). */
const MASCOT_SVG = `<svg class="mascot" viewBox="0 0 32 32" width="56" height="56" fill="none" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" aria-hidden="true" focusable="false">
    <rect x="2" y="4" width="4" height="4" fill="#8B4513" />
    <rect x="2" y="8" width="4" height="4" fill="#8B4513" />
    <rect x="4" y="12" width="4" height="4" fill="#8B4513" />
    <rect x="6" y="16" width="4" height="4" fill="#A0522D" />
    <rect x="2" y="0" width="4" height="4" fill="#A0522D" />
    <rect x="10" y="12" width="4" height="4" fill="#A0522D" />
    <rect x="14" y="12" width="4" height="4" fill="#A0522D" />
    <rect x="10" y="16" width="4" height="4" fill="#CD853F" />
    <rect x="14" y="16" width="4" height="4" fill="#CD853F" />
    <rect x="18" y="16" width="4" height="4" fill="#A0522D" />
    <rect x="10" y="20" width="4" height="4" fill="#CD853F" />
    <rect x="14" y="20" width="4" height="4" fill="#DEB887" />
    <rect x="18" y="20" width="4" height="4" fill="#CD853F" />
    <rect x="18" y="8" width="4" height="4" fill="#A0522D" />
    <rect x="22" y="8" width="4" height="4" fill="#A0522D" />
    <rect x="18" y="12" width="4" height="4" fill="#CD853F" />
    <rect x="22" y="12" width="4" height="4" fill="#CD853F" />
    <rect x="26" y="12" width="4" height="4" fill="#A0522D" />
    <rect x="24" y="10" width="2" height="2" fill="#000000" />
    <rect x="20" y="4" width="4" height="4" fill="#A0522D" />
    <rect x="24" y="6" width="2" height="2" fill="#DEB887" />
    <rect x="10" y="24" width="4" height="4" fill="#8B4513" />
    <rect x="18" y="24" width="4" height="4" fill="#8B4513" />
    <rect x="26" y="18" width="4" height="4" fill="#8B4513" />
    <rect x="28" y="16" width="2" height="2" fill="#228B22" />
  </svg>`;

/**
 * Colours are the design system's cream and muted green (hex, so every browser
 * reads them), each pairing checked at WCAG AA or better. The mascot sits on a
 * cream tile in both themes: it is drawn for light backgrounds.
 */
const STYLES = `
    :root {
      color-scheme: light dark;
      --bg: #f6f4ee;
      --card: #fffdf9;
      --fg: #2b2823;
      --muted: #5c574d;
      --border: #ddd8cb;
      --code-bg: #f3f0e8;
      --primary: #2e7a3c;
      --on-primary: #ffffff;
      --accent: #a5470f;
      --tile: #f6f4ee;
      --tile-border: #ddd8cb;
      --grid: rgba(214, 210, 201, 0.3);
      --focus: #2e7a3c;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #16140f;
        --card: #201d17;
        --fg: #efece4;
        --muted: #b0aa9d;
        --border: #38342b;
        --code-bg: #16140f;
        --primary: #6fcf84;
        --on-primary: #10200f;
        --accent: #f0a070;
        --grid: rgba(239, 236, 228, 0.06);
        --tile: #2c2820;
        --tile-border: #4b4538;
        --focus: #6fcf84;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 20px;
      padding: 24px 16px;
      color: var(--fg);
      background-color: var(--bg);
      background-image:
        linear-gradient(to right, var(--grid) 1px, transparent 1px),
        linear-gradient(to bottom, var(--grid) 1px, transparent 1px);
      background-size: 8px 8px;
      font-family: "JetBrains Mono", "Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      line-height: 1.6;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .tile {
      display: grid;
      place-items: center;
      width: 68px;
      height: 68px;
      background: var(--tile);
      border: 1px solid var(--tile-border);
      border-radius: 4px;
    }
    .mascot { display: block; image-rendering: pixelated; }
    main {
      width: 100%;
      max-width: 560px;
      padding: 28px 24px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 4px;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin: 0 0 14px;
      font-size: 13px;
      font-weight: 600;
      color: var(--primary);
    }
    .pill.problem { color: var(--accent); }
    h1 {
      text-wrap: balance;
      margin: 0 0 8px;
      font-size: 26px;
      line-height: 1.25;
      letter-spacing: -0.02em;
    }
    p { margin: 0 0 10px; color: var(--muted); font-size: 15px; }
    p strong { color: var(--fg); font-weight: 600; overflow-wrap: anywhere; }
    .agent {
      margin-top: 24px;
      padding-top: 20px;
      border-top: 1px solid var(--border);
    }
    .agent h2 { margin: 0 0 6px; font-size: 16px; }
    .agent p { font-size: 14px; }
    .agent code {
      display: block;
      margin-top: 12px;
      padding: 12px;
      font-family: inherit;
      font-size: 13px;
      line-height: 1.5;
      color: var(--fg);
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      overflow-wrap: anywhere;
      user-select: all;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 12px 16px;
      margin-top: 12px;
    }
    .actions button {
      font: inherit;
      font-size: 14px;
      font-weight: 600;
      color: var(--on-primary);
      background: var(--primary);
      border: 0;
      border-radius: 4px;
      padding: 9px 16px;
      cursor: pointer;
    }
    .actions button:hover { filter: brightness(1.08); }
    .actions a {
      font: inherit;
      font-size: 14px;
      font-weight: 600;
      color: var(--primary);
      text-decoration: none;
      border: 1px solid var(--primary);
      border-radius: 4px;
      padding: 8px 16px;
    }
    .actions a:hover { background: var(--code-bg); }
    .glyph { width: 20px; height: 20px; flex: none; }
    .status { font-size: 13px; color: var(--muted); }
    a:focus-visible, button:focus-visible {
      outline: 2px solid var(--focus);
      outline-offset: 2px;
    }
    .hint { margin-top: 4px; font-size: 13px; }
    code.inline {
      font-family: inherit;
      color: var(--fg);
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 1px 6px;
    }
    @media (max-width: 420px) {
      main { padding: 22px 16px; }
      h1 { font-size: 22px; }
    }
    @media (prefers-reduced-motion: reduce) {
      * { transition: none !important; animation: none !important; }
    }
  `;

/** Small pixel glyphs (5x5 grid, one colour) that tell the pages apart at a glance. */
const GLYPHS = {
  check: [
    [0, 3],
    [1, 4],
    [2, 3],
    [3, 2],
    [4, 1],
  ],
  hourglass: [
    [0, 0],
    [1, 0],
    [2, 0],
    [3, 0],
    [4, 0],
    [1, 1],
    [3, 1],
    [2, 2],
    [1, 3],
    [3, 3],
    [0, 4],
    [1, 4],
    [2, 4],
    [3, 4],
    [4, 4],
  ],
  lock: [
    [1, 0],
    [2, 0],
    [3, 0],
    [1, 1],
    [3, 1],
    [0, 2],
    [1, 2],
    [2, 2],
    [3, 2],
    [4, 2],
    [0, 3],
    [2, 3],
    [4, 3],
    [0, 4],
    [1, 4],
    [2, 4],
    [3, 4],
    [4, 4],
  ],
  dots: [
    [0, 2],
    [2, 2],
    [4, 2],
  ],
} as const;

export type CallbackGlyph = keyof typeof GLYPHS;

function glyphSvg(name: CallbackGlyph): string {
  // [column, row] cells of a 5x5 grid.
  const rects = GLYPHS[name]
    .map(([x, y]) => `<rect x="${x}" y="${y}" width="1" height="1" />`)
    .join("");
  return `<svg class="glyph" viewBox="0 0 5 5" fill="currentColor" shape-rendering="crispEdges" aria-hidden="true" focusable="false">${rects}</svg>`;
}

export interface CallbackPage {
  /** The document title. A constant: never interpolate untrusted text. */
  title: string;
  /** The markup inside <main>. The caller escapes anything it interpolates. */
  body: string;
  /** An inline script, run only under its hash. Absent: no script runs. */
  script?: string;
  /** The pill's glyph, so each state reads differently at a glance. */
  glyph?: CallbackGlyph;
  /** The pill's text. */
  pill: string;
  /** The pill is a problem (orange) rather than a success state (green). */
  problem?: boolean;
  /** Adds a one second reload (the waiting page polls with it). */
  refresh?: boolean;
}

/** The CSP the pages ship: nothing loads, and only the page's own script runs. */
export function callbackPageCsp(script?: string): string {
  const scriptSrc = script
    ? `'sha256-${createHash("sha256").update(script).digest("base64")}'`
    : "'none'";
  return [
    "default-src 'none'",
    `script-src ${scriptSrc}`,
    "style-src 'unsafe-inline'",
    "img-src data:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/** One page in the brand shell: mark and wordmark, then the card. */
export function renderCallbackShell(page: CallbackPage): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Content-Security-Policy" content="${callbackPageCsp(page.script)}">${
    page.refresh ? '\n  <meta http-equiv="refresh" content="1">' : ""
  }
  <title>${page.title}</title>
  <style>${STYLES}</style>
</head>
<body>
  <header class="brand">
    <span class="tile">${MASCOT_SVG}</span>
    <span>squirrelscan</span>
  </header>
  <main>
    <p class="pill${page.problem ? " problem" : ""}">${glyphSvg(page.glyph ?? "dots")}${page.pill}</p>
${page.body}
  </main>${page.script ? `\n  <script>${page.script}</script>` : ""}
</body>
</html>
`;
}

/**
 * The headers every response from the loopback server carries. The CSP here
 * adds `frame-ancestors 'none'`, which a meta CSP cannot carry; the page's meta
 * policy and this one agree on everything else, so the script hash is the same.
 */
export function callbackResponseHeaders(
  options: { script?: string; contentType?: string } = {}
): Record<string, string> {
  return {
    "Content-Type": options.contentType ?? "text/html; charset=utf-8",
    "Content-Security-Policy": `${callbackPageCsp(options.script)}; frame-ancestors 'none'`,
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  };
}
