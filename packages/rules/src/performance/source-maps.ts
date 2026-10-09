// performance/source-maps - Validate source map availability
// Detects exposed source maps that could reveal source code

import type { ScriptContentData } from "@squirrelscan/core-contracts";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { PUBLISH_LIMITS } from "@squirrelscan/core-contracts/limits";
import { querySelectorAllOutsideNoscript, resolveUrl } from "@squirrelscan/utils";

import { sharedRegex } from "../shared-regex";
const NOTE =
  "Source maps may expose original source code. Verify these URLs are not publicly accessible.";

// A shared-bundle finding lists every map of its bundles up to the size a
// published report keeps anyway; past that, `additional` carries the rest.
const MAX_SHARED_ITEMS = PUBLISH_LIMITS.maxItems;

// Map paths named in a shared-bundle message. The message is what report
// grouping keys on, so it has to name the group; the items carry the rest.
const MAX_MESSAGE_MAPS = 3;

interface FoundMap {
  url: string;
  source: string;
  /**
   * Every crawled page that loads a script exposing this map, when that is
   * more than one page (`ctx.site.scripts[].sourcePages`, over all scripts).
   * Null for a map only this page is known to expose: an inline script or
   * style, a header, or a script no other page loads.
   */
  sharedPages: Set<string> | null;
  /** For a shared map: every script exposing it, site-wide. */
  sharedSources?: Set<string>;
}

// Script URLs an item label names before it counts the rest.
const MAX_LABEL_SOURCES = 3;

const HEADER_SOURCE = " (HTTP header)";

function sharedLabel(map: FoundMap, siteUrl: string): string {
  const sources = [...(map.sharedSources ?? [map.source])].sort();
  const named = sources
    .slice(0, MAX_LABEL_SOURCES)
    .map((s) =>
      s.endsWith(HEADER_SOURCE)
        ? `${displayMapUrl(s.slice(0, -HEADER_SOURCE.length), siteUrl)}${HEADER_SOURCE}`
        : displayMapUrl(s, siteUrl)
    );
  const more = sources.length - named.length;
  return `from ${named.join(", ")}${more > 0 ? `, and ${more} more` : ""}`;
}

const JS_SOURCE_MAP = sharedRegex(/\/\/[#@]\s*sourceMappingURL=(\S+)/g);
interface MapConsumers {
  /** Every crawled page that loads a script exposing the map. */
  pages: Set<string>;
  /** Those scripts, as an item label names them: `script` or `script (HTTP header)`. */
  sources: Set<string>;
}

/**
 * Map URL -> the pages and scripts exposing it, over the whole script
 * inventory, built once per run. A page sees only its own scripts, and two
 * scripts can expose one map, so anything built from what one page sees would
 * differ from page to page, and the pages of one group would stop emitting
 * one identical check.
 */
const mapConsumersCache = new WeakMap<readonly ScriptContentData[], Map<string, MapConsumers>>();

function mapConsumers(scripts: readonly ScriptContentData[]): Map<string, MapConsumers> {
  const cached = mapConsumersCache.get(scripts);
  if (cached) return cached;

  const consumers = new Map<string, MapConsumers>();
  const add = (mapUrl: string, pages: readonly string[], source: string) => {
    let entry = consumers.get(mapUrl);
    if (!entry) consumers.set(mapUrl, (entry = { pages: new Set(), sources: new Set() }));
    for (const page of pages) entry.pages.add(page);
    entry.sources.add(source);
  };
  // Resolved exactly as the page pass below resolves them.
  for (const script of scripts) {
    const pages = script.sourcePages ?? [];
    if (script.sourceMapHeader) {
      const base = script.finalUrl || script.url;
      const mapUrl = resolveUrl(script.sourceMapHeader, base) || script.sourceMapHeader;
      add(mapUrl, pages, `${script.url}${HEADER_SOURCE}`);
    }
    if (script.content) {
      JS_SOURCE_MAP.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = JS_SOURCE_MAP.exec(script.content)) !== null) {
        const mapUrl = match[1];
        if (!mapUrl || mapUrl.startsWith("data:")) continue;
        add(resolveUrl(mapUrl, script.url) || mapUrl, pages, script.url);
      }
    }
  }
  mapConsumersCache.set(scripts, consumers);
  return consumers;
}

/** FNV-1a, as base-26 letters: a short, stable id for a set of map URLs. */
function shortHash(value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let n = h >>> 0;
  let out = "";
  do {
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26);
  } while (n > 0);
  return out;
}

// A name longer than this is cut, with a hash of the whole URL so two long
// names that share a prefix still read differently.
const MAX_MESSAGE_NAME = 120;

/**
 * A URL as a shared-bundle check shows it: everything after the origin when
 * it is the site's own, the whole URL otherwise. Distinct URLs never display
 * alike, which matters because report grouping keys on the message.
 */
function displayMapUrl(mapUrl: string, siteUrl: string): string {
  let shown = mapUrl;
  try {
    const map = new URL(mapUrl);
    if (map.origin === new URL(siteUrl).origin) shown = map.href.slice(map.origin.length);
  } catch {
    // Unparseable: show it as found.
  }
  return shown.length > MAX_MESSAGE_NAME
    ? `${shown.slice(0, MAX_MESSAGE_NAME)}…~${shortHash(mapUrl)}`
    : shown;
}

/**
 * One check per set of shared bundles (repo#2341). Every page that loads the
 * same bundles emits the identical check, so report grouping, which keys on
 * check name and message, shows one finding listing those pages instead of
 * one per page; a section bundle loaded by a subset of pages gets its own.
 * `details.foldKey` keeps the groups apart when a large site's checks are
 * folded into aggregates, which otherwise key on name and status alone.
 */
function sharedBundleChecks(found: FoundMap[], siteUrl: string): CheckResult[] {
  const groups = new Map<string, { pages: Set<string>; maps: FoundMap[] }>();
  for (const map of found) {
    if (!map.sharedPages) continue;
    const key = [...map.sharedPages].sort().join("\n");
    const group = groups.get(key);
    if (group) group.maps.push(map);
    else groups.set(key, { pages: map.sharedPages, maps: [map] });
  }

  const checks: CheckResult[] = [];
  for (const { pages, maps } of groups.values()) {
    // Sorted, so pages that list the bundles in a different order still emit
    // the same message and land in the same finding.
    maps.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
    const named = maps.slice(0, MAX_MESSAGE_MAPS).map((m) => displayMapUrl(m.url, siteUrl));
    const more = maps.length - named.length;
    checks.push({
      name: "source-maps-exposed",
      status: "warn",
      message: `${maps.length} source map(s) exposed by bundles shared across pages: ${named.join(", ")}${more > 0 ? `, and ${more} more` : ""}`,
      items: maps.slice(0, MAX_SHARED_ITEMS).map((m) => ({
        id: m.url,
        label: sharedLabel(m, siteUrl),
      })),
      details: {
        note: NOTE,
        sharedPages: pages.size,
        foldKey: `perf/source-maps:${shortHash(maps.map((m) => m.url).join("\n"))}`,
        ...(maps.length > MAX_SHARED_ITEMS ? { additional: maps.length - MAX_SHARED_ITEMS } : {}),
      },
    });
  }
  return checks;
}

export const sourceMapsRule: Rule = {
  meta: {
    id: "perf/source-maps",
    name: "Source Maps",
    description: "Checks for source map availability and configuration",
    solution:
      "Source maps help debug minified code but can expose source code if publicly accessible. For production: 1) Either remove source maps entirely, 2) Restrict access via server config, or 3) Use 'hidden' source maps uploaded only to error tracking services. Exposed source maps can reveal business logic and security implementations to attackers.",
    category: "perf",
    scope: "page",
    verdictScope: "page",
    severity: "info",
    weight: 3,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    const html = ctx.page.html;
    if (!doc || !html) return { checks: [] };

    const checks: CheckResult[] = [];
    const sourceMapsFound: FoundMap[] = [];
    const inlineSourceMaps: string[] = [];
    const baseUrl = ctx.page.url;

    // Pattern to find sourceMappingURL in JS
    const jsSourceMapPattern = /\/\/[#@]\s*sourceMappingURL=(\S+)/g;
    // Pattern to find sourceMappingURL in CSS
    const cssSourceMapPattern = /\/\*[#@]\s*sourceMappingURL=(\S+)\s*\*\//g;

    // Check scripts for sourceMappingURL comments
    const scripts = querySelectorAllOutsideNoscript(doc, "script");
    for (const script of scripts) {
      const src = script.getAttribute("src");
      const content = script.textContent || "";

      // Check inline script content for source map references
      if (content) {
        // Check for inline data: source maps
        if (content.includes("sourceMappingURL=data:")) {
          inlineSourceMaps.push(src || "inline script");
        }

        // Check for external source map references
        let match: RegExpExecArray | null;
        jsSourceMapPattern.lastIndex = 0;
        while ((match = jsSourceMapPattern.exec(content)) !== null) {
          const mapUrl = match[1];
          if (!mapUrl.startsWith("data:")) {
            const resolvedUrl = resolveUrl(mapUrl, baseUrl);
            sourceMapsFound.push({
              url: resolvedUrl || mapUrl,
              source: src || "inline script",
              sharedPages: null,
            });
          }
        }
      }

      // For external scripts, check if we have content from site.scripts
      // Only infer .map URL if we found sourceMappingURL in the actual content
      if (src && !src.includes("data:") && ctx.site?.scripts) {
        const resolvedSrc = resolveUrl(src, baseUrl);
        if (resolvedSrc) {
          // Find this script in site.scripts to check its content
          const scriptData = ctx.site.scripts.find(
            (s) => s.url === resolvedSrc || s.url === src
          );
          if (scriptData) {
            // A map more than one crawled page loads, through any script, is
            // reported once for all of them.
            const consumers = mapConsumers(ctx.site.scripts);
            const shared = (mapUrl: string) => {
              const entry = consumers.get(mapUrl);
              return entry && entry.pages.size > 1
                ? { sharedPages: entry.pages, sharedSources: entry.sources }
                : { sharedPages: null };
            };

            // Check for SourceMap HTTP header (highest priority)
            if (scriptData.sourceMapHeader) {
              const resolvedMapUrl = resolveUrl(
                scriptData.sourceMapHeader,
                scriptData.finalUrl || resolvedSrc
              );
              sourceMapsFound.push({
                url: resolvedMapUrl || scriptData.sourceMapHeader,
                source: `${src} (HTTP header)`,
                ...shared(resolvedMapUrl || scriptData.sourceMapHeader),
              });
            }

            // Check content for sourceMappingURL comment
            if (scriptData.content) {
              jsSourceMapPattern.lastIndex = 0;
              let contentMatch: RegExpExecArray | null;
              while (
                (contentMatch = jsSourceMapPattern.exec(scriptData.content)) !==
                null
              ) {
                const mapUrl = contentMatch[1];
                if (!mapUrl.startsWith("data:")) {
                  const resolvedMapUrl = resolveUrl(mapUrl, resolvedSrc);
                  sourceMapsFound.push({
                    url: resolvedMapUrl || mapUrl,
                    source: src,
                    ...shared(resolvedMapUrl || mapUrl),
                  });
                } else {
                  inlineSourceMaps.push(src);
                }
              }
            }
          }
        }
      }
    }

    // Check stylesheets for source maps
    const styleElements = querySelectorAllOutsideNoscript(doc, "style");
    for (const style of styleElements) {
      const content = style.textContent || "";
      let match: RegExpExecArray | null;
      cssSourceMapPattern.lastIndex = 0;
      while ((match = cssSourceMapPattern.exec(content)) !== null) {
        const mapUrl = match[1];
        if (!mapUrl.startsWith("data:")) {
          const resolvedUrl = resolveUrl(mapUrl, baseUrl);
          sourceMapsFound.push({
            url: resolvedUrl || mapUrl,
            source: "inline style",
            sharedPages: null,
          });
        } else {
          inlineSourceMaps.push("inline CSS");
        }
      }
    }

    // Note: External stylesheets are not checked for source maps because
    // CSS content is not fetched during the crawl. We only check inline <style> elements above.
    // If CSS content fetching is added in the future, this can be extended.

    // Check for SourceMap header on the page response
    const sourceMapHeader =
      ctx.page.headers["sourcemap"] || ctx.page.headers["x-sourcemap"];
    if (sourceMapHeader) {
      const resolvedUrl = resolveUrl(sourceMapHeader, baseUrl);
      sourceMapsFound.push({
        url: resolvedUrl || sourceMapHeader,
        source: "HTTP header",
        sharedPages: null,
      });
    }

    // Deduplicate by URL. The last sighting keeps its label, as before; a map
    // a shared bundle on this page exposes is a shared one, whatever else
    // also names it. Every sighting of one URL carries the same page set.
    const byUrl = new Map<string, FoundMap>();
    for (const found of sourceMapsFound) {
      const prior = byUrl.get(found.url);
      byUrl.set(
        found.url,
        found.sharedPages || !prior?.sharedPages
          ? found
          : { ...found, sharedPages: prior.sharedPages, sharedSources: prior.sharedSources }
      );
    }
    const uniqueSourceMaps = [...byUrl.values()];
    const pageMaps = uniqueSourceMaps.filter((s) => !s.sharedPages);

    // Report findings - note that we can't verify accessibility without fetching
    // Future enhancement: verify via HEAD request
    if (pageMaps.length > 0) {
      checks.push({
        name: "source-maps-exposed",
        status: "warn",
        message: `${pageMaps.length} potential source map(s) detected`,
        items: pageMaps.slice(0, 10).map((s) => ({
          id: s.url,
          label: `from ${s.source}`,
        })),
        details: {
          note: NOTE,
          ...(pageMaps.length > 10 ? { additional: pageMaps.length - 10 } : {}),
        },
      });
    }
    // Named against the site's base URL, not this page's: pages of one group
    // can sit on different origins (http and https) and must still emit one
    // identical message.
    checks.push(...sharedBundleChecks(uniqueSourceMaps, ctx.site?.baseUrl || baseUrl));

    if (inlineSourceMaps.length > 0) {
      checks.push({
        name: "source-maps-inline",
        status: "warn",
        message: `${inlineSourceMaps.length} inline source map(s) found`,
        items: inlineSourceMaps.slice(0, 3).map((id) => ({ id })),
        details: {
          note: "Inline source maps increase bundle size and expose code",
          ...(inlineSourceMaps.length > 3 ? { additional: inlineSourceMaps.length - 3 } : {}),
        },
      });
    }

    if (uniqueSourceMaps.length === 0 && inlineSourceMaps.length === 0) {
      checks.push({
        name: "source-maps",
        status: "pass",
        message: "No exposed source maps detected",
      });
    }

    return { checks };
  },
};
