// repo#2302: the CLI's real JSON report is rebuilt from SQLite, so a check's
// `observation` has to make the whole trip: saveRuleResults, reconstructReport,
// generateJsonReport. An in-memory report test cannot see this path.

import type { CrawlMetadata } from "@squirrelscan/core-contracts/storage";

import { describe, expect, spyOn, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SQLiteStorage } from "@/crawler/storage/sqlite";
import { generateJsonReport } from "@/reports/output/json";
import { reconstructReport } from "@/reports/reconstruct";

const SITE = "https://example.com";
const OBSERVATION = {
  mode: "static" as const,
  applicability: "applicable" as const,
  uncertainty: "Only the initial HTML was inspected.",
};

function run<A>(effect: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(Effect.orDie(effect));
}

describe("observation in the stored-audit JSON report (repo#2302)", () => {
  test("a stored check's observation reaches issues[].checks[] and an unobserved check carries none", async () => {
    const store = new SQLiteStorage(":memory:");
    await run(store.init());
    const crawlId = await run(
      store.createCrawl({
        baseUrl: SITE,
        originalUrl: SITE,
        startedAt: 1,
        status: "analyzed",
        config: { maxPages: 1 } as CrawlMetadata["config"],
        stats: {
          pagesTotal: 1,
          pagesFetched: 1,
          pagesFailed: 0,
          pagesSkipped: 0,
          pagesUnchanged: 0,
          linksTotal: 0,
          imagesTotal: 0,
          bytesTotal: 0,
          avgLoadTimeMs: 0,
        },
      })
    );
    await run(
      store.saveRuleResults(crawlId, `${SITE}/`, "core/meta-title", [
        {
          name: "title-length",
          status: "warn",
          message: "Title is too short",
          observation: OBSERVATION,
        },
        { name: "title-present", status: "fail", message: "Title missing" },
      ])
    );

    const report = await run(reconstructReport(store, crawlId));
    const dir = mkdtempSync(join(tmpdir(), "sq-2302-"));
    try {
      const out = join(dir, "r.json");
      const err = spyOn(console, "error").mockImplementation(() => {});
      try {
        generateJsonReport(report, out);
      } finally {
        err.mockRestore();
      }
      const json = JSON.parse(readFileSync(out, "utf8")) as {
        issues: Array<{
          ruleId: string;
          checks: Array<{ name: string; observation?: unknown }>;
        }>;
      };
      const checks = json.issues.find(
        (i) => i.ruleId === "core/meta-title"
      )!.checks;
      expect(
        checks.find((c) => c.name === "title-length")!.observation
      ).toEqual(OBSERVATION);
      expect(checks.find((c) => c.name === "title-present")).not.toHaveProperty(
        "observation"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
