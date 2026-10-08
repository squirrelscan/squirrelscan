// The `upsertSitePages` contract every in-repo store must keep (#497).
//
// `runCloudSmartAudits` hands `upsertSitePages` only the pages a run changed, so a
// store that treated the call as a snapshot (replace the site's rows with these)
// would lose the site's page history on the next publish. The interface documents
// a KEYED UPSERT; this suite is what holds every implementation to it. Each store
// runs it from its own test file, and `site-pages-contract-coverage.test.ts` fails
// when an implementation in the repo does not.
//
// Store-agnostic on purpose: it takes a factory for anything with the two methods,
// so a Promise store, an Effect store behind an adapter and a test double all run
// the same cases. One site, because the test doubles hold one; the key's site half
// is the SQLite store's own site-scoping test.

import { describe, expect, test } from "bun:test";

import type { SitePageRecord } from "@squirrelscan/core-contracts";

/** The two methods the contract is about, Promise-shaped. */
export interface SitePageStoreUnderTest {
  getSitePages(siteKey: string): Promise<SitePageRecord[]>;
  upsertSitePages(pages: SitePageRecord[]): Promise<void>;
}

const SITE = "web_contract";

function page(
  normalizedUrl: string,
  over: Partial<SitePageRecord> = {},
): SitePageRecord {
  return {
    siteKey: SITE,
    normalizedUrl,
    lastStatus: 200,
    state: "active",
    lastSeenCrawlId: "audit_1",
    lastSeenAt: 1_700_000_000_000,
    ...over,
  };
}

/** A site's rows by url, so the assertion does not depend on the store's order. */
async function rowsOf(store: SitePageStoreUnderTest) {
  const rows = await store.getSitePages(SITE);
  return [...rows].sort((a, b) =>
    a.normalizedUrl < b.normalizedUrl ? -1 : a.normalizedUrl > b.normalizedUrl ? 1 : 0,
  );
}

/**
 * Register the contract for one store. `open` returns a fresh, empty store each
 * time; `close` releases it, when the store needs that.
 */
export function describeSitePagesContract<S extends SitePageStoreUnderTest>(
  name: string,
  open: () => S | Promise<S>,
  close?: (store: S) => void | Promise<void>,
): void {
  describe(`upsertSitePages keyed-upsert contract: ${name}`, () => {
    const withStore = async (body: (store: S) => Promise<void>) => {
      const store = await open();
      try {
        await body(store);
      } finally {
        await close?.(store);
      }
    };

    test("a second upsert of a different row keeps the first", async () => {
      await withStore(async (store) => {
        const a = page("https://contract.test/a");
        const b = page("https://contract.test/b", { lastSeenCrawlId: "audit_2" });
        await store.upsertSitePages([a]);
        await store.upsertSitePages([b]);
        expect(await rowsOf(store)).toEqual([a, b]);
      });
    });

    test("upserting an existing key replaces that row and only that row", async () => {
      await withStore(async (store) => {
        const a = page("https://contract.test/a");
        const b = page("https://contract.test/b");
        await store.upsertSitePages([a, b]);
        const a2 = page("https://contract.test/a", {
          lastStatus: 301,
          state: "removed",
          lastSeenCrawlId: "audit_2",
          lastSeenAt: 1_700_000_100_000,
        });
        await store.upsertSitePages([a2]);
        expect(await rowsOf(store)).toEqual([a2, b]);
      });
    });

    test("rows absent from a call are never deleted or changed", async () => {
      await withStore(async (store) => {
        const seeded = [
          page("https://contract.test/a"),
          page("https://contract.test/b", { state: "removed", lastStatus: 404 }),
          page("https://contract.test/c"),
        ];
        await store.upsertSitePages(seeded);

        // An empty call, then a call naming one new page only.
        await store.upsertSitePages([]);
        const d = page("https://contract.test/d", { lastSeenCrawlId: "audit_3" });
        await store.upsertSitePages([d]);

        expect(await rowsOf(store)).toEqual([...seeded, d]);
      });
    });
  });
}
