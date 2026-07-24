// CANONICAL MERGE GATE (#1021, PR-E, blueprint §5): the streaming engine (v2,
// runStreamingRules) vs the current engine (v1, runRulesOnStorage) over THE
// canonical 518-page fixture — the strongest single assertion available (full
// default rule surface at meaningful scale, readable divergence output).
//
// Both sides capture an EngineBaselineSnapshot from the SAME on-disk crawl DB and
// diffBaselines them: zero divergence (healthScore overall/category/group,
// per-rule tally, full finding set, report summary) is the gate. This is the v2
// side of the pairing golden-baseline.test.ts sets up for v1. Kept in its own
// file (matched by the Golden-Gates glob) so the fast small-fixture direct-compares
// in streaming-rules-golden.test.ts still fail fast independently.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeCrawlToStorage } from "@squirrelscan/synthetic-site";

import {
  buildGoldenBaselineModel,
  captureEngineBaseline,
  captureStreamingBaseline,
  diffBaselines,
  getGoldenBaselineConfig,
  GOLDEN_BASELINE_PAGE_COUNT,
  run,
  serializeBaseline,
} from "./helpers/golden-baseline";

const tmpDir = mkdtempSync(join(tmpdir(), "squirrelscan-streaming-canonical-"));

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("runStreamingRules — canonical 518-page v1↔v2 merge gate", () => {
  test(
    "v2 streaming snapshot is byte-identical to the v1 baseline (zero divergences)",
    async () => {
      const model = buildGoldenBaselineModel();
      const dbPath = join(tmpDir, "canonical.sqlite");
      const { storage } = await writeCrawlToStorage(model, dbPath);
      await run(storage.close()); // each capture opens its own fresh connection

      const config = getGoldenBaselineConfig();
      const v1 = await captureEngineBaseline(dbPath, config);
      const v2 = await captureStreamingBaseline(dbPath, config);

      // The gate: readable, rule-grouped divergence report must be empty.
      const diff = diffBaselines(v1, v2);
      if (!diff.identical) {
        // Surface the (capped) divergence report so a failure is actionable.
        throw new Error(
          `v1↔v2 divergence: ${diff.totalDivergences} total\n` +
            diff.divergences.map((d) => `  [${d.kind}] ${d.ruleId}: ${d.detail}`).join("\n"),
        );
      }
      expect(diff).toEqual({ identical: true, divergences: [], totalDivergences: 0 });
      // Byte-identical serialization is the strongest form of the same claim.
      expect(serializeBaseline(v2)).toBe(serializeBaseline(v1));

      // Pinned canonical stats (v1 == v2) — proves the fixture is the real,
      // rich, at-scale one, not a degenerate crawl. Exact pins double as a
      // rule-surface drift tripwire (see golden-baseline.test.ts for the same fixture).
      expect(v1.meta.pageCount).toBeGreaterThanOrEqual(GOLDEN_BASELINE_PAGE_COUNT);
      expect(v1.healthScore.overall).toBe(48);
      expect(v1.findings.length).toBe(94709);
      expect(v1.perRuleTally.length).toBe(262);
    },
    180_000,
  );
});
