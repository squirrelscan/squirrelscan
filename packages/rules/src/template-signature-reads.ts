// The keyed-able reads of the rules that declare a template verdict scope: the
// selectors and attribute names a DERIVED fan-out signature (#1373) would cover.
//
// This is the MIDDLE OPTION from the #1373 decision. Whole-document reads
// (`page.html`, `textContent`, `innerHTML`, helper hand-offs) cannot be keyed
// without fragmenting every cluster, so they stay reviewed UNKEYED entries in
// `tests/template-verdict-inputs.test.ts`. Selectors and attributes can be keyed, so
// a declared rule that reads one outside these lists fails that test: the list
// is the thing to extend, and the derived signature (a bench-only measurement,
// see audit-engine `template-signature-coverage.ts`) follows it.
//
// NOTHING IN PRODUCTION READS THESE LISTS. `fanoutInputSignature` is unchanged.

/** Selectors read by declared rules, plus the bare elements the signature walks. */
export const SIGNATURE_SELECTORS: readonly string[] = [
  "body",
  "head",
  "html",
  "iframe",
  "iframe[src]",
  "img",
  "img[src]",
  "link[href]",
  'link[rel*="icon"]',
  'link[rel="dns-prefetch"]',
  'link[rel="preconnect"]',
  'link[rel="prefetch"]',
  'link[rel="preload"]',
  'link[rel="stylesheet"]',
  'link[rel="stylesheet"]:not([media="print"])',
  'link[rel~="stylesheet"]',
  'link[rel~="stylesheet"][href]',
  'main, [role="main"]',
  "meta",
  "meta[name='viewport']",
  'meta[name="ICBM"]',
  'meta[name="geo.placename"]',
  'meta[name="geo.position"]',
  'meta[name="geo.region"]',
  'meta[name="viewport"]',
  "script",
  "script:not([src])",
  "script[nomodule]",
  "script[src]",
  "script[src], link[href], img[src]",
  'script[type="module"]',
  "style",
];

/** Attribute names read by declared rules (and the meta names the signature carries today). */
export const SIGNATURE_ATTRIBUTES: readonly string[] = [
  "aria-hidden",
  "async",
  "charset",
  "class",
  "content",
  "defer",
  "height",
  "href",
  "http-equiv",
  "id",
  "integrity",
  "lang",
  "language",
  "media",
  "name",
  "nomodule",
  "property",
  "rel",
  "src",
  "style",
  "type",
  "width",
  "xml:lang",
];
