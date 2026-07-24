// Extract external script references from HTML

import type { Document } from "linkedom";

import { getHostname } from "@squirrelscan/utils";

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
  const scripts = doc.querySelectorAll("script[src]");

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
