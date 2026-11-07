// #1570: a page that could not be parsed is skipped by the markup rules (`unread-page`). It must not be the representative of its
// template cluster, or those skips would be copied to every healthy sibling that follows it.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { parsePage } from "@squirrelscan/parser";

import { SQLiteStorage } from "@squirrelscan/crawler";
import { createRunner } from "@squirrelscan/rules";
import type { SiteData } from "@squirrelscan/rules";
import type { Config } from "@squirrelscan/config";
import type { CheckResult, PageRecord } from "@squirrelscan/core-contracts";

import { streamPageRules } from "../src/streaming";
import { CORPUS, ORIGIN, mkPage } from "./helpers/template-corpus";

const run = <A>(eff: Effect.Effect<A, unknown, never>): Promise<A> => Effect.runPromise(eff as Effect.Effect<A, never, never>);

const CRAWL = "crawl-1";
const CONFIG = { rule_options: {}, rules: { enable: ["*"] } } as unknown as Config;
const SITE_DATA = { baseUrl: ORIGIN, pages: [], robotsTxt: null, sitemaps: null } as unknown as SiteData;
const NOTICE = "the page could not be read (boom), so it was audited empty";
const UNREAD = `${ORIGIN}/landing/1`;
const SIBLINGS = [`${ORIGIN}/landing/2`, `${ORIGIN}/landing/3`];
const unreadSkips = (checks: CheckResult[] | undefined): number => (checks ?? []).filter((c) => c.skipReason === "unread-page").length;

describe("an unread page is not a template representative (#1570)", () => {
  test("its skipped verdicts are not copied to the siblings of its template", async () => {
    const store = new SQLiteStorage(":memory:");
    await run(store.init());
    for (const { url, html } of CORPUS) {
      const record = mkPage(url, html) as PageRecord;
      // the stored parse of the first landing page says it could not be read
      if (url === UNREAD) record.parsedData = JSON.stringify({ ...parsePage(html, url), document: undefined, parseNotices: [NOTICE] });
      await run(store.upsertPage(CRAWL, record));
    }
    const out = await run(streamPageRules(store, CRAWL, createRunner(CONFIG), SITE_DATA, { batchSize: 4, templateFanout: true }));
    await run(store.close());

    // the unread page skipped its markup rules, so the gate ran on it
    expect(unreadSkips(out.pageResults.get(UNREAD))).toBeGreaterThan(50);
    // the cluster still fanned out (the siblings share a representative), and none of them inherited an unread-page skip
    expect(out.templateFanout.fannedPages).toBeGreaterThan(0);
    for (const url of SIBLINGS) expect([url, unreadSkips(out.pageResults.get(url))]).toEqual([url, 0]);
  }, 120_000);
});
