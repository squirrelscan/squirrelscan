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
      // 97711 -> 98211: content/hidden-text emits one page check across the 500
      // fixture pages that have a document, and passes on every one of them. The
      // overall score is unmoved.
      // 98211 -> 98212: content/thin-vs-site-norm is site-scoped, so it adds
      // exactly ONE check for the whole crawl (#1362).
      // 98212 -> 98213: schema/coverage-outlier, likewise site-scoped, adds its
      // own single whole-crawl check (#1363).
      // 98213 -> 98214: url/slug-convention, likewise site-scoped, adds its own
      // single whole-crawl check (#1365).
      // 98214 -> 98215: core/canonical-form-drift, likewise site-scoped, adds its
      // own single whole-crawl check (#1366).
      // 98215 -> 98216: content/title-pattern-outlier, likewise site-scoped, adds
      // its own single whole-crawl check (#1361).
      // Unmoved by schema/rating-scope (#106): it is page-scoped but speaks ONLY
      // when a page carries an AggregateRating, and the fixture emits no JSON-LD
      // at all — so it contributes a tally key below without a single finding.
      // 98216 -> 98217: crawl/sitemap-lastmod-churn, likewise site-scoped, adds
      // its own single whole-crawl check (#105).
      // 98217 -> 98218: crawl/sitemap-lastmod-drift, likewise site-scoped, adds
      // its own single whole-crawl check (#107).
      // Unmoved by content/date-agreement (#108): like schema/rating-scope it is
      // page-scoped but speaks ONLY when a page carries a date on a
      // document-describing schema node, and the fixture emits no JSON-LD at all —
      // so it contributes a tally key below without a single finding.
      // 98218 -> 98219: links/no-contextual-inbound, likewise site-scoped, adds
      // its own single whole-crawl check (#109). It PASSES on this fixture: the
      // only chrome link the renderer emits is the header nav's link to `/`, and
      // the homepage is exempt, so every other page's contextual count equals its
      // raw count.
      // 98219 -> 98220: social/asset-divergence, likewise site-scoped, adds its
      // own single whole-crawl check (#1371). healthScore.overall is UNMOVED at
      // 48: one weight-3 warning check in a 5-rule category cannot dominate it.
      expect(v1.findings.length).toBe(98220);
      // Tripwire: EXTENDING a rule must never add a tally key, so a change here
      // is only correct alongside a deliberate new rule id. 266 -> 267 is
      // content/hidden-text, 267 -> 268 content/thin-vs-site-norm, 268 -> 269
      // schema/coverage-outlier, 269 -> 270 url/slug-convention, 270 -> 271
      // core/canonical-form-drift, 271 -> 272 content/title-pattern-outlier,
      // 272 -> 273 schema/rating-scope, 273 -> 274 crawl/sitemap-lastmod-churn,
      // 274 -> 275 crawl/sitemap-lastmod-drift, 275 -> 276
      // content/date-agreement, 276 -> 277 links/no-contextual-inbound,
      // 277 -> 278 social/asset-divergence; anything else means a rule id
      // leaked in, so fix that rather than this number.
      expect(v1.perRuleTally.length).toBe(278);
    },
    180_000,
  );
});
