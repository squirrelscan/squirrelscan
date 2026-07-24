// Per-rule byte-identical golden for the six all-pages DOM-scanner site rules
// converted to page-time collectors (#1021 E-E2 (a)). The canonical v1↔v2 gate
// (streaming-rules-canonical-golden) already proves the WHOLE finding set matches;
// this isolates each collector rule so a future regression names the exact rule.
//
// Both engines run over the SAME canonical fixture: v1 (runRulesOnStorage) scans
// each rule's DOM in the site pass; v2 (runStreamingRules) captures the per-page
// signal at page-time (ctx.collectedSignals) and the site pass reads it with no DOM
// resident. For each of the six rule IDs the emitted (checkName, status, pageUrl)
// finding set and the per-rule tally must be identical. Matched by the Engine
// Golden Gates CI glob (tests/*golden*.test.ts).

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeCrawlToStorage } from "@squirrelscan/synthetic-site";

import {
  buildGoldenBaselineModel,
  captureEngineBaseline,
  captureStreamingBaseline,
  getGoldenBaselineConfig,
  run,
  type EngineBaselineSnapshot,
} from "./helpers/golden-baseline";

// The six all-pages DOM scanners moved to page-time collectors in E-E2 (a).
const COLLECTOR_RULE_IDS = [
  "security/leaked-secrets",
  "perf/total-byte-weight",
  "integrity/template-discontinuity",
  "integrity/orphan-page",
  "adblock/blocked-links",
  "legal/subprocessor-disclosure",
] as const;

// Rules whose findings the canonical fixture is seeded to actually exercise (the
// DOM signal must have flowed through the collector, not just matched an empty
// set). adblock is cloud-gated (skipped offline) and subprocessor depends on the
// fixture's link text, so they are only required to MATCH, not to be non-empty.
const MUST_FIRE = new Set<string>([
  "security/leaked-secrets",
  "perf/total-byte-weight",
  "integrity/template-discontinuity",
  "integrity/orphan-page",
]);

const tmpDir = mkdtempSync(join(tmpdir(), "squirrelscan-collector-rules-"));

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function findingsFor(snapshot: EngineBaselineSnapshot, ruleId: string) {
  return snapshot.findings.filter((f) => f.ruleId === ruleId);
}
function tallyFor(snapshot: EngineBaselineSnapshot, ruleId: string) {
  return snapshot.perRuleTally.find((t) => t.ruleId === ruleId) ?? null;
}

describe("E-E2 collector rules — per-rule v1↔v2 byte-identity", () => {
  test(
    "each of the six DOM-scanner rules emits an identical finding set on both engines",
    async () => {
      const model = buildGoldenBaselineModel();
      const dbPath = join(tmpDir, "collector-rules.sqlite");
      const { storage } = await writeCrawlToStorage(model, dbPath);
      await run(storage.close()); // each capture opens its own fresh connection

      const config = getGoldenBaselineConfig();
      const v1 = await captureEngineBaseline(dbPath, config);
      const v2 = await captureStreamingBaseline(dbPath, config);

      for (const ruleId of COLLECTOR_RULE_IDS) {
        const v1Findings = findingsFor(v1, ruleId);
        const v2Findings = findingsFor(v2, ruleId);
        // Byte-identical finding set (already deterministically sorted in capture).
        expect(v2Findings).toEqual(v1Findings);
        // Per-rule tally (units the score is computed from) must match too.
        expect(tallyFor(v2, ruleId)).toEqual(tallyFor(v1, ruleId));

        if (MUST_FIRE.has(ruleId)) {
          expect(v1Findings.length).toBeGreaterThan(0);
        }
      }
    },
    180_000,
  );
});
