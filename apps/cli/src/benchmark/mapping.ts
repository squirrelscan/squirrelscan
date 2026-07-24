/**
 * Lighthouse audit to SquirrelScan rule mapping
 *
 * null = browser-required (skip)
 * [] = not covered
 * string[] = mapped rules
 */

export const LIGHTHOUSE_TO_SQUIRRELSCAN: Record<string, string[] | null> = {
  // === SEO ===
  "document-title": ["core/meta-title"],
  "meta-description": ["core/meta-description"],
  "link-text": ["a11y/link-text"],
  "is-crawlable": ["crawl/indexability"],
  "robots-txt": ["crawl/robots-txt"],
  hreflang: ["i18n/hreflang"],
  canonical: ["core/canonical"],
  "structured-data-automatic": ["schema/json-ld-valid"],
  "tap-targets": ["a11y/touch-targets"],
  "font-size": ["mobile/font-size"],
  viewport: ["mobile/viewport"],
  plugins: [], // Flash/Java plugins - obsolete

  // === Accessibility (55+ rules) ===
  // Color and visual
  "color-contrast": ["a11y/color-contrast"],

  // Navigation and structure
  "heading-order": ["a11y/heading-order"],
  bypass: ["a11y/skip-link"],
  tabindex: ["a11y/tabindex"],
  accesskeys: ["a11y/accesskeys"],

  // Language
  "html-has-lang": ["i18n/lang-attribute"],
  "html-lang-valid": ["a11y/html-lang-valid"],
  "valid-lang": ["a11y/valid-lang"],
  "html-xml-lang-mismatch": ["a11y/html-xml-lang-mismatch"],

  // Images
  "image-alt": ["images/alt-text"],
  "input-image-alt": ["a11y/input-image-alt"],
  "image-redundant-alt": ["a11y/image-redundant-alt"],
  "object-alt": ["a11y/object-alt"],

  // Buttons and links
  "button-name": ["a11y/button-name"],
  "link-name": ["a11y/link-text"],
  "duplicate-id-active": ["a11y/duplicate-id-active"],
  "duplicate-id-aria": ["a11y/duplicate-id-aria"],
  "identical-links-same-purpose": ["a11y/identical-links-same-purpose"],
  "link-in-text-block": ["a11y/link-in-text-block"],

  // Forms
  "form-field-multiple-labels": ["a11y/form-field-multiple-labels"],
  "input-button-name": ["a11y/button-name"],
  label: ["a11y/form-labels"],
  "select-name": ["a11y/select-name"],

  // ARIA attributes
  "aria-allowed-attr": ["a11y/aria-allowed-attr"],
  "aria-command-name": ["a11y/aria-command-name"],
  "aria-dialog-name": ["a11y/aria-dialog-name"],
  "aria-hidden-body": ["a11y/aria-hidden-body"],
  "aria-hidden-focus": ["a11y/aria-hidden-focus"],
  "aria-input-field-name": ["a11y/aria-input-field-name"],
  "aria-meter-name": ["a11y/aria-meter-name"],
  "aria-progressbar-name": ["a11y/aria-progressbar-name"],
  "aria-required-attr": ["a11y/aria-required-attr"],
  "aria-required-children": ["a11y/aria-required-children"],
  "aria-required-parent": ["a11y/aria-required-parent"],
  "aria-roles": ["a11y/aria-roles"],
  "aria-toggle-field-name": ["a11y/aria-toggle-field-name"],
  "aria-tooltip-name": ["a11y/aria-tooltip-name"],
  "aria-treeitem-name": ["a11y/aria-treeitem-name"],
  "aria-valid-attr-value": ["a11y/aria-valid-attr-value"],
  "aria-text": ["a11y/aria-text"],
  "aria-valid-attr": ["a11y/aria-valid-attr"],
  "aria-conditional-attr": [], // New LH rule - not yet implemented

  // Lists
  "definition-list": ["a11y/definition-list"],
  dlitem: ["a11y/dlitem"],
  list: ["a11y/list-structure"],
  listitem: ["a11y/listitem"],

  // Tables
  "td-headers-attr": ["a11y/td-headers-attr"],
  "th-has-data-cells": ["a11y/th-has-data-cells"],
  "table-duplicate-name": ["a11y/table-duplicate-name"],

  // Frames
  "frame-title": ["a11y/frame-title"],

  // Landmarks
  landmark: ["a11y/landmark-regions"],
  "landmark-one-main": ["a11y/landmark-one-main"],

  // Meta and page-level
  "meta-refresh": ["a11y/meta-refresh"],
  "meta-viewport": ["a11y/zoom-disabled"],

  // Headings
  "empty-heading": ["a11y/empty-heading"],

  // Video/audio
  "video-caption": ["a11y/video-captions"],
  "audio-caption": [], // Not yet implemented

  // Other a11y
  "label-content-name-mismatch": ["a11y/label-content-name-mismatch"],
  "focus-traps": null, // Browser required - needs user interaction
  "focusable-controls": null, // Browser required
  "interactive-element-affordance": null, // Browser required
  "logical-tab-order": null, // Browser required
  "managed-focus": null, // Browser required
  "offscreen-content-hidden": null, // Browser required
  "use-landmarks": ["a11y/landmark-regions"],
  "visual-order-follows-dom": null, // Browser required

  // === Best Practices ===
  "is-on-https": ["security/https"],
  doctype: ["core/doctype"],
  charset: ["core/charset"],
  "csp-xss": ["security/csp"],
  "js-libraries": ["perf/js-libraries"],
  "no-vulnerable-libraries": ["perf/js-libraries"], // Same check, different severity
  "password-inputs-can-be-pasted-into": ["a11y/paste-inputs"],
  "image-aspect-ratio": ["images/dimensions"],
  "image-size-responsive": ["images/responsive-size"],
  deprecations: null, // Browser required - console API
  "errors-in-console": null, // Browser required
  "geolocation-on-start": null, // Browser required
  "notification-on-start": null, // Browser required
  "inspector-issues": null, // Browser required
  // Note: LH checks for MISSING source maps (debugging), SS checks for EXPOSED maps (security).
  // Semantically opposite concerns - not a meaningful mapping.
  "valid-source-maps": [],

  // === Performance (static analysis only) ===
  "dom-size": ["perf/dom-size"],
  "render-blocking-resources": ["perf/render-blocking"],
  "unminified-css": ["perf/unminified-css"],
  "unminified-javascript": ["perf/unminified-js"],
  "uses-text-compression": ["perf/compression"],
  "uses-http2": ["perf/http2"],
  "total-byte-weight": ["perf/total-byte-weight"],
  "uses-long-cache-ttl": ["perf/cache-headers"],
  "uses-optimized-images": ["images/optimized"],
  "uses-webp-images": ["images/modern-format"],
  "uses-responsive-images": ["images/srcset"],
  "offscreen-images": ["images/offscreen-lazy"],
  "unsized-images": ["images/dimensions"],
  "preload-lcp-image": ["perf/lcp-hints"],
  "lcp-lazy-loaded": ["perf/lazy-above-fold"],
  "prioritize-lcp-image": ["perf/lcp-hints"],
  "uses-rel-preconnect": ["perf/preconnect"],
  "font-display": ["perf/font-loading"],
  "duplicated-javascript": ["perf/duplicate-js"],
  "legacy-javascript": ["perf/legacy-js"],
  "third-party-summary": [], // Aggregation - not 1:1 rule
  "third-party-facades": [], // Third party optimization - not covered
  "script-treemap-data": null, // Browser required - runtime bundle analysis
  "efficient-animated-content": ["perf/animated-content"],
  "unused-css-rules": null, // Browser required - runtime CSS coverage
  "unused-javascript": null, // Browser required - runtime JS coverage

  // CWV metrics - all browser required
  "first-contentful-paint": null,
  "largest-contentful-paint": null,
  "cumulative-layout-shift": null,
  "total-blocking-time": null,
  "speed-index": null,
  interactive: null,
  "max-potential-fid": null,
  "server-response-time": ["perf/ttfb"],
  "mainthread-work-breakdown": null,
  "bootup-time": null,
  "network-requests": null,
  "network-rtt": null,
  "network-server-latency": null,
  "critical-request-chains": ["perf/critical-request-chains"],
  redirects: ["crawl/redirect-chain", "links/redirect-chains"],
  "user-timings": null,
  "layout-shift-elements": null,
  "long-tasks": null,
  "non-composited-animations": null,

  // PWA - not in scope
  "service-worker": null,
  "installable-manifest": null,
  "themed-omnibox": null,
  "splash-screen": null,
  "maskable-icon": null,
  "content-width": null, // PWA viewport
  "apple-touch-icon": [], // Could add
  pwa: null,
};

// Categories for grouping
export const LH_CATEGORIES: Record<string, string[]> = {
  SEO: [
    "document-title",
    "meta-description",
    "link-text",
    "is-crawlable",
    "robots-txt",
    "hreflang",
    "canonical",
    "structured-data-automatic",
    "tap-targets",
    "font-size",
    "viewport",
    "plugins",
  ],
  Accessibility: [
    "color-contrast",
    "heading-order",
    "bypass",
    "tabindex",
    "accesskeys",
    "html-has-lang",
    "html-lang-valid",
    "valid-lang",
    "html-xml-lang-mismatch",
    "image-alt",
    "input-image-alt",
    "image-redundant-alt",
    "object-alt",
    "button-name",
    "link-name",
    "duplicate-id-active",
    "duplicate-id-aria",
    "identical-links-same-purpose",
    "link-in-text-block",
    "form-field-multiple-labels",
    "input-button-name",
    "label",
    "select-name",
    "aria-allowed-attr",
    "aria-command-name",
    "aria-dialog-name",
    "aria-hidden-body",
    "aria-hidden-focus",
    "aria-input-field-name",
    "aria-meter-name",
    "aria-progressbar-name",
    "aria-required-attr",
    "aria-required-children",
    "aria-required-parent",
    "aria-roles",
    "aria-toggle-field-name",
    "aria-tooltip-name",
    "aria-treeitem-name",
    "aria-text",
    "aria-valid-attr-value",
    "aria-valid-attr",
    "definition-list",
    "dlitem",
    "list",
    "listitem",
    "td-headers-attr",
    "th-has-data-cells",
    "table-duplicate-name",
    "frame-title",
    "landmark",
    "landmark-one-main",
    "meta-refresh",
    "meta-viewport",
    "empty-heading",
    "video-caption",
    "label-content-name-mismatch",
  ],
  "Best Practices": [
    "is-on-https",
    "doctype",
    "charset",
    "csp-xss",
    "js-libraries",
    "no-vulnerable-libraries",
    "password-inputs-can-be-pasted-into",
    "image-aspect-ratio",
    "image-size-responsive",
    "valid-source-maps",
  ],
  Performance: [
    "dom-size",
    "render-blocking-resources",
    "unminified-css",
    "unminified-javascript",
    "uses-text-compression",
    "uses-http2",
    "total-byte-weight",
    "uses-long-cache-ttl",
    "uses-optimized-images",
    "uses-webp-images",
    "uses-responsive-images",
    "offscreen-images",
    "unsized-images",
    "preload-lcp-image",
    "lcp-lazy-loaded",
    "prioritize-lcp-image",
    "uses-rel-preconnect",
    "font-display",
    "duplicated-javascript",
    "legacy-javascript",
    "efficient-animated-content",
    "server-response-time",
    "critical-request-chains",
    "redirects",
  ],
};
