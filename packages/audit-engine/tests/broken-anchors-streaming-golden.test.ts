// links/broken-anchors - v1↔streaming parity on a real crawl (#706).
//
// The cross-page check reads each target page's ids from a record the streaming
// engine collects while the DOM is live (ctx.collectedSignals), and the v1 engine
// builds from the DOM. This seeds a generated crawl with two anchor links whose
// fragments name no element, runs both engines over the same storage, and
// requires the rule's findings to match exactly. Matched by the Engine Golden
// Gates CI glob (tests/*golden*.test.ts).

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
} from "./helpers/golden-baseline";

const RULE_ID = "links/broken-anchors";

const tmpDir = mkdtempSync(join(tmpdir(), "squirrelscan-broken-anchors-"));

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("links/broken-anchors — per-rule v1↔streaming identity", () => {
  test(
    "the anchor findings on a seeded crawl are identical on both engines",
    async () => {
      const model = buildGoldenBaselineModel();
      const [home, target] = model.pages;
      // A cross-page fragment whose target page has no such id, and a link from
      // the target page back to itself with a fragment no element carries.
      home!.outgoingLinks.push(`${target!.path}#no-such-section`);
      target!.outgoingLinks.push(`${target!.path}#also-missing`);

      const dbPath = join(tmpDir, "broken-anchors.sqlite");
      const { storage } = await writeCrawlToStorage(model, dbPath);
      await run(storage.close()); // each capture opens its own fresh connection

      const config = getGoldenBaselineConfig();
      const v1 = await captureEngineBaseline(dbPath, config);
      const v2 = await captureStreamingBaseline(dbPath, config);

      const v1Findings = v1.findings.filter((f) => f.ruleId === RULE_ID);
      const v2Findings = v2.findings.filter((f) => f.ruleId === RULE_ID);

      // The seeded links must actually be judged, or the identity proves nothing.
      expect(v1Findings.length).toBeGreaterThan(0);
      expect(v2Findings).toEqual(v1Findings);
    },
    180_000,
  );
});
