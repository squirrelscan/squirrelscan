// Extract external script references from HTML

import type { Document } from "linkedom";

import { getHostname, querySelectorAllOutsideNoscript } from "@squirrelscan/utils";

export interface ScriptRef {
  src: string;
  async: boolean;
  defer: boolean;
  module: boolean;
}

/**
 * Extract external script URLs from a document.
 * Only returns scripts with src attribute (not inline scripts).
 */
export function extractScripts(doc: Document, baseUrl: string): ScriptRef[] {
  const results: ScriptRef[] = [];
  // A <script> inside <noscript> never runs or loads (#434).
  const scripts = querySelectorAllOutsideNoscript(doc, "script[src]");

  for (const script of scripts) {
    const src = script.getAttribute("src");
    if (!src) continue;

    // Skip data: URLs
    if (src.startsWith("data:")) continue;

    // Resolve relative URLs
    let resolved: string;
    try {
      resolved = new URL(src, baseUrl).toString();
    } catch {
      continue;
    }

    results.push({
      src: resolved,
      async: script.hasAttribute("async"),
      defer: script.hasAttribute("defer"),
      module: script.getAttribute("type") === "module",
    });
  }

  return results;
}

/**
 * Check if a script URL is same-domain as the base URL.
 * Used to filter out third-party scripts.
 */
export function isSameDomainScript(
  scriptUrl: string,
  baseHost: string
): boolean {
  const scriptHost = getHostname(scriptUrl).toLowerCase();
  if (!scriptHost) return false;

  // Exact match or subdomain match
  return scriptHost === baseHost || scriptHost.endsWith(`.${baseHost}`);
}

/**
 * Script files a page preloads without a `<script src>`: `<link rel="modulepreload">`
 * and `<link rel="preload" as="script">`. A bundler's lazy chunks are named only
 * here, so the audit fetches them too (security/csp-blocks-own-resources reads
 * the third-party URLs inside). Resolved against `baseUrl`, deduplicated.
 */
export function extractPreloadedScriptUrls(doc: Document, baseUrl: string): string[] {
  const found = new Set<string>();
  for (const link of querySelectorAllOutsideNoscript(doc, "link[href]")) {
    const rel = (link.getAttribute("rel") || "").toLowerCase().split(/\s+/);
    const isScript =
      rel.includes("modulepreload") ||
      (rel.includes("preload") && link.getAttribute("as")?.toLowerCase() === "script");
    const href = link.getAttribute("href")?.trim();
    if (!isScript || !href || href.startsWith("data:")) continue;
    try {
      found.add(new URL(href, baseUrl).toString());
    } catch {
      // Ignore invalid URLs
    }
  }
  return [...found];
}
