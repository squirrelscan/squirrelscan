// Core Web Vitals static hints checker
// Analyzes HTML for performance indicators without runtime measurement
import type { Document, Element } from "linkedom";

import { parseHTML } from "@squirrelscan/parser/dom";

import type { CWVHints } from "@squirrelscan/core-contracts";

import {
  collectImagePreloadKeys,
  findLcpCandidates,
  isImagePreloaded,
} from "../shared/lcp-candidate";

import {
  getHostname,
  querySelectorAllOutsideNoscript,
  stripNoscriptMarkup,
} from "@squirrelscan/utils";

// perf/lcp-hints counts at most this many eligible LCP candidates.
const MAX_LCP_CANDIDATES = 3;

// Known CDN domains that should have preconnect
const COMMON_CDNS = [
  "cdn.jsdelivr.net",
  "cdnjs.cloudflare.com",
  "unpkg.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "ajax.googleapis.com",
  "code.jquery.com",
  "stackpath.bootstrapcdn.com",
  "maxcdn.bootstrapcdn.com",
  "cdn.cloudflare.com",
  "use.fontawesome.com",
  "kit.fontawesome.com",
  "cdn.tailwindcss.com",
];

// Third-party script domains
const THIRD_PARTY_DOMAINS = [
  "google-analytics.com",
  "googletagmanager.com",
  "facebook.net",
  "connect.facebook.net",
  "twitter.com",
  "platform.twitter.com",
  "linkedin.com",
  "ads.linkedin.com",
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "hotjar.com",
  "clarity.ms",
  "intercom.io",
  "crisp.chat",
  "hubspot.com",
  "hs-scripts.com",
  "segment.com",
  "segment.io",
  "mixpanel.com",
  "amplitude.com",
  "fullstory.com",
  "sentry.io",
  "newrelic.com",
  "nr-data.net",
  "datadoghq.com",
];

// JavaScript MIME type essences (WHATWG MIME Sniffing). A `type` matching one of
// these, or an absent/empty `type`, makes a classic script.
const JS_MIME_TYPES = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
]);

export type ScriptLoading = "blocking" | "async" | "defer" | "inert";

// How a browser loads an external <script src>, following the HTML Standard's
// "prepare the script element" steps. Module scripts defer by default (`async`
// makes them async; `defer` does nothing). `nomodule` classic scripts and
// scripts with any other type (text/plain consent gates, text/partytown,
// data blocks) are never run by a modern browser, so they block nothing (#424).
export function scriptLoading(script: Element): ScriptLoading {
  const typeAttr = script.getAttribute("type");
  const languageAttr = script.getAttribute("language");
  let typeString: string;
  if (typeAttr === "" || (typeAttr === null && !languageAttr)) {
    typeString = "text/javascript";
  } else if (typeAttr !== null) {
    // Only `type` is stripped, and only of ASCII whitespace; `language` is not.
    typeString = typeAttr.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
  } else {
    typeString = `text/${languageAttr}`;
  }
  typeString = typeString.toLowerCase();

  if (JS_MIME_TYPES.has(typeString)) {
    if (script.hasAttribute("nomodule")) return "inert";
    if (script.hasAttribute("async")) return "async";
    if (script.hasAttribute("defer")) return "defer";
    return "blocking";
  }
  if (typeString === "module") {
    return script.hasAttribute("async") ? "async" : "defer";
  }
  return "inert";
}

function emptyCWVHints(): CWVHints {
  return {
    largeImagesWithoutPreload: [],
    renderBlockingResources: [],
    fontsWithoutSwap: [],
    missingPreconnect: [],
    imagesWithoutDimensions: [],
    iframesWithoutDimensions: [],
    largeScripts: [],
    thirdPartyScripts: [],
    preloadTags: [],
    prefetchTags: [],
    preconnectTags: [],
    dnsPrefetchTags: [],
    asyncScripts: 0,
    deferScripts: 0,
    blockingScripts: 0,
    totalScripts: 0,
  };
}

// Compute CWV hints from an already-parsed Document. `html` is used only for the
// @font-face regex (the one thing the DOM walk can't cheaply give us); it is NOT
// re-parsed here. Internal — rules call getCWVHints() so the result is memoized.
function analyzeCWVHints(
  doc: Document,
  html: string,
  pageUrl: string
): CWVHints {
  const pageDomain = getHostname(pageUrl);

  const hints: CWVHints = emptyCWVHints();

  // Every resource below skips <noscript> content: a browser with scripting on
  // never loads what sits in it (#434).

  // Collect resource hints
  const preloadLinks = querySelectorAllOutsideNoscript(doc, 'link[rel="preload"]');
  for (const link of preloadLinks) {
    const href = link.getAttribute("href");
    if (href) hints.preloadTags.push(href);
  }

  const prefetchLinks = querySelectorAllOutsideNoscript(doc, 'link[rel="prefetch"]');
  for (const link of prefetchLinks) {
    const href = link.getAttribute("href");
    if (href) hints.prefetchTags.push(href);
  }

  const preconnectLinks = querySelectorAllOutsideNoscript(doc, 'link[rel="preconnect"]');
  for (const link of preconnectLinks) {
    const href = link.getAttribute("href");
    if (href) hints.preconnectTags.push(href);
  }

  const dnsPrefetchLinks = querySelectorAllOutsideNoscript(doc, 'link[rel="dns-prefetch"]');
  for (const link of dnsPrefetchLinks) {
    const href = link.getAttribute("href");
    if (href) hints.dnsPrefetchTags.push(href);
  }

  // Check for render-blocking resources in <head>
  const headElement = doc.head;
  if (headElement) {
    // Render-blocking stylesheets
    const stylesheets = querySelectorAllOutsideNoscript(
      headElement,
      'link[rel="stylesheet"]:not([media="print"])'
    );
    for (const link of stylesheets) {
      const href = link.getAttribute("href");
      if (href && !link.hasAttribute("media")) {
        hints.renderBlockingResources.push(href);
      }
    }

    // Render-blocking scripts (classic, no async/defer)
    const scripts = querySelectorAllOutsideNoscript(headElement, "script[src]");
    for (const script of scripts) {
      const src = script.getAttribute("src");
      if (src && scriptLoading(script) === "blocking") {
        hints.renderBlockingResources.push(src);
      }
    }
  }

  // Analyze all scripts
  const allScripts = querySelectorAllOutsideNoscript(doc, "script[src]");
  hints.totalScripts = allScripts.length;

  for (const script of allScripts) {
    const src = script.getAttribute("src");
    if (!src) continue;

    const loading = scriptLoading(script);
    if (loading === "async") {
      hints.asyncScripts++;
    } else if (loading === "defer") {
      hints.deferScripts++;
    } else if (loading === "blocking") {
      hints.blockingScripts++;
    }

    // Check for third-party scripts
    try {
      const scriptUrl = new URL(src, pageUrl);
      const scriptDomain = scriptUrl.hostname;

      if (scriptDomain !== pageDomain) {
        const isThirdParty = THIRD_PARTY_DOMAINS.some(
          (domain) =>
            scriptDomain === domain || scriptDomain.endsWith(`.${domain}`)
        );
        if (isThirdParty) {
          hints.thirdPartyScripts.push(src);
        }
      }
    } catch {
      // Invalid URL, skip
    }

    // Track potentially large scripts
    hints.largeScripts.push({ src });
  }

  // Check for fonts without font-display: swap
  const fontFaces = stripNoscriptMarkup(html).match(/@font-face\s*\{[^}]+\}/g) || [];
  for (const fontFace of fontFaces) {
    if (!fontFace.includes("font-display")) {
      // Extract font family name
      const familyMatch = fontFace.match(/font-family:\s*['"]?([^'";\n]+)/);
      hints.fontsWithoutSwap.push(familyMatch?.[1] || "Unknown font");
    }
  }

  // Check for missing preconnect to CDNs
  const externalDomains = new Set<string>();

  // Collect all external domains from resources
  const allResources = querySelectorAllOutsideNoscript(
    doc,
    "script[src], link[href], img[src]"
  );
  for (const resource of allResources) {
    const url = resource.getAttribute("src") || resource.getAttribute("href");
    if (!url) continue;

    try {
      const resourceUrl = new URL(url, pageUrl);
      if (resourceUrl.hostname !== pageDomain) {
        externalDomains.add(resourceUrl.origin);
      }
    } catch {
      // Invalid URL
    }
  }

  // Check which CDNs are missing preconnect
  const preconnectDomains = new Set(
    hints.preconnectTags.map((url) => getHostname(url) || url)
  );

  for (const cdn of COMMON_CDNS) {
    if (externalDomains.has(`https://${cdn}`) && !preconnectDomains.has(cdn)) {
      hints.missingPreconnect.push(cdn);
    }
  }

  // Check images without dimensions (CLS)
  const images = querySelectorAllOutsideNoscript(doc, "img");
  for (const img of images) {
    const src = img.getAttribute("src");
    const width = img.getAttribute("width");
    const height = img.getAttribute("height");
    const style = img.getAttribute("style") || "";

    // Check if dimensions are set via attributes or inline style
    const hasWidthAttr = width && width !== "auto";
    const hasHeightAttr = height && height !== "auto";
    const hasStyleDimensions =
      style.includes("width") && style.includes("height");

    if (!hasWidthAttr && !hasHeightAttr && !hasStyleDimensions && src) {
      hints.imagesWithoutDimensions.push(src);
    }
  }

  // Check iframes without dimensions (CLS)
  const iframes = querySelectorAllOutsideNoscript(doc, "iframe");
  for (const iframe of iframes) {
    const src = iframe.getAttribute("src");
    const width = iframe.getAttribute("width");
    const height = iframe.getAttribute("height");

    if ((!width || !height) && src) {
      hints.iframesWithoutDimensions.push(src);
    }
  }

  // Likely-LCP images without a matching preload. Candidates come from the shared
  // finder perf/lcp-fetchpriority uses; the first few eligible images count.
  const preloadKeys = collectImagePreloadKeys(doc, pageUrl);
  for (const img of findLcpCandidates(doc, MAX_LCP_CANDIDATES)) {
    if (!isImagePreloaded(img, preloadKeys, pageUrl)) {
      // Candidates always have a src (findLcpCandidates skips images without one).
      hints.largeImagesWithoutPreload.push(img.getAttribute("src") as string);
    }
  }

  return hints;
}

// The 6 CWV rules (font-loading, preconnect, render-blocking, lcp/cls/inp-hints)
// derive identical CWVHints from the same page. Compute once and memoize on the
// parsed Document's identity — stable per page, GC'd with it — so the rules share
// one result instead of each re-deriving (and previously re-parsing) it. See #262.
// Keyed on Document identity alone (not pageUrl): a parsed Document maps 1:1 to a
// page/URL in practice, so the document is a sufficient cache key.
const cwvHintsCache = new WeakMap<Document, CWVHints>();

// Shallow-freeze a hints object before it is shared/cached, so a future rule
// reading it can't accidentally push into one of the arrays and silently corrupt
// every other rule's view of the same page.
function freezeHints(hints: CWVHints): CWVHints {
  for (const value of Object.values(hints)) {
    if (Array.isArray(value)) Object.freeze(value);
  }
  Object.freeze(hints);
  return hints;
}

// Null-doc (error) pages can't key the WeakMap above, so the 6 CWV rules each
// re-parse the same html (#309). Bounded memo keyed on (pageUrl, html) — hints
// depend on the page domain, and one error body can serve many URLs.
const NULL_DOC_HINTS_CACHE_MAX = 32;
const nullDocHintsCache = new Map<string, CWVHints>();

function getNullDocHints(html: string, pageUrl: string): CWVHints {
  const key = `${pageUrl} ${html}`;
  const cached = nullDocHintsCache.get(key);
  if (cached) return cached;
  const hints = freezeHints(analyzeCWVHints(parseHTML(html).document, html, pageUrl));
  if (nullDocHintsCache.size >= NULL_DOC_HINTS_CACHE_MAX) {
    const oldest = nullDocHintsCache.keys().next().value; // FIFO eviction
    if (oldest !== undefined) nullDocHintsCache.delete(oldest);
  }
  nullDocHintsCache.set(key, hints);
  return hints;
}

// Returns the page's CWVHints, computing them at most once per page (see the
// cache note above). `html` is still required alongside a non-null `doc` — the
// @font-face regex reads it. The returned object is FROZEN (read-only): it is
// shared across all 6 CWV rules, so callers must not mutate it.
export function getCWVHints(
  doc: Document | null,
  html: string,
  pageUrl: string
): CWVHints {
  if (!doc) {
    // Error pages (4xx/5xx) have no parsed document. An empty/absent body has no
    // CWV signals (and linkedom's doc.head getter throws on a parse of ""); a
    // non-empty error body is parsed once via the bounded null-doc memo (#309).
    if (!html) return freezeHints(emptyCWVHints());
    return getNullDocHints(html, pageUrl);
  }
  const cached = cwvHintsCache.get(doc);
  if (cached) return cached;
  const hints = freezeHints(analyzeCWVHints(doc, html, pageUrl));
  cwvHintsCache.set(doc, hints);
  return hints;
}
