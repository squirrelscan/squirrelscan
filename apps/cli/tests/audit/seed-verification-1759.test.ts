// #1759: a page left with open findings that the crawl no longer reaches ends a run resolved (gone or
// redirected), fresh (still live) or carried and counted, never carried unnoticed. Driven through
// runSmartAudits over a real in-memory store, then through the orphan rule on a crawled site.

import type { Config } from "@squirrelscan/config";
import type { PageRecord } from "@squirrelscan/core-contracts";
import type { RuleMeta } from "@squirrelscan/rules";

import {
  flattenChecks,
  runStreamingRules,
  type RuleTally,
} from "@squirrelscan/audit-engine";
import { SQLiteStorage } from "@squirrelscan/crawler";
import { coverageLine } from "@squirrelscan/report";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { runSmartAudits } from "@/audit/smart-audits";

import { runStreamingPreRules } from "../../../../packages/audit-engine/src/streaming-pre-rules";

const META: RuleMeta = {
  id: "core/meta-title",
  name: "Meta Title",
  description: "Page has a meta title",
  category: "core",
  scope: "page",
  severity: "error",
  weight: 5,
};
const SITE = "https://nutshop.test";
const url = (name: string) => `${SITE}/${name}`;
const RULE_META = new Map<string, RuleTally>([
  [META.id, { meta: META } as RuleTally],
]);

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

function failing(pages: string[]) {
  return pages.flatMap((name) =>
    flattenChecks(url(name), META.id, [
      {
        name: META.name,
        status: "fail",
        message: "Missing meta title",
        pageUrl: url(name),
      },
    ])
  );
}

const FAULTY = ["gone", "moved", "live", "budget", "unlinked"];

async function firstAudit(store: SQLiteStorage) {
  await run(
    runSmartAudits({
      storage: store,
      crawlId: "crawl-1",
      siteKey: SITE,
      freshFindings: failing(FAULTY),
      scoredPageUrls: FAULTY.map(url),
      ruleMeta: RULE_META,
      pages: FAULTY.map((name) => ({ normalizedUrl: url(name), status: 200 })),
    })
  );
}

describe("seeded pages with open findings (#1759)", () => {
  test("gone and redirected pages resolve, a live one is fresh, the rest are counted as carried", async () => {
    const store = new SQLiteStorage(":memory:");
    await run(store.init());
    await firstAudit(store);

    // Second run: the five faulty pages were seeded. One 410s, one redirects off its URL, one still
    // answers 200 (and still fails). The budget stopped before the fourth; nothing queued the fifth.
    const result = await run(
      runSmartAudits({
        storage: store,
        crawlId: "crawl-2",
        siteKey: SITE,
        freshFindings: failing(["live"]),
        scoredPageUrls: [url("live")],
        ruleMeta: RULE_META,
        pages: [
          { normalizedUrl: url("gone"), status: 410 },
          {
            normalizedUrl: url("moved"),
            status: 301,
            redirect: true,
            finalUrl: `${SITE}/new-home`,
          },
          { normalizedUrl: url("live"), status: 200 },
        ],
        seedVerification: {
          seeded: FAULTY.slice(0, 4).map(url),
          frontier: [{ normalizedUrl: url("budget"), status: "pending" }],
        },
      })
    );

    const open = await run(store.getFindings(SITE, ["open"]));
    const byPage = new Map(open.map((f) => [f.normalizedUrl, f.provenance]));
    // Resolved: neither the gone page nor the redirect source holds an open finding any more.
    expect(byPage.has(url("gone"))).toBe(false);
    expect(byPage.has(url("moved"))).toBe(false);
    // Fresh when still live, carried only where the run did not look.
    expect(byPage.get(url("live"))).toBe("fresh");
    expect(byPage.get(url("budget"))).toBe("carried");
    expect(byPage.get(url("unlinked"))).toBe("carried");

    const sv = result.coverage.seedVerification!;
    expect(sv).toMatchObject({
      knownPages: 5,
      seeded: 4,
      reverified: 3,
      gone: 1,
      redirected: 1,
      live: 1,
      leftCarried: 2,
      skippedByBudget: 1,
      noLongerLinked: 1,
      unverified: 0,
    });
    // The redirect is recorded with its source, destination and status; the gone page names its status.
    expect(sv.pages.find((p) => p.outcome === "redirected")).toEqual({
      url: url("moved"),
      outcome: "redirected",
      status: 301,
      destination: `${SITE}/new-home`,
    });
    expect(sv.pages.find((p) => p.outcome === "gone")).toEqual({
      url: url("gone"),
      outcome: "gone",
      status: 410,
    });
    // A redirect row is not a page and a gone page is not audited: only the live one counts.
    expect(result.coverage.auditedPages).toBe(1);

    const line = coverageLine({ coverage: result.coverage } as never)!;
    expect(line).toContain(
      "Known pages with open findings: 3 re-verified (1 gone, 1 redirected, 1 still live), 2 left carried (1 skipped by the page budget, 1 no longer linked)."
    );
  });

  test("a run that was not given its seeds reports exactly as before", async () => {
    const store = new SQLiteStorage(":memory:");
    await run(store.init());
    await firstAudit(store);
    const result = await run(
      runSmartAudits({
        storage: store,
        crawlId: "crawl-2",
        siteKey: SITE,
        freshFindings: failing(["live"]),
        scoredPageUrls: [url("live")],
        ruleMeta: RULE_META,
        pages: [{ normalizedUrl: url("live"), status: 200 }],
      })
    );
    expect("seedVerification" in result.coverage).toBe(false);
  });

  test("a seeded page the crawl refused or could not read is counted as unverified, not as gone", async () => {
    const store = new SQLiteStorage(":memory:");
    await run(store.init());
    await firstAudit(store);
    const result = await run(
      runSmartAudits({
        storage: store,
        crawlId: "crawl-2",
        siteKey: SITE,
        freshFindings: [],
        scoredPageUrls: [],
        ruleMeta: RULE_META,
        pages: [{ normalizedUrl: url("live"), status: 503 }],
        seedVerification: {
          seeded: [url("live"), url("gone")],
          frontier: [
            {
              normalizedUrl: url("moved"),
              status: "skipped",
              reason: "robots",
            },
          ],
        },
      })
    );
    const sv = result.coverage.seedVerification!;
    expect(sv.unverified).toBe(3);
    expect(sv.gone).toBe(0);
  });
});

describe("a live page no link reaches is reported by the orphan rule, fresh", () => {
  const CONFIG = {
    rule_options: {},
    rules: { enable: ["integrity/orphan-page"] },
    crawler: { max_pages: 100, exclude: [] },
    external_links: { enabled: false },
    internal_links: { enabled: true },
  } as unknown as Config;

  function record(path: string, links: string[]): PageRecord {
    const pageUrl = SITE + path;
    const html = `<!doctype html><html lang="en"><head><title>${path}</title></head><body><main><h1>${path}</h1>${links
      .map((l) => `<a href="${l}">${l}</a>`)
      .join("")}</main></body></html>`;
    return {
      url: pageUrl,
      normalizedUrl: pageUrl,
      finalUrl: pageUrl,
      depth: path === "/" ? 0 : 1,
      status: 200,
      contentType: "text/html",
      sizeBytes: html.length,
      loadTimeMs: 10,
      fetchedAt: Date.now(),
      etag: null,
      lastModified: null,
      contentHash: `h${path}`,
      html,
      parsedData: null,
      headers: { contentType: "text/html" },
      securityHeaders: {},
      redirectChain: {
        sourceUrl: pageUrl,
        finalUrl: pageUrl,
        hops: [],
        chainLength: 0,
        isLoop: false,
        endsInError: false,
        httpsToHttp: false,
        httpToHttps: false,
      },
    } as unknown as PageRecord;
  }

  test("the unlinked seeded page is an orphan finding of this run", async () => {
    const storage = new SQLiteStorage(":memory:");
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        yield* storage.init();
        const crawlId = yield* storage.createCrawl({
          baseUrl: SITE,
          seedUrl: `${SITE}/`,
          originalUrl: `${SITE}/`,
          startedAt: Date.now(),
          status: "completed",
          config: {} as never,
          stats: {
            pagesTotal: 0,
            pagesFetched: 0,
            pagesFailed: 0,
            pagesSkipped: 0,
            pagesUnchanged: 0,
            linksTotal: 0,
            imagesTotal: 0,
            bytesTotal: 0,
            avgLoadTimeMs: 0,
          },
        } as never);
        // Home, about and shop link to each other (three inbound links each); /legacy-promo is seeded,
        // answers 200 and nothing links to it.
        for (const page of [
          record("/", ["/about", "/shop"]),
          record("/about", ["/", "/shop"]),
          record("/shop", ["/", "/about"]),
          record("/legacy-promo", ["/", "/about", "/shop"]),
        ]) {
          yield* storage.upsertPage(crawlId, page);
        }
        const pre = yield* runStreamingPreRules(storage, crawlId, CONFIG, {});
        const ran = yield* runStreamingRules(
          storage,
          crawlId,
          CONFIG,
          pre.assets
        );
        return ran.ruleResultsMap;
      }).pipe(
        Effect.ensuring(storage.close().pipe(Effect.orDie))
      ) as unknown as Effect.Effect<
        Map<
          string,
          {
            checks: Array<{
              name: string;
              status: string;
              items?: Array<{ id: string }>;
              provenance?: string;
            }>;
          }
        >,
        never,
        never
      >
    );
    const checks = results.get("integrity/orphan-page")!.checks;
    const fail = checks.find((c) => c.name === "orphan-page-review");
    expect(fail?.items?.map((i) => i.id)).toEqual([`${SITE}/legacy-promo`]);
    expect(fail?.provenance === undefined || fail.provenance === "fresh").toBe(
      true
    );
  }, 30_000);
});
