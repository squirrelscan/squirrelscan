// Web app manifests the pages link, fetched for mobile/web-app-manifest (#710).
//
// Collection reads each page's `<link rel="manifest">` and the theme-color metas
// on the same page, keyed by manifest URL, so a manifest linked from ten pages is
// one entry with ten sources. Fetching then runs once per manifest URL through
// the script fetcher's caps and timeouts (with the body kept whatever its
// content type), and each icon the manifest declares is checked through the
// resource checker so its header yields the real pixel size.
//
// Only same-site manifests and icons are fetched. A manifest or icon on another
// host is never requested, which keeps a page from making the crawler reach
// arbitrary third-party URLs. That holds for redirects too: every hop goes
// through an egress policy that refuses any host outside the site (and, as
// everywhere, link-local and cloud metadata addresses, and private addresses
// for any host but the site's own unless the site itself is private), so a same-site manifest
// that redirects off-site is reported as not checked, never fetched there.

import { Effect } from "effect";

import {
  listWebAppManifestIconUrls,
  type ParsedPage,
  type WebAppManifestData,
  type WebAppManifestPageThemeColor,
} from "@squirrelscan/rules";

import type { EgressPolicy } from "@squirrelscan/utils/public-egress";

import { checkResourceSizes, type ResourceCheckerOptions } from "./resource-checker";
import { fetchScriptContents } from "./script-fetcher";

/** Manifest URLs fetched per site. A site links one; this bounds a template that links many. */
export const WEB_APP_MANIFEST_FETCH_LIMIT = 5;

/** Manifest URL to linking page URL to that page's theme-color metas. */
export type WebAppManifestOccurrences = Map<string, Map<string, WebAppManifestPageThemeColor[]>>;

export function emptyWebAppManifestOccurrences(): WebAppManifestOccurrences {
  return new Map();
}

function relTokens(link: { getAttribute(name: string): string | null }): string[] {
  return (link.getAttribute("rel") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Record one page's manifest links and theme-colors. `isSameSite` decides which
 * resolved manifest URLs are kept; the caller passes the site's host test.
 */
export function absorbWebAppManifestLinks(
  target: WebAppManifestOccurrences,
  page: { url: string; finalUrl?: string; parsed: ParsedPage },
  isSameSite: (url: string) => boolean,
): void {
  const doc = page.parsed.document;
  if (!doc) return;
  // A relative href resolves against the document base: `<base href>` when the
  // page sets one (Angular apps ship `<base href="/">` with a relative manifest
  // link), else the page URL.
  const pageUrl = page.finalUrl ?? page.url;
  let pageBase = pageUrl;
  const baseHref = doc.querySelector("base[href]")?.getAttribute("href")?.trim();
  if (baseHref) {
    try {
      pageBase = new URL(baseHref, pageUrl).toString();
    } catch {
      // An unparseable <base href> is ignored by browsers too.
    }
  }

  const manifestUrls: string[] = [];
  for (const link of Array.from(doc.querySelectorAll("link"))) {
    if (!relTokens(link).includes("manifest")) continue;
    const href = (link.getAttribute("href") ?? "").trim();
    if (!href || href.startsWith("data:")) continue;
    let resolved: string;
    try {
      resolved = new URL(href, pageBase).toString();
    } catch {
      continue;
    }
    if (!/^https?:/i.test(resolved)) continue;
    if (!isSameSite(resolved)) continue;
    manifestUrls.push(resolved);
  }
  if (manifestUrls.length === 0) return;

  const themeColors: WebAppManifestPageThemeColor[] = [];
  for (const meta of Array.from(doc.querySelectorAll("meta"))) {
    if ((meta.getAttribute("name") ?? "").trim().toLowerCase() !== "theme-color") continue;
    const content = (meta.getAttribute("content") ?? "").trim();
    if (!content) continue;
    themeColors.push({ content, media: meta.getAttribute("media") });
  }

  for (const manifestUrl of new Set(manifestUrls)) {
    const pages = target.get(manifestUrl) ?? new Map<string, WebAppManifestPageThemeColor[]>();
    pages.set(page.url, themeColors);
    target.set(manifestUrl, pages);
  }
}

export interface FetchedWebAppManifests {
  manifests: WebAppManifestData[];
  /** Linked manifest URLs past WEB_APP_MANIFEST_FETCH_LIMIT, not fetched. */
  dropped: number;
}

/**
 * Fetch each collected manifest once, then check the icons the bodies declare.
 * Options are the resource checker's (timeouts, caps, budget, headers); the
 * manifest body goes through the script fetcher with its content-type gate off.
 * `egress` holds every hop of both to the site (see the module header).
 */
export function fetchWebAppManifests(
  occurrences: WebAppManifestOccurrences,
  options: Partial<ResourceCheckerOptions>,
  egress: EgressPolicy,
): Effect.Effect<FetchedWebAppManifests, never, never> {
  return Effect.gen(function* () {
    const linked = [...occurrences.keys()].sort();
    const urls = linked.slice(0, WEB_APP_MANIFEST_FETCH_LIMIT);
    const dropped = linked.length - urls.length;
    if (urls.length === 0) return { manifests: [], dropped };

    const bodies = yield* fetchScriptContents(urls, {
      ...options,
      anyContentType: true,
      maxScripts: urls.length,
      egress,
    });
    const bodyByUrl = new Map(bodies.map((body) => [body.url, body]));

    // Icons are checked only on the manifest's own origin (see the module header).
    const iconUrlsByManifest = new Map<string, string[]>();
    const allIcons = new Set<string>();
    for (const url of urls) {
      const content = bodyByUrl.get(url)?.content ?? null;
      const origin = new URL(url).origin;
      const icons = listWebAppManifestIconUrls(content, url).filter(
        (icon) => icon.startsWith("http") && new URL(icon).origin === origin,
      );
      iconUrlsByManifest.set(url, icons);
      for (const icon of icons) allIcons.add(icon);
    }

    const iconChecks =
      allIcons.size > 0
        ? yield* checkResourceSizes([...allIcons], { ...options, readImageHeader: true, egress })
        : [];
    const checkByUrl = new Map(iconChecks.map((check) => [check.url, check]));

    const manifests = urls.map((url): WebAppManifestData => {
      const body = bodyByUrl.get(url);
      const pages = occurrences.get(url) ?? new Map<string, WebAppManifestPageThemeColor[]>();
      const sourcePages = [...pages.keys()].sort();
      return {
        url,
        status: body?.status ?? null,
        error: body?.error ?? (body ? null : "not fetched"),
        ...(body?.rateLimited ? { rateLimited: true } : {}),
        ...(body?.wafBlocked ? { wafBlocked: true } : {}),
        contentType: body?.contentType ?? null,
        content: body?.content ?? null,
        sourcePages,
        themeColorsByPage: Object.fromEntries(
          sourcePages.map((page) => [page, pages.get(page) ?? []]),
        ),
        icons: (iconUrlsByManifest.get(url) ?? []).map((iconUrl) => {
          const check = checkByUrl.get(iconUrl);
          return {
            url: iconUrl,
            status: check?.status ?? null,
            error: check ? check.error : "not fetched",
            naturalWidth: check?.naturalWidth ?? null,
            naturalHeight: check?.naturalHeight ?? null,
            ...(check?.rateLimited ? { rateLimited: true } : {}),
            ...(check?.wafBlocked ? { wafBlocked: true } : {}),
          };
        }),
      };
    });
    return { manifests, dropped };
  });
}
