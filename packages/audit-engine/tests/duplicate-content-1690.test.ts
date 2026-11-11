// content/duplicate-content (#1690) through the streaming engine: the collector builds
// the body fingerprint page-time, and the rule fires from ctx.collectedSignals. v1
// (documents present) must judge the same crawl identically. Matched by the Engine Golden Gates CI glob.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CheckResult, PreFetchedAssets } from "@squirrelscan/audit-engine";

import { runStreamingRules } from "@squirrelscan/audit-engine";
import { parsePage } from "@squirrelscan/parser";
import { generateSiteModel, writeCrawlToStorage } from "@squirrelscan/synthetic-site";

import { getGoldenBaselineConfig, run, runV1Pipeline } from "./helpers/golden-baseline";

const tmpDir = mkdtempSync(join(tmpdir(), "squirrelscan-duplicate-content-"));
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const ASSETS: PreFetchedAssets = {
  resourceSizes: { css: [], images: [] },
  scripts: [],
  pdfSizes: [],
  sitemapUrlStatuses: [],
};

const words = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `${tag}${i}`).join(" ");
const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main><p>${body}</p></main></body></html>`;

describe("duplicate content through the streaming engine (#1690)", () => {
  test("two pages with one body and different titles are reported; a distinct page is not", async () => {
    const model = generateSiteModel({
      seed: "duplicate-content-1690",
      pageCount: 3,
      templateCount: 1,
      minPageSizeBytes: 1_000,
      maxPageSizeBytes: 2_000,
      cleanRatio: 1,
    });
    const { storage, crawlId } = await writeCrawlToStorage(model, join(tmpDir, "crawl.sqlite"));
    try {
      const records = await run(storage.getPages(crawlId));
      expect(records.length).toBe(3);
      const bodies = [words(150, "shared"), words(150, "shared"), words(150, "unique")];
      const urls: string[] = [];
      for (const [i, record] of records.entries()) {
        const html = page(`Title ${i}`, bodies[i]!);
        const { document: _doc, ...parsed } = parsePage(html, record.finalUrl ?? record.url);
        await run(
          storage.upsertPage(crawlId, { ...record, html, parsedData: JSON.stringify(parsed) }),
        );
        if (i < 2) urls.push(record.normalizedUrl);
      }

      const config = getGoldenBaselineConfig();
      const pick = (map: Map<string, { checks: CheckResult[] }>) =>
        map.get("content/duplicate-content")?.checks.find((c) => c.name === "duplicate-content");
      const streaming = pick(
        (await run(runStreamingRules(storage, crawlId, config, ASSETS))).ruleResultsMap,
      );
      const v1 = pick((await runV1Pipeline(storage, crawlId, config)).ruleResults.ruleResultsMap);

      expect(streaming?.status).toBe("warn");
      expect(streaming?.message).toBe("1 duplicate content group(s) found across 2 pages");
      expect([...(streaming?.items?.[0]?.sourcePages ?? [])].sort()).toEqual([...urls].sort());
      expect(v1).toEqual(streaming);
    } finally {
      await run(storage.close());
    }
  }, 180_000);
});
