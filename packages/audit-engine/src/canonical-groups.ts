// Query-string variants of a page (#858): the storage readers. The pure fold (`canonicalVariantMap`,
// `foldChecksToCanonical`) is in canonical-fold.ts, which the Worker-clean smart-audits entry imports.

import { Effect } from "effect";

import type { CrawlStorage } from "@squirrelscan/core-contracts/storage";

import { canonicalVariantMap } from "./canonical-fold";

export * from "./canonical-fold";

/** Variant page -> canonical page for a crawl, from the stored page features; empty when the storage has none (#858). */
export function readCanonicalVariants(
  storage: CrawlStorage,
  crawlId: string,
  batchSize: number,
  /** Set `unreadable` when the storage has no page features or a read failed: the map is then not "no variants". */
  health?: { unreadable: boolean },
): Effect.Effect<Map<string, string>, never, never> {
  return Effect.gen(function* () {
    const reader = storage as unknown as {
      getPageFeaturesPage?: (
        crawlId: string,
        opts?: { after?: string; limit?: number },
      ) => Effect.Effect<Array<{ normalizedUrl: string; canonical: string | null }>, unknown, never>;
    };
    if (!reader.getPageFeaturesPage) {
      if (health) health.unreadable = true;
      return new Map<string, string>();
    }
    const rows: Array<{ url: string; canonical: string | null }> = [];
    let after: string | undefined;
    for (;;) {
      const batch = yield* reader
        .getPageFeaturesPage(crawlId, { after, limit: batchSize })
        .pipe(
          Effect.catchAll(() => {
            if (health) health.unreadable = true;
            return Effect.succeed([] as Array<{ normalizedUrl: string; canonical: string | null }>);
          }),
        );
      if (batch.length === 0) break;
      for (const row of batch) rows.push({ url: row.normalizedUrl, canonical: row.canonical });
      after = batch[batch.length - 1]!.normalizedUrl;
      if (batch.length < batchSize) break;
    }
    return canonicalVariantMap(rows);
  });
}

/**
 * `variantOf` re-keyed to the URLs the entity map lists pages under (#1350). The map is keyed on a page's
 * final URL (`finalUrl || url`, entity-map/collect.ts), the report's fold on its normalized URL; they differ
 * when a variant or its canonical redirected (a trailing slash, http to https), and the fold would then miss.
 */
export function entityMapVariantKeys(
  storage: CrawlStorage,
  crawlId: string,
  variantOf: ReadonlyMap<string, string>,
  batchSize: number,
): Effect.Effect<Map<string, string>, never, never> {
  return Effect.gen(function* () {
    const out = new Map<string, string>();
    const reader = storage as unknown as {
      getPagesWithoutBodies?: (
        crawlId: string,
        opts?: { limit?: number; offset?: number },
      ) => Effect.Effect<Array<{ normalizedUrl: string; url: string; finalUrl: string | null }>, unknown, never>;
    };
    if (variantOf.size === 0 || !reader.getPagesWithoutBodies) return out;
    const keyOf = new Map<string, string>();
    for (let offset = 0; ; offset += batchSize) {
      const batch = yield* reader
        .getPagesWithoutBodies(crawlId, { limit: batchSize, offset })
        .pipe(Effect.catchAll(() => Effect.succeed([] as Array<{ normalizedUrl: string; url: string; finalUrl: string | null }>)));
      if (batch.length === 0) break;
      for (const page of batch) keyOf.set(page.normalizedUrl, page.finalUrl || page.url);
      if (batch.length < batchSize) break;
    }
    for (const [variant, canonical] of variantOf) {
      const from = keyOf.get(variant) ?? variant;
      const to = keyOf.get(canonical) ?? canonical;
      if (from !== to) out.set(from, to);
    }
    return out;
  });
}
