// #1759: a smart audit says how many known pages with open findings it re-verified and how many
// it left carried, and why. Real in-memory SQLite store, so the frontier lookup that tells a page
// the budget skipped from one nothing links to any more is the crawler's own table.

import type { FrontierRecord } from "@squirrelscan/core-contracts";
import type { RuleMeta } from "@squirrelscan/rules";

import { flattenChecks, type RuleTally } from "@squirrelscan/audit-engine";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { runSmartAudits } from "@/audit/smart-audits";
import { SQLiteStorage } from "@/crawler/storage/sqlite";

const META: RuleMeta = {
  id: "core/meta-title",
  name: "Meta Title",
  description: "Page has a meta title",
  category: "core",
  scope: "page",
  severity: "error",
  weight: 5,
};
const SITE = "https://example.com";
const url = (i: number) => `${SITE}/page-${i}`;
const RULE_META = new Map<string, RuleTally>([
  [META.id, { meta: META } as RuleTally],
]);

const run = <A>(eff: Effect.Effect<A, unknown, never>): Promise<A> =>
  Effect.runPromise(eff as Effect.Effect<A, never, never>);

/** Every listed page fails the rule: the run's findings and the pages it scored. */
function failingRun(indexes: number[]) {
  return {
    freshFindings: indexes.flatMap((i) =>
      flattenChecks(url(i), META.id, [
        {
          name: META.name,
          status: "fail",
          message: "Missing meta title",
          pageUrl: url(i),
        },
      ])
    ),
    scoredPageUrls: indexes.map(url),
    ruleMeta: RULE_META,
  };
}

const frontier = (
  i: number,
  status: FrontierRecord["status"],
  source: FrontierRecord["source"]
): FrontierRecord => ({
  normalizedUrl: url(i),
  rawUrl: url(i),
  depth: 1,
  priority: 0,
  status,
  source,
  enqueuedAt: 1,
  retryCount: 0,
});

async function seededStore(): Promise<SQLiteStorage> {
  const store = new SQLiteStorage(":memory:");
  await run(store.init());
  // Run 1: six pages, every one fails.
  await run(
    runSmartAudits({
      storage: store,
      crawlId: "c1",
      siteKey: SITE,
      ...failingRun([0, 1, 2, 3, 4, 5]),
      pages: [0, 1, 2, 3, 4, 5].map((i) => ({
        normalizedUrl: url(i),
        status: 200,
      })),
    })
  );
  return store;
}

describe("coverage.openPages (#1759)", () => {
  test("a first audit has no carried pages and no openPages", async () => {
    const store = new SQLiteStorage(":memory:");
    await run(store.init());
    const first = await run(
      runSmartAudits({
        storage: store,
        crawlId: "c1",
        siteKey: SITE,
        ...failingRun([0, 1]),
        pages: [0, 1].map((i) => ({ normalizedUrl: url(i), status: 200 })),
      })
    );
    expect(first.coverage.openPages).toBeUndefined();
    await run(store.close());
  });

  test("re-verified pages and carried pages, split by the frontier", async () => {
    const store = await seededStore();
    // Run 2 crawled 0 (still failing), 1 (now clean) and 2 (404). 3 was queued and never fetched, 4
    // was found and its fetch failed, 5 was not found at all.
    await run(store.upsertFrontier("c2", frontier(3, "pending", "discovered")));
    await run(store.upsertFrontier("c2", frontier(4, "failed", "sitemap")));
    const second = await run(
      runSmartAudits({
        storage: store,
        crawlId: "c2",
        siteKey: SITE,
        ...failingRun([0]),
        scoredPageUrls: [url(0), url(1)],
        pages: [
          { normalizedUrl: url(0), status: 200 },
          { normalizedUrl: url(1), status: 200 },
          { normalizedUrl: url(2), status: 404 },
        ],
      })
    );
    expect(second.coverage.openPages).toEqual({
      reverified: 3,
      carried: 3,
      skippedByBudget: 1,
      noLongerLinked: 1,
      notFetched: 1,
    });
    // The numbers agree with what the store did: 3 pages carried their findings.
    expect(second.coverage.carriedFindings).toBe(3);
    await run(store.close());
  });

  test("a queued URL with a trailing slash is still skipped by the budget, not no longer linked (F1)", async () => {
    const store = new SQLiteStorage(":memory:");
    await run(store.init());
    // `page_findings` keys carry no trailing slash; the crawler's frontier keeps `/blog/post/` as its own URL.
    const slashed = `${SITE}/blog/post`;
    await run(
      runSmartAudits({
        storage: store,
        crawlId: "c1",
        siteKey: SITE,
        freshFindings: flattenChecks(slashed, META.id, [
          {
            name: META.name,
            status: "fail",
            message: "Missing meta title",
            pageUrl: slashed,
          },
        ]),
        scoredPageUrls: [slashed],
        ruleMeta: RULE_META,
        pages: [{ normalizedUrl: slashed, status: 200 }],
      })
    );
    await run(
      store.upsertFrontier("c2", {
        ...frontier(0, "pending", "discovered"),
        normalizedUrl: `${slashed}/`,
        rawUrl: `${slashed}/`,
      })
    );
    const second = await run(
      runSmartAudits({
        storage: store,
        crawlId: "c2",
        siteKey: SITE,
        ...failingRun([0]),
        pages: [{ normalizedUrl: url(0), status: 200 }],
      })
    );
    expect(second.coverage.openPages).toEqual({
      reverified: 0,
      carried: 1,
      skippedByBudget: 1,
    });
    await run(store.close());
  });

  test("a carried seed the budget never reached counts as skipped, not as no longer linked", async () => {
    const store = await seededStore();
    await run(store.upsertFrontier("c2", frontier(5, "pending", "carried")));
    const second = await run(
      runSmartAudits({
        storage: store,
        crawlId: "c2",
        siteKey: SITE,
        ...failingRun([0, 1, 2, 3, 4]),
        pages: [0, 1, 2, 3, 4].map((i) => ({
          normalizedUrl: url(i),
          status: 200,
        })),
      })
    );
    expect(second.coverage.openPages).toEqual({
      reverified: 5,
      carried: 1,
      skippedByBudget: 1,
    });
    await run(store.close());
  });

  test("AC1: a URL that now redirects has its earlier findings resolved, not carried", async () => {
    const store = await seededStore();
    // #1762: a followed redirect is stored under the requested URL as a 3xx row with no body. It
    // is not a page rule's input, so it yields no finding, but it is a crawled page: the findings
    // it held when it served content resolve.
    const second = await run(
      runSmartAudits({
        storage: store,
        crawlId: "c2",
        siteKey: SITE,
        ...failingRun([0, 1, 3, 4, 5]),
        pages: [
          { normalizedUrl: url(0), status: 200 },
          { normalizedUrl: url(1), status: 200 },
          { normalizedUrl: url(2), status: 301 },
          { normalizedUrl: url(3), status: 200 },
          { normalizedUrl: url(4), status: 200 },
          { normalizedUrl: url(5), status: 200 },
        ],
      })
    );
    const open = (await run(store.getFindings(SITE, ["open"]))).map(
      (f) => f.normalizedUrl
    );
    expect(open).not.toContain(url(2));
    const redirected = (
      await run(store.getFindings(SITE, ["resolved"]))
    ).filter((f) => f.normalizedUrl === url(2));
    expect(redirected.length).toBe(1);
    expect(second.coverage.carriedFindings).toBe(0);
    expect(second.coverage.openPages).toEqual({ reverified: 6, carried: 0 });
    await run(store.close());
  });
});

describe("resolvedBy on the local merge (#1759 b)", () => {
  const payloadOf = async (store: SQLiteStorage, page: string) => {
    const rows = await run(store.getFindings(SITE));
    const row = rows.find((f) => f.normalizedUrl === page);
    return {
      state: row?.state,
      by: (JSON.parse(row?.payload ?? "{}") as { resolvedBy?: unknown })
        .resolvedBy,
    };
  };

  test("a redirect row's findings resolve with the status and destination", async () => {
    const store = await seededStore();
    await run(
      runSmartAudits({
        storage: store,
        crawlId: "c2",
        siteKey: SITE,
        ...failingRun([0, 1, 3, 4, 5]),
        pages: [0, 1, 2, 3, 4, 5].map((i) => ({
          normalizedUrl: url(i),
          status: i === 2 ? 301 : 200,
        })),
        redirects: [
          { normalizedUrl: url(2), status: 301, to: `${SITE}/new-2` },
        ],
      })
    );
    expect(await payloadOf(store, url(2))).toEqual({
      state: "resolved",
      by: { kind: "redirected", status: 301, to: `${SITE}/new-2` },
    });
    // a page that still fails keeps its row and gains no reason
    expect(await payloadOf(store, url(0))).toMatchObject({
      state: "open",
      by: undefined,
    });
    await run(store.close());
  });

  test("a 410 page is staled with the status in its evidence, a 404 too", async () => {
    const store = await seededStore();
    await run(
      runSmartAudits({
        storage: store,
        crawlId: "c2",
        siteKey: SITE,
        ...failingRun([0, 1, 4, 5]),
        pages: [0, 1, 2, 3, 4, 5].map((i) => ({
          normalizedUrl: url(i),
          status: i === 2 ? 410 : i === 3 ? 404 : 200,
        })),
      })
    );
    expect(await payloadOf(store, url(2))).toEqual({
      state: "stale",
      by: { kind: "removed", status: 410 },
    });
    expect(await payloadOf(store, url(3))).toEqual({
      state: "stale",
      by: { kind: "removed", status: 404 },
    });
    await run(store.close());
  });

  test("a redirect row the crawl did not list as a page still resolves the page's findings (AC1)", async () => {
    const store = await seededStore();
    await run(
      runSmartAudits({
        storage: store,
        crawlId: "c2",
        siteKey: SITE,
        ...failingRun([0, 1, 3, 4, 5]),
        // /page-2 is in no page row this run, as in a cloud audit; only the redirect list names it
        pages: [0, 1, 3, 4, 5].map((i) => ({
          normalizedUrl: url(i),
          status: 200,
        })),
        redirects: [
          { normalizedUrl: url(2), status: 301, to: `${SITE}/new-2` },
        ],
      })
    );
    expect(await payloadOf(store, url(2))).toEqual({
      state: "resolved",
      by: { kind: "redirected", status: 301, to: `${SITE}/new-2` },
    });
    await run(store.close());
  });

  test("a redirect row the crawler keeps with a trailing slash resolves the findings stored without one", async () => {
    const store = new SQLiteStorage(":memory:");
    await run(store.init());
    // `page_findings` keys carry no trailing slash; the crawler's own URL for the redirecting page does (#1510)
    const bare = `${SITE}/old`;
    await run(
      runSmartAudits({
        storage: store,
        crawlId: "c1",
        siteKey: SITE,
        freshFindings: flattenChecks(bare, META.id, [
          {
            name: META.name,
            status: "fail",
            message: "Missing meta title",
            pageUrl: bare,
          },
        ]),
        scoredPageUrls: [bare],
        ruleMeta: RULE_META,
        pages: [{ normalizedUrl: bare, status: 200 }],
      })
    );
    await run(
      runSmartAudits({
        storage: store,
        crawlId: "c2",
        siteKey: SITE,
        ...failingRun([0]),
        pages: [{ normalizedUrl: url(0), status: 200 }],
        redirects: [
          { normalizedUrl: `${bare}/`, status: 301, to: `${SITE}/new/` },
        ],
      })
    );
    expect(await payloadOf(store, bare)).toEqual({
      state: "resolved",
      by: { kind: "redirected", status: 301, to: `${SITE}/new/` },
    });
    await run(store.close());
  });

  test("a redirect to the same page resolves nothing", async () => {
    const store = await seededStore();
    await run(
      runSmartAudits({
        storage: store,
        crawlId: "c2",
        siteKey: SITE,
        ...failingRun([0, 1, 3, 4, 5]),
        pages: [0, 1, 3, 4, 5].map((i) => ({
          normalizedUrl: url(i),
          status: 200,
        })),
        redirects: [{ normalizedUrl: url(2), status: 301, to: `${url(2)}/` }],
      })
    );
    expect(await payloadOf(store, url(2))).toMatchObject({ state: "open" });
    await run(store.close());
  });

  test("no redirect evidence, no reason: the resolution is the same", async () => {
    const store = await seededStore();
    await run(
      runSmartAudits({
        storage: store,
        crawlId: "c2",
        siteKey: SITE,
        ...failingRun([0, 1, 3, 4, 5]),
        pages: [0, 1, 2, 3, 4, 5].map((i) => ({
          normalizedUrl: url(i),
          status: i === 2 ? 301 : 200,
        })),
      })
    );
    expect(await payloadOf(store, url(2))).toEqual({
      state: "resolved",
      by: undefined,
    });
    await run(store.close());
  });
});
