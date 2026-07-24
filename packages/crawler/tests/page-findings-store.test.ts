// Smart audits (#110) — page_findings / site_pages store round-trip + migration.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { PageFindingRecord, SitePageRecord } from "../src/storage/types";
import { SQLiteStorage } from "../src/storage/sqlite";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

async function freshStore(): Promise<SQLiteStorage> {
  const store = new SQLiteStorage(":memory:");
  await run(store.init());
  return store;
}

const SITE = "https://example.com";

function finding(over: Partial<PageFindingRecord> = {}): PageFindingRecord {
  return {
    siteKey: SITE,
    normalizedUrl: "https://example.com/a",
    ruleId: "core/meta-title",
    checkName: "Meta Title",
    locator: "",
    status: "fail",
    severity: "error",
    message: "Missing title",
    value: null,
    expected: null,
    payload: null,
    fingerprint: "fp1",
    firstSeenAt: 1000,
    lastSeenCrawlId: "crawl-1",
    lastSeenAt: 1000,
    provenance: "fresh",
    state: "open",
    ...over,
  };
}

describe("page_findings store", () => {
  test("upsert + read round-trips, site-scoped (not crawl-keyed)", async () => {
    const store = await freshStore();
    await run(
      store.upsertFindings([
        finding(),
        finding({ normalizedUrl: "https://example.com/b", fingerprint: "fp2" }),
        finding({ siteKey: "https://other.com", fingerprint: "fp3" }),
      ]),
    );
    const got = await run(store.getFindings(SITE));
    expect(got.length).toBe(2);
    expect(got.map((f) => f.normalizedUrl).sort()).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
    await run(store.close());
  });

  test("upsert is idempotent on the PK (url, rule, check, locator)", async () => {
    const store = await freshStore();
    await run(store.upsertFindings([finding({ message: "v1" })]));
    await run(store.upsertFindings([finding({ message: "v2", fingerprint: "fp-new" })]));
    const got = await run(store.getFindings(SITE));
    expect(got.length).toBe(1);
    expect(got[0].message).toBe("v2");
    expect(got[0].fingerprint).toBe("fp-new");
    await run(store.close());
  });

  test("locator discriminates findings within the same check", async () => {
    const store = await freshStore();
    await run(
      store.upsertFindings([
        finding({ locator: "" }),
        finding({ locator: "item-1", fingerprint: "fp-i1" }),
        finding({ locator: "item-2", fingerprint: "fp-i2" }),
      ]),
    );
    const got = await run(store.getFindings(SITE));
    expect(got.length).toBe(3);
    await run(store.close());
  });

  test("markPageRemoved stales findings + flips page state", async () => {
    const store = await freshStore();
    const url = "https://example.com/gone";
    await run(store.upsertFindings([finding({ normalizedUrl: url, fingerprint: "fpg" })]));
    await run(
      store.upsertSitePages([
        {
          siteKey: SITE,
          normalizedUrl: url,
          lastStatus: 200,
          state: "active",
          lastSeenCrawlId: "crawl-1",
          lastSeenAt: 1000,
        },
      ]),
    );
    await run(store.markPageRemoved(SITE, url, "crawl-2", 404));

    const findings = await run(store.getFindings(SITE));
    expect(findings.every((f) => f.state === "stale")).toBe(true);
    const pages = await run(store.getSitePages(SITE));
    expect(pages.find((p) => p.normalizedUrl === url)?.state).toBe("removed");
    await run(store.close());
  });

  test("getFindings(states) filters by lifecycle state (merge hot-path)", async () => {
    const store = await freshStore();
    await run(
      store.upsertFindings([
        finding({ locator: "a", state: "open", fingerprint: "fa" }),
        finding({ locator: "b", state: "resolved", fingerprint: "fb" }),
        finding({ locator: "c", state: "stale", fingerprint: "fc" }),
      ]),
    );
    const open = await run(store.getFindings(SITE, ["open"]));
    expect(open.length).toBe(1);
    expect(open[0].locator).toBe("a");
    // No filter → all states.
    expect((await run(store.getFindings(SITE))).length).toBe(3);
    await run(store.close());
  });
});

describe("site_pages store", () => {
  test("upsert + read site-scoped", async () => {
    const store = await freshStore();
    const pages: SitePageRecord[] = [
      {
        siteKey: SITE,
        normalizedUrl: "https://example.com/a",
        lastStatus: 200,
        state: "active",
        lastSeenCrawlId: "c1",
        lastSeenAt: 1,
      },
      {
        siteKey: SITE,
        normalizedUrl: "https://example.com/b",
        lastStatus: 200,
        state: "active",
        lastSeenCrawlId: "c1",
        lastSeenAt: 1,
      },
    ];
    await run(store.upsertSitePages(pages));
    const got = await run(store.getSitePages(SITE));
    expect(got.length).toBe(2);
    await run(store.close());
  });

  test("empty upserts are no-ops", async () => {
    const store = await freshStore();
    await run(store.upsertFindings([]));
    await run(store.upsertSitePages([]));
    expect((await run(store.getFindings(SITE))).length).toBe(0);
    await run(store.close());
  });
});

describe("compactFindings (#197 churny-site hygiene)", () => {
  const NOW = 10_000_000_000; // fixed clock for deterministic age cutoffs
  const DAY = 24 * 60 * 60 * 1000;

  function sitePage(over: Partial<SitePageRecord> = {}): SitePageRecord {
    return {
      siteKey: SITE,
      normalizedUrl: "https://example.com/p",
      lastStatus: 200,
      state: "active",
      lastSeenCrawlId: "c1",
      lastSeenAt: NOW,
      ...over,
    };
  }

  test("prunes old terminal findings (resolved + stale) only", async () => {
    const store = await freshStore();
    await run(
      store.upsertFindings([
        finding({ locator: "old-resolved", state: "resolved", fingerprint: "r1", lastSeenAt: NOW - 200 * DAY }),
        finding({ locator: "old-stale", state: "stale", fingerprint: "s1", lastSeenAt: NOW - 200 * DAY }),
        finding({ locator: "recent-resolved", state: "resolved", fingerprint: "r2", lastSeenAt: NOW - 1 * DAY }),
      ]),
    );
    const deleted = await run(store.compactFindings(SITE, { now: NOW }));
    expect(deleted).toBe(2);
    const left = await run(store.getFindings(SITE));
    expect(left.map((f) => f.locator).sort()).toEqual(["recent-resolved"]);
    await run(store.close());
  });

  // CRITICAL invariant (#110): open/carried findings are NEVER pruned,
  // regardless of age. Compaction must not touch the carry-indefinitely state.
  test("NEVER prunes open findings even when ancient", async () => {
    const store = await freshStore();
    await run(
      store.upsertFindings([
        finding({ locator: "ancient-open", state: "open", fingerprint: "o1", lastSeenAt: NOW - 9999 * DAY }),
        finding({ locator: "ancient-open-carried", state: "open", provenance: "carried", fingerprint: "o2", lastSeenAt: NOW - 9999 * DAY }),
        finding({ locator: "ancient-stale", state: "stale", fingerprint: "s1", lastSeenAt: NOW - 9999 * DAY }),
      ]),
    );
    const deleted = await run(store.compactFindings(SITE, { now: NOW }));
    expect(deleted).toBe(1); // only the stale row
    const left = await run(store.getFindings(SITE));
    expect(left.map((f) => f.locator).sort()).toEqual([
      "ancient-open",
      "ancient-open-carried",
    ]);
    expect(left.every((f) => f.state === "open")).toBe(true);
    await run(store.close());
  });

  test("prunes old removed site_pages, NEVER active pages", async () => {
    const store = await freshStore();
    await run(
      store.upsertSitePages([
        sitePage({ normalizedUrl: "https://example.com/active-old", state: "active", lastSeenAt: NOW - 9999 * DAY }),
        sitePage({ normalizedUrl: "https://example.com/removed-old", state: "removed", lastSeenAt: NOW - 200 * DAY }),
        sitePage({ normalizedUrl: "https://example.com/removed-recent", state: "removed", lastSeenAt: NOW - 1 * DAY }),
      ]),
    );
    const deleted = await run(store.compactFindings(SITE, { now: NOW }));
    expect(deleted).toBe(1); // only removed-old
    const left = await run(store.getSitePages(SITE));
    expect(left.map((p) => p.normalizedUrl).sort()).toEqual([
      "https://example.com/active-old",
      "https://example.com/removed-recent",
    ]);
    await run(store.close());
  });

  test("recent terminal rows survive (under the age bound)", async () => {
    const store = await freshStore();
    await run(
      store.upsertFindings([
        finding({ locator: "recent", state: "resolved", fingerprint: "r1", lastSeenAt: NOW - 10 * DAY }),
      ]),
    );
    const deleted = await run(store.compactFindings(SITE, { now: NOW }));
    expect(deleted).toBe(0);
    expect((await run(store.getFindings(SITE))).length).toBe(1);
    await run(store.close());
  });

  test("per-site cap keeps the NEWEST terminal findings", async () => {
    const store = await freshStore();
    // 5 terminal findings, all recent (under age bound) so only the cap prunes.
    // last_seen_at ascending by index → highest index = newest.
    const recent = Array.from({ length: 5 }, (_, i) =>
      finding({
        locator: `t${i}`,
        state: "resolved",
        fingerprint: `fp${i}`,
        lastSeenAt: NOW - (5 - i) * 1000,
      }),
    );
    // plus one open row that must be ignored by the cap entirely
    await run(store.upsertFindings([...recent, finding({ locator: "keep-open", state: "open", fingerprint: "open" })]));

    const deleted = await run(
      store.compactFindings(SITE, { now: NOW, maxTerminalFindings: 2 }),
    );
    expect(deleted).toBe(3); // 5 terminal - 2 kept

    const left = await run(store.getFindings(SITE));
    const locators = left.map((f) => f.locator).sort();
    // newest two terminal (t3, t4) + the untouched open row
    expect(locators).toEqual(["keep-open", "t3", "t4"]);
    await run(store.close());
  });

  test("cap never counts or prunes open rows", async () => {
    const store = await freshStore();
    // many open rows, zero terminal → cap of 1 deletes nothing
    const opens = Array.from({ length: 10 }, (_, i) =>
      finding({ locator: `o${i}`, state: "open", fingerprint: `fp${i}`, lastSeenAt: NOW - i * 1000 }),
    );
    await run(store.upsertFindings(opens));
    const deleted = await run(
      store.compactFindings(SITE, { now: NOW, maxTerminalFindings: 1 }),
    );
    expect(deleted).toBe(0);
    expect((await run(store.getFindings(SITE))).length).toBe(10);
    await run(store.close());
  });

  test("is site-scoped — other sites are untouched", async () => {
    const store = await freshStore();
    await run(
      store.upsertFindings([
        finding({ siteKey: SITE, locator: "a", state: "stale", fingerprint: "f1", lastSeenAt: NOW - 200 * DAY }),
        finding({ siteKey: "https://other.com", locator: "b", state: "stale", fingerprint: "f2", lastSeenAt: NOW - 200 * DAY }),
      ]),
    );
    const deleted = await run(store.compactFindings(SITE, { now: NOW }));
    expect(deleted).toBe(1);
    expect((await run(store.getFindings("https://other.com"))).length).toBe(1);
    await run(store.close());
  });
});
