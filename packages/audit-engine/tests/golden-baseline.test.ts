// v1 golden-baseline capture (#1021/#1022, blueprint §5). THE canonical
// fixture for the streaming-engine migration's correctness gate: a fixed-seed
// 500-page synthetic crawl with a rich seeded-issue mix, run through the
// CURRENT (v1) rule pipeline. Once the v2 streaming engine (PR-E, not built
// yet) exists, its own test captures the SAME crawl DB through v2 and calls
// `diffBaselines` against a snapshot captured here — zero divergence is the
// merge gate. This file only proves the v1 SIDE of that gate is itself sound:
// capturing twice yields a byte-identical snapshot.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeCrawlToStorage } from "@squirrelscan/synthetic-site";

import {
  buildGoldenBaselineModel,
  captureEngineBaseline,
  diffBaselines,
  getGoldenBaselineConfig,
  GOLDEN_BASELINE_PAGE_COUNT,
  run,
  serializeBaseline,
} from "./helpers/golden-baseline";

// THE canonical fixture (fixed seed + shape) now lives in ./helpers/golden-baseline
// so the v1 capture here and the v2 streaming gate build the IDENTICAL crawl.

const tmpDir = mkdtempSync(join(tmpdir(), "squirrelscan-golden-baseline-"));

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("v1 golden baseline — 500-page canonical fixture", () => {
  test("fixture generation is deterministic (sanity — synthetic-site's own contract)", () => {
    const a = buildGoldenBaselineModel();
    const b = buildGoldenBaselineModel();
    expect(a).toEqual(b);
    // Confirms the "rich issue mix" premise — every configured class actually landed.
    expect(a.issueSummary["duplicate-title"]).toBeGreaterThan(0);
    expect(a.issueSummary["orphan"]).toBe(15);
    expect(a.issueSummary["redirect-chain"]).toBe(18); // 6 chains * 3 hops
    expect(a.issueSummary["broken-link"]).toBe(20);
  });

  test(
    "captureEngineBaseline is deterministic — same crawl DB, captured twice, byte-identical",
    async () => {
      const model = buildGoldenBaselineModel();
      const dbPath = join(tmpDir, "determinism.sqlite");
      const { storage } = await writeCrawlToStorage(model, dbPath);
      await run(storage.close()); // capture opens its own fresh connection

      const config = getGoldenBaselineConfig();
      const first = await captureEngineBaseline(dbPath, config);
      const second = await captureEngineBaseline(dbPath, config);

      expect(serializeBaseline(first)).toBe(serializeBaseline(second));

      const diff = diffBaselines(first, second);
      expect(diff.identical).toBe(true);
      expect(diff.totalDivergences).toBe(0);
    },
    60_000,
  );

  test(
    "captures a real, non-trivial finding set and health score over the canonical fixture",
    async () => {
      const model = buildGoldenBaselineModel();
      const dbPath = join(tmpDir, "baseline-stats.sqlite");
      const { storage } = await writeCrawlToStorage(model, dbPath);
      await run(storage.close());

      const config = getGoldenBaselineConfig();
      const snapshot = await captureEngineBaseline(dbPath, config);

      // Sanity bounds, not exact-value pins (the exact numbers are the whole
      // point of "capture" — pinning them here would just be a second,
      // redundant golden file to keep in sync by hand).
      // >= not ===: redirect-chain hop pages are stored ADDITIONALLY beyond
      // pageCount by synthetic-site's own design (6 chains * 3 hops = +18
      // here) — see packages/synthetic-site/src/page-model.ts's applyRedirectChains.
      expect(snapshot.meta.pageCount).toBeGreaterThanOrEqual(GOLDEN_BASELINE_PAGE_COUNT);
      expect(snapshot.healthScore.overall).not.toBeNull();
      expect(snapshot.healthScore.overall).toBeGreaterThanOrEqual(0);
      expect(snapshot.healthScore.overall).toBeLessThanOrEqual(100);
      expect(snapshot.healthScore.categories.length).toBeGreaterThan(0);
      expect(snapshot.healthScore.groups.length).toBeGreaterThan(0);
      expect(snapshot.findings.length).toBeGreaterThan(1000);
      expect(snapshot.perRuleTally.length).toBeGreaterThan(50); // broad rule coverage

      // The seeded issue classes should be visible somewhere in the captured
      // surface — proves the pipeline actually READ the seeded content, not
      // just that it ran without throwing.
      const ruleIds = new Set(snapshot.perRuleTally.map((t) => t.ruleId));
      expect(ruleIds.has("content/duplicate-title")).toBe(true);
      expect(ruleIds.has("links/orphan-pages")).toBe(true);
      expect(ruleIds.has("links/broken-links")).toBe(true);

      // Human-readable baseline-stats line for #1021's PR description.
      console.log(
        `[golden-baseline] pages=${snapshot.meta.pageCount} findings=${snapshot.findings.length} ` +
          `rules=${snapshot.perRuleTally.length} healthScore=${snapshot.healthScore.overall} ` +
          `errors=${snapshot.healthScore.errorCount} warnings=${snapshot.healthScore.warningCount} ` +
          `passed=${snapshot.healthScore.passedCount}`,
      );
    },
    60_000,
  );

  test("diffBaselines reports zero divergences comparing a snapshot to itself", async () => {
    const model = buildGoldenBaselineModel();
    const dbPath = join(tmpDir, "diff-self.sqlite");
    const { storage } = await writeCrawlToStorage(model, dbPath);
    await run(storage.close());

    const config = getGoldenBaselineConfig();
    const snapshot = await captureEngineBaseline(dbPath, config);

    const diff = diffBaselines(snapshot, snapshot);
    expect(diff).toEqual({ identical: true, divergences: [], totalDivergences: 0 });
  }, 60_000);

  test("diffBaselines detects and reports an injected divergence, grouped by rule", async () => {
    const model = buildGoldenBaselineModel();
    const dbPath = join(tmpDir, "diff-mutated.sqlite");
    const { storage } = await writeCrawlToStorage(model, dbPath);
    await run(storage.close());

    const config = getGoldenBaselineConfig();
    const original = await captureEngineBaseline(dbPath, config);

    // Deliberately corrupt a copy: drop one finding, and skew the overall score.
    const mutated = structuredClone(original);
    mutated.findings = mutated.findings.slice(1);
    mutated.healthScore.overall = (mutated.healthScore.overall ?? 0) + 1;
    mutated.healthScore.errorCount += 1;

    const diff = diffBaselines(original, mutated, { maxDivergences: 10 });
    expect(diff.identical).toBe(false);
    expect(diff.totalDivergences).toBeGreaterThan(0);
    expect(diff.divergences.some((d) => d.kind === "score-mismatch")).toBe(true);
    expect(diff.divergences.some((d) => d.detail.startsWith("errorCount:"))).toBe(true);
    expect(diff.divergences.some((d) => d.kind === "finding-only-in-a")).toBe(true);
    // Sorted by ruleId — the report is actually readable, not insertion-order noise.
    const ruleIds = diff.divergences.map((d) => d.ruleId);
    expect(ruleIds).toEqual([...ruleIds].sort((a, b) => a.localeCompare(b)));
  }, 60_000);

  test("diffBaselines caps the divergence list but reports the true total", async () => {
    const model = buildGoldenBaselineModel();
    const dbPath = join(tmpDir, "diff-capped.sqlite");
    const { storage } = await writeCrawlToStorage(model, dbPath);
    await run(storage.close());

    const config = getGoldenBaselineConfig();
    const original = await captureEngineBaseline(dbPath, config);

    // Drop many findings — more divergences than the cap.
    const mutated = structuredClone(original);
    mutated.findings = mutated.findings.slice(20);

    const diff = diffBaselines(original, mutated, { maxDivergences: 5 });
    expect(diff.identical).toBe(false);
    expect(diff.divergences.length).toBe(5);
    expect(diff.totalDivergences).toBeGreaterThan(5);
  }, 60_000);
});
