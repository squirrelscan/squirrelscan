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
      // 48 -> 49 (#1353). Every earlier +500 landed on a category whose score was
      // already far enough from a rounding boundary to absorb it; this one is not.
      // content/dev-leakage passes on all 500 pages, which lifts the content
      // category's pass ratio just past the point where the weighted overall
      // rounds up. A MOVE here is only correct alongside a deliberate rule
      // addition — if this number shifts on its own, a rule started failing.
      expect(v1.healthScore.overall).toBe(49);
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
      // 98220 -> 98221: perf/asset-compression, likewise site-scoped, adds its
      // own single whole-crawl check (#9). That check is `skipped` here — the
      // harness supplies empty resourceSizes/scripts pools, so the rule has no
      // sub-resource to judge — which is why the pass/warn/fail tallies and
      // healthScore.overall (48) are all UNMOVED and only the raw count shifts.
      // 98221 -> 98721: content/placeholder-text is page-scoped and always
      // speaks, so like content/hidden-text it emits one check across the 500
      // fixture pages that have a document (#1350). All 500 PASS, which is why
      // healthScore.overall is still 48: the synthetic site writes real copy.
      // 98721 -> 99221: content/unrendered-markup (#1352) is the same shape and
      // adds the same 500 — one check on each page with a document, the other
      // 18 having none. All 500 pass too: the fixture's copy carries no literal
      // markdown, so healthScore.overall was still 48 at that point.
      // 99221 -> 99721: content/dev-leakage (#1353) is the same shape again and
      // adds the same 500. All 500 pass: the fixture's origin is
      // `http://synthetic.test`, which is neither a dev host nor HTTPS, so
      // neither the host families nor the http-self-link kind can fire.
      expect(v1.findings.length).toBe(99721);
      // Tripwire: EXTENDING a rule must never add a tally key, so a change here
      // is only correct alongside a deliberate new rule id. 266 -> 267 is
      // content/hidden-text, 267 -> 268 content/thin-vs-site-norm, 268 -> 269
      // schema/coverage-outlier, 269 -> 270 url/slug-convention, 270 -> 271
      // core/canonical-form-drift, 271 -> 272 content/title-pattern-outlier,
      // 272 -> 273 schema/rating-scope, 273 -> 274 crawl/sitemap-lastmod-churn,
      // 274 -> 275 crawl/sitemap-lastmod-drift, 275 -> 276
      // content/date-agreement, 276 -> 277 links/no-contextual-inbound,
      // 277 -> 278 social/asset-divergence, 278 -> 279 perf/asset-compression,
      // 279 -> 280 content/placeholder-text, 280 -> 281
      // content/unrendered-markup, 281 -> 282 content/dev-leakage; anything
      // else means a rule id leaked in, so fix that rather than this number.
      expect(v1.perRuleTally.length).toBe(282);
      // Each +500 above is only "all passes" if nothing warned. healthScore
      // staying at 48 does not prove that — a handful of weight-5 warnings in a
      // 20-rule category would not move it — so pin the tally directly.
      const unrendered = v1.perRuleTally.find((t) => t.ruleId === "content/unrendered-markup");
      expect(unrendered).toEqual({
        ruleId: "content/unrendered-markup",
        pass: 500,
        warn: 0,
        fail: 0,
        info: 0,
        skipped: 0,
        total: 500,
      });
      const devLeakage = v1.perRuleTally.find((t) => t.ruleId === "content/dev-leakage");
      expect(devLeakage).toEqual({
        ruleId: "content/dev-leakage",
        pass: 500,
        warn: 0,
        fail: 0,
        info: 0,
        skipped: 0,
        total: 500,
      });
    },
    180_000,
  );
});
