// Core Web Vitals static hints checker
import { parseHTML, type Document } from "linkedom";
// Analyzes HTML for performance indicators without runtime measurement

import type { CheckResult, CWVHints } from "@squirrelscan/core-contracts";

import { getHostname } from "@squirrelscan/utils";

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

  // Collect resource hints
  const preloadLinks = doc.querySelectorAll('link[rel="preload"]');
  for (const link of preloadLinks) {
    const href = link.getAttribute("href");
    if (href) hints.preloadTags.push(href);
  }

  const prefetchLinks = doc.querySelectorAll('link[rel="prefetch"]');
  for (const link of prefetchLinks) {
    const href = link.getAttribute("href");
    if (href) hints.prefetchTags.push(href);
  }

  const preconnectLinks = doc.querySelectorAll('link[rel="preconnect"]');
  for (const link of preconnectLinks) {
    const href = link.getAttribute("href");
    if (href) hints.preconnectTags.push(href);
  }

  const dnsPrefetchLinks = doc.querySelectorAll('link[rel="dns-prefetch"]');
  for (const link of dnsPrefetchLinks) {
    const href = link.getAttribute("href");
    if (href) hints.dnsPrefetchTags.push(href);
  }

  // Check for render-blocking resources in <head>
  const headElement = doc.head;
  if (headElement) {
    // Render-blocking stylesheets
    const stylesheets = headElement.querySelectorAll(
      'link[rel="stylesheet"]:not([media="print"])'
    );
    for (const link of stylesheets) {
      const href = link.getAttribute("href");
      if (href && !link.hasAttribute("media")) {
        hints.renderBlockingResources.push(href);
      }
    }

    // Render-blocking scripts (no async/defer)
    const scripts = headElement.querySelectorAll("script[src]");
    for (const script of scripts) {
      const src = script.getAttribute("src");
      if (
        src &&
        !script.hasAttribute("async") &&
        !script.hasAttribute("defer")
      ) {
        hints.renderBlockingResources.push(src);
      }
    }
  }

  // Analyze all scripts
  const allScripts = doc.querySelectorAll("script[src]");
  hints.totalScripts = allScripts.length;

  for (const script of allScripts) {
    const src = script.getAttribute("src");
    if (!src) continue;

    if (script.hasAttribute("async")) {
      hints.asyncScripts++;
    } else if (script.hasAttribute("defer")) {
      hints.deferScripts++;
    } else {
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
  const fontFaces = html.match(/@font-face\s*\{[^}]+\}/g) || [];
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
  const allResources = doc.querySelectorAll(
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
  const images = doc.querySelectorAll("img");
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
  const iframes = doc.querySelectorAll("iframe");
  for (const iframe of iframes) {
    const src = iframe.getAttribute("src");
    const width = iframe.getAttribute("width");
    const height = iframe.getAttribute("height");

    if ((!width || !height) && src) {
      hints.iframesWithoutDimensions.push(src);
    }
  }

  // Check for large images that might be LCP candidates without preload
  const largeImages = doc.querySelectorAll(
    'img:not([loading="lazy"]), img[fetchpriority="high"]'
  );
  const preloadedImages = new Set(
    hints.preloadTags.filter(
      (url) =>
        url.endsWith(".jpg") ||
        url.endsWith(".jpeg") ||
        url.endsWith(".png") ||
        url.endsWith(".webp") ||
        url.endsWith(".avif")
    )
  );

  // First few images are likely LCP candidates
  let imageIndex = 0;
  for (const img of largeImages) {
    if (imageIndex >= 3) break; // Only check first 3

    const src = img.getAttribute("src");
    if (src && !preloadedImages.has(src) && !src.startsWith("data:")) {
      hints.largeImagesWithoutPreload.push(src);
    }
    imageIndex++;
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

export function validateCWVHints(hints: CWVHints): CheckResult[] {
  const checks: CheckResult[] = [];

  // LCP: Large images without preload — report the count, not an image dump
  // (keep in sync with lcp-hints.ts; squirrelscan/squirrelscan#16)
  if (hints.largeImagesWithoutPreload.length > 0) {
    const n = hints.largeImagesWithoutPreload.length;
    checks.push({
      name: "cwv-lcp-preload",
      status: "warn",
      message: `${n} likely-LCP image${n === 1 ? "" : "s"} loaded without preload`,
      value: n,
    });
  }

  // LCP: Render-blocking resources
  if (hints.renderBlockingResources.length > 3) {
    checks.push({
      name: "cwv-render-blocking",
      status: "warn",
      message: `${hints.renderBlockingResources.length} render-blocking resources`,
      items: hints.renderBlockingResources.map((url) => ({ id: url })),
    });
  }

  // LCP: Fonts without font-display
  if (hints.fontsWithoutSwap.length > 0) {
    checks.push({
      name: "cwv-font-display",
      status: "warn",
      message: `${hints.fontsWithoutSwap.length} font(s) without font-display: swap`,
      items: hints.fontsWithoutSwap.map((url) => ({ id: url })),
    });
  }

  // LCP: Missing preconnect
  if (hints.missingPreconnect.length > 0) {
    checks.push({
      name: "cwv-preconnect",
      status: "warn",
      message: `Missing preconnect for ${hints.missingPreconnect.length} CDN(s)`,
      items: hints.missingPreconnect.map((url) => ({ id: url })),
    });
  }

  // CLS: Images without dimensions
  if (hints.imagesWithoutDimensions.length > 0) {
    const severity = hints.imagesWithoutDimensions.length > 5 ? "fail" : "warn";
    checks.push({
      name: "cwv-cls-images",
      status: severity,
      message: `${hints.imagesWithoutDimensions.length} image(s) without width/height (CLS risk)`,
      items: hints.imagesWithoutDimensions.map((url) => ({ id: url })),
    });
  }

  // CLS: Iframes without dimensions
  if (hints.iframesWithoutDimensions.length > 0) {
    checks.push({
      name: "cwv-cls-iframes",
      status: "warn",
      message: `${hints.iframesWithoutDimensions.length} iframe(s) without dimensions`,
      items: hints.iframesWithoutDimensions.map((url) => ({ id: url })),
    });
  }

  // INP: Third-party scripts
  if (hints.thirdPartyScripts.length > 5) {
    checks.push({
      name: "cwv-third-party",
      status: "warn",
      message: `${hints.thirdPartyScripts.length} third-party scripts (may impact INP)`,
      items: hints.thirdPartyScripts.map((url) => ({ id: url })),
    });
  }

  // Script loading analysis
  if (hints.blockingScripts > 3) {
    checks.push({
      name: "cwv-blocking-scripts",
      status: "warn",
      message: `${hints.blockingScripts} blocking scripts (consider async/defer)`,
      value: `${hints.asyncScripts} async, ${hints.deferScripts} defer, ${hints.blockingScripts} blocking`,
    });
  }

  // Resource hints usage
  if (hints.preloadTags.length > 0 || hints.preconnectTags.length > 0) {
    checks.push({
      name: "cwv-resource-hints",
      status: "pass",
      message: "Resource hints in use",
      value: `${hints.preloadTags.length} preload, ${hints.preconnectTags.length} preconnect`,
    });
  }

  return checks;
}
