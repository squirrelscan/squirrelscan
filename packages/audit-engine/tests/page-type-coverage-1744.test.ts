// scanScope.pageTypes: discovered and audited pages per page type (#1744).

import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { SQLiteStorage, type CrawlStorage } from "@squirrelscan/crawler";

import { pageTypeCoverage, pageTypeCoverageFor } from "../src/report-stream";

const B = "https://shop.example";
const products = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `${B}/products/p-${from + i}`);

describe("pageTypeCoverage", () => {
  test("a capped crawl with mixed types reports known above audited", () => {
    const audited = [`${B}/`, ...products(1), `${B}/blog/post-a`, `${B}/misc`];
    const pending = [...products(35, 1), `${B}/blog/post-b`, `${B}/other`];
    const rows = pageTypeCoverage(audited, pending);
    const byType = Object.fromEntries(rows.map((r) => [r.type, r]));
    expect(byType.product).toEqual({ type: "product", discovered: 36, audited: 1 });
    expect(byType.article).toEqual({ type: "article", discovered: 2, audited: 1 });
    expect(byType.home).toEqual({ type: "home", discovered: 1, audited: 1 });
    expect(byType.unknown).toEqual({ type: "unknown", discovered: 2, audited: 1 });
    expect(rows[0]?.type).toBe("product");
    expect(rows.every((r) => r.discovered >= r.audited)).toBe(true);
  });

  test("a complete crawl reports equal counts", () => {
    const rows = pageTypeCoverage([`${B}/`, ...products(3), `${B}/faq`], []);
    expect(rows.every((r) => r.discovered === r.audited)).toBe(true);
    expect(rows.reduce((n, r) => n + r.audited, 0)).toBe(5);
  });

  test("no pages gives no rows", () => {
    expect(pageTypeCoverage([], [])).toEqual([]);
  });
});

describe("pageTypeCoverageFor", () => {
  test("only pending frontier rows of this crawl count as discovered-not-audited", async () => {
    const storage = new SQLiteStorage(":memory:");
    const stats = {
      pagesTotal: 0, pagesFetched: 0, pagesFailed: 0, pagesSkipped: 0, pagesUnchanged: 0,
      linksTotal: 0, imagesTotal: 0, bytesTotal: 0, avgLoadTimeMs: 0,
    };
    const mk = () => storage.createCrawl({ baseUrl: B, originalUrl: B, startedAt: 1, status: "completed", config: {} as never, stats });
    const row = (url: string, status: "pending" | "done" | "failed") => ({
      normalizedUrl: url, rawUrl: url, depth: 1, priority: 0, status,
      source: "sitemap" as const, enqueuedAt: 1, retryCount: 0,
    });
    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        yield* storage.init();
        const id = yield* mk();
        const other = yield* mk();
        yield* storage.upsertFrontier(id, row(`${B}/products/a`, "done"));
        yield* storage.upsertFrontier(id, row(`${B}/products/b`, "pending"));
        yield* storage.upsertFrontier(id, row(`${B}/products/c`, "pending"));
        yield* storage.upsertFrontier(id, row(`${B}/products/d`, "failed"));
        yield* storage.upsertFrontier(other, row(`${B}/products/z`, "pending"));
        return yield* pageTypeCoverageFor(storage, id, [`${B}/products/a`]);
      }),
    );
    expect(rows).toEqual([{ type: "product", discovered: 3, audited: 1 }]);
  });

  test("a failed read gives no rows instead of failing the report", async () => {
    const broken = { getAllFrontierEntries: () => Effect.fail(new Error("gone")) } as unknown as CrawlStorage;
    expect(await Effect.runPromise(pageTypeCoverageFor(broken, "c", [`${B}/`]))).toEqual([]);
  });
});
