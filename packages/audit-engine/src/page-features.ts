// Page-time feature extraction (#1022, PR-D) — the ONE writer that distills a
// live parsed page into a bounded {@link PageFeatureRow}. The streaming rule loop
// (#1021, PR-E) will call `extractPageFeatures` once per page while the DOM is
// still resident, then `upsertPageFeatures` the result, so the site rules can
// query these scalars instead of re-holding every parsed page.
//
// It is dark until E-E wires it: nothing calls it in a production audit path yet.
//
// THREE population invariants this honors (carried from PR-B/PR-C findings):
//  1. RAW title/description — the duplicate/title rules re-derive their own
//     normalized keys, so the stored value is the untrimmed original.
//  2. normalized_url = PageRecord.normalizedUrl (the FRONTIER normalization), so
//     query-variant pages stay distinct on the (crawl_id, normalized_url) PK.
//  3. Page universe — {@link isAuditablePage} exposes the same HTML/WAF exclusion
//     `adapter.ts` applies when building `site.pages`, so E-E only extracts pages
//     v1 would score. (4xx/5xx pages, which v1 appends as EMPTY_PARSED_PAGE with
//     empty headers, are E-E's universe-assembly concern, not this function's.)

import { detectWafChallengePage } from "@squirrelscan/waf-detect";
import { getRichResultTypes, isPageIndexable } from "@squirrelscan/utils";

import type { PageRecord, PageFeatureRow } from "@squirrelscan/core-contracts";
import type { ParsedPage } from "@squirrelscan/rules";

import { buildHeadersMap, isHtmlContentType } from "./adapter";

/**
 * Whether a crawled page enters the audit the way v1 `runRulesOnStorage` decides:
 * HTML content-type, body present, and NOT a WAF-challenge interstitial. E-E must
 * gate `extractPageFeatures` on this so `page_features`' universe matches v1's
 * `site.pages` (minus the separate 4xx/5xx EMPTY_PARSED_PAGE append). Exported so
 * the one predicate lives in one place.
 */
export function isAuditablePage(page: PageRecord): boolean {
  if (!isHtmlContentType(page.contentType)) return false;
  if (!page.html) return false;
  const waf = detectWafChallengePage({
    status: page.status,
    headers: {
      server: page.headers.server,
      cfCacheStatus: page.headers.cfCacheStatus,
      xCache: page.headers.xCache,
    },
    html: page.html,
  });
  return !waf.detected;
}

// FNV-1a (32-bit) hex — a tiny, dependency-free, deterministic, Worker-safe hash
// for the duplicate-grouping keys. Equal normalized strings ⇒ equal hash, which
// is all `GROUP BY title_hash/desc_hash` requires.
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function hashNormalized(raw: string | null): string | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  return normalized ? fnv1a(normalized) : null;
}

/** Token-exact meta-robots noindex — the meta-ONLY notion (crawl/robots-meta-conflict). */
function metaRobotsNoindex(robots: string | null): boolean {
  return (
    robots?.toLowerCase().split(",").map((d) => d.trim()).includes("noindex") ?? false
  );
}

/**
 * Distill one live parsed page into its {@link PageFeatureRow}. Pure + synchronous
 * — no storage, no network. Reuses the exact per-page helpers the site rules use
 * (`isPageIndexable`, `getRichResultTypes`, `buildHeadersMap`) so a rule reading
 * the stored scalar is byte-identical to the legacy rule computing it inline.
 *
 * `transfer_bytes` is populated from `PageRecord.sizeBytes` (the page document
 * body size). `template_fp` and `secret_hits` are left null — see the PR notes:
 * their would-be consumers (template-discontinuity's fuzzy similarity,
 * leaked-secrets' masked-list output) can't be reproduced from an equality
 * fingerprint / a bare count, and the leaked-secret scanner is not yet a shared
 * export. Populating them is deferred until a rule can dual-path on them.
 */
export function extractPageFeatures(page: PageRecord, parsed: ParsedPage): PageFeatureRow {
  const headers = buildHeadersMap(page);
  // meta+header indexability only; the robots.txt reason is site-level and is
  // appended by the rules from ctx.site.robotsTxt at run time.
  const indexability = isPageIndexable(parsed, headers);

  const title = parsed.meta.title;
  const description = parsed.meta.description;

  return {
    normalizedUrl: page.normalizedUrl,
    status: page.status,
    depth: page.depth,
    title,
    titleHash: hashNormalized(title),
    description,
    descHash: hashNormalized(description),
    contentHash: page.contentHash ?? null,
    wordCount: parsed.content?.wordCount ?? null,
    pageType: parsed.pageType ?? null,
    schemaTypes: parsed.schemas?.types ?? [],
    // Combined meta-OR-header noindex. `indexability` is the 2-arg (meta+header)
    // verdict, so !isIndexable == a meta/header noindex reason is present.
    robotsNoindex: !indexability.isIndexable,
    canonical: parsed.meta.canonical,
    visibleAuthor: parsed.visibleAuthor != null,
    visibleDate:
      parsed.visibleDatePublished != null || parsed.visibleDateModified != null,
    transferBytes: page.sizeBytes ?? null,
    templateFp: null,
    secretHits: null,
    metaNoindex: metaRobotsNoindex(parsed.meta.robots),
    indexableReasons: indexability.reasons,
    richResultTypes: getRichResultTypes(parsed.schemas),
  };
}
