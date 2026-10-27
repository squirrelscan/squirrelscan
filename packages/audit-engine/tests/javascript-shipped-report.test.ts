// squirrelscan/repo#3397: the rules phase measures the scripts it fetched into a
// `javascript` block, and both report builders carry it identically, from this
// run's result or, failing that, from the block stamped on the crawl.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeCrawlToStorage } from "@squirrelscan/synthetic-site";
import {
  generateReportFromStorage,
  runStreamingRules,
  type PreFetchedAssets,
} from "@squirrelscan/audit-engine";
import type { JavascriptShipped, ScriptContentData } from "@squirrelscan/core-contracts";
import { SQLiteStorage } from "@squirrelscan/crawler";

import { buildV2Report } from "../src/report-stream";
import { buildGoldenBaselineModel, getGoldenBaselineConfig, run } from "./helpers/golden-baseline";

const tmpDir = mkdtempSync(join(tmpdir(), "squirrelscan-javascript-shipped-"));

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function script(url: string, sizeBytes: number, sourcePages: string[]): ScriptContentData {
  return {
    url,
    status: 200,
    error: null,
    contentType: "application/javascript",
    sizeBytes,
    content: "void 0;",
    sourcePages,
  };
}

function assetsWith(scripts: ScriptContentData[]): PreFetchedAssets {
  return {
    resourceSizes: { css: [], images: [] },
    scripts,
    pdfSizes: [],
    sitemapUrlStatuses: [],
  };
}

async function withFixture(
  name: string,
  body: (storage: SQLiteStorage, crawlId: string) => Promise<void>,
): Promise<void> {
  const dbPath = join(tmpDir, `${name}.sqlite`);
  const { storage: writeStorage } = await writeCrawlToStorage(buildGoldenBaselineModel(), dbPath);
  await run(writeStorage.close());
  const storage = new SQLiteStorage(dbPath);
  try {
    await run(storage.init());
    const crawlId = (await run(storage.listCrawls(1)))[0]?.id;
    if (!crawlId) throw new Error("no crawl found in fixture DB");
    await body(storage, crawlId);
  } finally {
    await run(storage.close());
  }
}

describe("javascript shipped through the report builders", () => {
  test(
    "the rules phase measures the fetched scripts, and v1 and v2 agree",
    async () => {
      await withFixture("measured", async (storage, crawlId) => {
        const result = await run(
          runStreamingRules(
            storage,
            crawlId,
            getGoldenBaselineConfig(),
            assetsWith([
              script("https://golden.test/_next/static/chunks/main.js", 3000, ["https://golden.test/"]),
              script("https://golden.test/app.js", 1000, ["https://golden.test/", "https://golden.test/a"]),
            ]),
          ),
        );
        expect(result.javascript).toEqual({
          scripts: 2,
          bytes: 4000,
          thirdPartyBytes: 0,
          unmeasured: 0,
          framework: { id: "nextjs", name: "Next.js", bytes: 3000 },
          heaviestPages: [
            { url: "https://golden.test/", bytes: 4000, scripts: 2 },
            { url: "https://golden.test/a", bytes: 1000, scripts: 1 },
          ],
        });
        const v1 = await run(generateReportFromStorage(storage, crawlId, result));
        const v2 = await run(buildV2Report(storage, crawlId, result));
        expect(v1.javascript).toEqual(result.javascript);
        expect(v2.javascript).toEqual(result.javascript);
      });
    },
    60_000,
  );

  test(
    "no script measured is no block; a block stamped on the crawl is the fallback",
    async () => {
      await withFixture("stamped", async (storage, crawlId) => {
        const result = await run(
          runStreamingRules(storage, crawlId, getGoldenBaselineConfig(), assetsWith([])),
        );
        expect(result.javascript).toBeUndefined();
        expect((await run(generateReportFromStorage(storage, crawlId, result))).javascript).toBeUndefined();

        const stamped: JavascriptShipped = {
          scripts: 1,
          bytes: 500,
          thirdPartyBytes: 0,
          unmeasured: 0,
          heaviestPages: [{ url: "https://golden.test/", bytes: 500, scripts: 1 }],
        };
        await run(storage.updateCrawl(crawlId, { javascript: stamped }));
        expect((await run(generateReportFromStorage(storage, crawlId, result))).javascript).toEqual(stamped);
        expect((await run(buildV2Report(storage, crawlId, result))).javascript).toEqual(stamped);
      });
    },
    60_000,
  );
});
