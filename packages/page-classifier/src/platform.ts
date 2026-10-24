// Site platform from raw HTML, the TypeScript twin of the training-time platform tagger.
//
// Cheap on purpose: lower-cased substring checks over the first 300k code
// points, plus <meta name="generator"> tags in the first 64k. The runtime uses
// the bucket to apply per-platform threshold overrides (the platform guard);
// the same function tagged every training page the guard was computed on, so
// the two must agree.

/** First matching platform wins, except that WooCommerce needs WordPress too. */
export const PLATFORM_MARKERS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["shopify", ["cdn.shopify.com", "shopify.theme", "shopify-section", "myshopify.com"]],
  ["woocommerce", ["woocommerce"]],
  ["wordpress", ["/wp-content/", "/wp-includes/"]],
  ["wix", ["static.wixstatic.com", "wix-bolt"]],
  ["squarespace", ["static1.squarespace.com", "squarespace-cdn.com", "<!-- this is squarespace"]],
  ["webflow", ["data-wf-page", "data-wf-site", "webflow.js", "webflow.com/css"]],
  ["drupal", ["drupal.settings", "drupal-settings-json", "/sites/default/files/"]],
  ["magento", ["magento_", "mage/cookies", "data-mage-init"]],
  ["bigcommerce", [".bigcommerce.com/", "data-stencil", "stencil-utils"]],
  ["ghost", ["ghost-portal", "ghost-search"]],
  ["hubspot", ["hs-sites.com", "hubspotusercontent"]],
  ["joomla", ["/media/jui/"]],
  ["framer", ["framerusercontent.com", "data-framer-"]],
  ["nextjs", ["__next_data__", "/_next/static/"]],
  ["nuxt", ["__nuxt__", "/_nuxt/"]],
  ["astro", ["astro-island", "/_astro/"]],
  ["gatsby", ["___gatsby"]],
];
/** A <meta> tag longer than this is not read: real generator tags are tiny,
 *  and the bound keeps the scan linear on hostile markup. */
export const META_TAG_MAX = 1024;
const GENERATOR_ATTRS = ["name=generator", 'name="generator', "name='generator"] as const;
/** In the Python dict's order. */
const GENERATOR_NAMES: ReadonlyArray<readonly [string, string]> = [
  ["wordpress", "wordpress"],
  ["wix.com", "wix"],
  ["webflow", "webflow"],
  ["drupal", "drupal"],
  ["ghost", "ghost"],
  ["hubspot", "hubspot"],
  ["joomla", "joomla"],
  ["squarespace", "squarespace"],
];
/** The platforms the guard and the reports name; everything else is "custom". */
export const PLATFORM_BUCKETS = [
  "shopify",
  "woocommerce",
  "wordpress",
  "wix",
  "squarespace",
  "webflow",
  "nextjs",
] as const;

/**
 * `<meta ...>` tags (in already lower-cased text) that declare
 * name=generator. An indexOf scan, NOT a regex: the earlier
 * `/<meta[^>]+name=.../` re-scanned to the end of the input for every
 * `<meta` without a closing `>` (O(k*n) on untrusted HTML). Here the next `>`
 * is found once and reused while the scan moves forward (linear overall), and
 * a tag is at most META_TAG_MAX characters from `<meta` to `>`. Semantics
 * otherwise match the old regex: the tag ends at the first `>`, `name=` must
 * follow at least one character after `<meta`, after a match the scan resumes
 * past it.
 */
export function generatorTags(lowered: string): string[] {
  const out: string[] = [];
  let pos = 0;
  let nextGt = -2; // -2: not looked up yet; -1: there is no further `>`
  for (;;) {
    const start = lowered.indexOf("<meta", pos);
    if (start < 0) break;
    if (nextGt !== -1 && nextGt < start + 5) nextGt = lowered.indexOf(">", start + 5);
    const end = nextGt;
    if (end < 0 || end - start > META_TAG_MAX) {
      pos = start + 5;
      continue;
    }
    const tag = lowered.slice(start, end + 1);
    if (GENERATOR_ATTRS.some((attr) => tag.indexOf(attr, 6) >= 0)) {
      out.push(tag);
      pos = end + 1;
    } else {
      pos = start + 5;
    }
  }
  return out;
}

/** Python's `s[:n]` counts code points; a JS slice counts UTF-16 units. */
function codePointPrefix(text: string, n: number): string {
  if (text.length <= n) return text;
  let units = 0;
  for (let points = 0; points < n && units < text.length; points++) {
    const code = text.charCodeAt(units);
    units += code >= 0xd800 && code <= 0xdbff && units + 1 < text.length ? 2 : 1;
  }
  return text.slice(0, units);
}

export function platformOf(html: string): string {
  const head = codePointPrefix(html, 300_000).toLowerCase();
  const hits = new Set<string>();
  for (const [name, markers] of PLATFORM_MARKERS)
    if (markers.some((marker) => head.includes(marker))) hits.add(name);
  for (const tag of generatorTags(codePointPrefix(head, 65_536)))
    for (const [needle, name] of GENERATOR_NAMES) if (tag.includes(needle)) hits.add(name);
  if (hits.has("shopify")) return "shopify";
  if (hits.has("woocommerce") && hits.has("wordpress")) return "woocommerce";
  for (const [name] of PLATFORM_MARKERS) if (hits.has(name) && name !== "woocommerce") return name;
  return "custom";
}

export function platformBucket(platform: string | null | undefined): string {
  return platform && (PLATFORM_BUCKETS as readonly string[]).includes(platform)
    ? platform
    : "custom";
}
