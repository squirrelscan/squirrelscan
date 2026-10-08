import type { Document } from "linkedom";

import { querySelectorAllOutsideNoscript } from "@squirrelscan/utils";

const FONT_EXTENSION = /\.(?:woff2?|ttf|otf|eot)(?:[?#]|$)/i;
const FONT_FACE_BLOCK = /@font-face\s*\{([^}]*)\}/gi;
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi;

/**
 * Absolute URLs of the font files a page references directly: `<link
 * rel="preload" as="font">` and the `url()` sources of `@font-face` rules in
 * inline `<style>` blocks. Fonts that only an external stylesheet declares are
 * not found, because stylesheet bodies are not fetched. Inline sources keep
 * only woff/woff2/ttf/otf/eot files, so an SVG font or a `local()` source is
 * ignored. Resolved against `baseUrl`, de-duplicated, in document order.
 */
export function extractFontUrls(doc: Document, baseUrl: string): string[] {
  const found = new Set<string>();
  const add = (raw: string | null | undefined): void => {
    const value = raw?.trim();
    if (!value || value.startsWith("data:")) return;
    try {
      found.add(new URL(value, baseUrl).toString());
    } catch {
      // Ignore invalid URLs
    }
  };

  for (const link of querySelectorAllOutsideNoscript(doc, "link[href]")) {
    const rel = (link.getAttribute("rel") || "").toLowerCase().split(/\s+/);
    if (rel.includes("preload") && link.getAttribute("as")?.toLowerCase() === "font") {
      add(link.getAttribute("href"));
    }
  }

  for (const style of querySelectorAllOutsideNoscript(doc, "style")) {
    const css = style.textContent || "";
    for (const block of css.matchAll(FONT_FACE_BLOCK)) {
      for (const source of (block[1] ?? "").matchAll(CSS_URL)) {
        const url = source[1] ?? source[2] ?? source[3] ?? "";
        if (FONT_EXTENSION.test(url)) add(url);
      }
    }
  }

  return [...found];
}
