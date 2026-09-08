// Template cluster key (#1949) — the equality reduction of a page's chrome
// fingerprint, stored on `page_features.template_fp` and grouped by
// `SiteQuery.templateClusters()`.
//
// WHY AN EQUALITY KEY AND NOT THE FINGERPRINT ITSELF. `integrity/template-
// discontinuity` compares `PageFingerprint`s by weighted Jaccard *similarity* to
// a site baseline, which no single hash can reproduce; that is why the column was
// left null when `page_features` shipped. #1026's fan-out needs the other thing —
// "are these two pages the same template?" as a `GROUP BY` — and the two coexist:
// this reduction is write-only from the rule's point of view, and the rule keeps
// reading the live fingerprint.
//
// WHAT IT CLUSTERS. `fingerprintPage` captures a page's chrome: external asset
// hosts, `<body>` class tokens, CSS custom-property names, stylesheet hrefs, and
// whether nav/footer are present. On real sites that is the template signal —
// measured on gymshark.com (247 pages) it yields 13 clusters, on
// openelectricity.org.au (100 pages) 12. An exact DOM skeleton, the intuitive
// alternative, yields 231 and 42 for the same crawls, because real pages of one
// template differ in body content (variant counts, review counts, related items).
// Do NOT re-derive that number from the synthetic bench corpora: they are
// generated from 1-6 templates, so every clustering definition collapses to ~99%
// redundancy on them and any sizing done there is wrong in the flattering
// direction.

import { fnv1a64 } from "./fingerprint";

import type { PageFingerprint } from "@squirrelscan/rules";

/**
 * Canonical, injective encoding of a fingerprint's chrome markers.
 *
 * ORDER-INSENSITIVITY IS LOAD-BEARING. Every marker arrives in a `Set`, whose
 * iteration order is INSERTION order — i.e. document order — so two pages built
 * from one template but listing their stylesheets in a different order would hash
 * differently and split the cluster. Each set is sorted before encoding.
 *
 * JSON, not a join: a delimiter-joined encoding lets a marker containing the
 * delimiter forge a different field boundary. `JSON.stringify` over the array of
 * arrays is injective for this shape, exactly as `findingFingerprint` does it.
 */
function canonicalize(fp: PageFingerprint): string {
  return JSON.stringify([
    [...fp.assetHosts].sort(),
    [...fp.bodyClasses].sort(),
    [...fp.cssVars].sort(),
    [...fp.stylesheetHrefs].sort(),
    fp.hasNav,
    fp.hasFooter,
  ]);
}

/**
 * Reduce a page fingerprint to the stored template cluster key: 16 lowercase hex
 * chars, or `null` for a page with no document (which stays out of every cluster —
 * `getPageFeatureTemplateClusters` filters `template_fp IS NOT NULL AND != ''`).
 *
 * Deterministic and pure: equal chrome ⇒ equal key, across runs and across
 * processes. It is a CHANGE/EQUALITY key, not a security primitive, so it uses
 * the same portable FNV-1a lane `findingFingerprint` does (sync, dependency-free,
 * identical on Bun and on Workers) rather than a digest.
 *
 * 64 bits is the width that matters here: the birthday bound is over the number of
 * DISTINCT templates in one crawl (13 on gymshark), not the page count, and a
 * collision would silently merge two templates — which #1951 would then fan a
 * rule verdict across. At 10k distinct templates a 32-bit key collides ~1.2% of
 * the time and this one ~3e-12.
 *
 * Changing `canonicalize` or the hash changes every key. That is harmless and
 * needs no backfill: `page_features` rows are written per `(crawl_id,
 * normalized_url)` by the crawl that produces them, nothing compares keys across
 * crawls, and no reader treats a pre-existing null as meaningful.
 */
export function templateFingerprintKey(fp: PageFingerprint | null): string | null {
  if (!fp) return null;
  return fnv1a64(new TextEncoder().encode(canonicalize(fp)), 0n);
}

/**
 * The comparison #1951's fan-out has to satisfy: everything a fanned-out verdict
 * would ASSERT about a page it never ran on, reduced to a comparable string.
 *
 * The whole check is included — `message`, `value`, `expected`, `items` and
 * `details` — not just name and status. An earlier version compared
 * `(name, status, message)` only, and two pages with different `<meta refresh>`
 * destinations, or different insecure form targets, compared EQUAL: the evidence
 * that distinguishes them lives in `items` and `details`, which is exactly what a
 * report renders. A comparison that drops it approves fan-out of the wrong
 * evidence.
 *
 * Only the page's own identity is normalised away: `pageUrl`, and any occurrence
 * of the page's url or path inside a string, become `<page>`. Those are per-page
 * by construction and #1951 restamps them onto the member being asserted about.
 * A resource url that merely LIVES on the page (a CDN script, a form action) is
 * left alone, because it is evidence, not identity.
 *
 * Object keys are emitted in sorted order, so two structurally equal payloads
 * built in different orders compare equal.
 */
export function templateVerdictKey(
  checks: ReadonlyArray<Record<string, unknown>>,
  pageUrl: string,
): string {
  let path = pageUrl;
  try {
    const u = new URL(pageUrl);
    path = u.pathname + u.search;
  } catch {
    /* not absolute; the full string is the only handle */
  }
  // Longest first, so scrubbing the path does not leave a fragment of the url.
  const identities = [...new Set([pageUrl, pageUrl.replace(/\/$/, ""), path])]
    .filter((v) => v.length > 1)
    .sort((a, b) => b.length - a.length);

  const scrubString = (text: string): string => {
    let out = text;
    for (const id of identities) out = out.split(id).join("<page>");
    return out;
  };

  const canon = (value: unknown): unknown => {
    if (typeof value === "string") return scrubString(value);
    if (Array.isArray(value)) return value.map(canon);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        // The page's own url as a FIELD is identity, not evidence.
        if (key === "pageUrl") continue;
        const v = (value as Record<string, unknown>)[key];
        if (v !== undefined) out[key] = canon(v);
      }
      return out;
    }
    return value;
  };

  const rows = checks.map((c) => JSON.stringify(canon(c)));
  rows.sort();
  return JSON.stringify(rows);
}
