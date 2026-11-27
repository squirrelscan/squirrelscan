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

import { describe, expect, test } from "bun:test";

import {
  canonicalV1Snapshot,
  canonicalV2Snapshot,
  diffBaselines,
  GOLDEN_BASELINE_PAGE_COUNT,
  serializeBaseline,
} from "./helpers/golden-baseline";

describe("runStreamingRules — canonical 518-page v1↔v2 merge gate", () => {
  test("v2 streaming snapshot is byte-identical to the v1 baseline (zero divergences)", async () => {
    // Captured once per process and shared with the other canonical golden files.
    const v1 = await canonicalV1Snapshot();
    const v2 = await canonicalV2Snapshot();

    // The gate: readable, rule-grouped divergence report must be empty.
    const diff = diffBaselines(v1, v2);
    if (!diff.identical) {
      // Surface the (capped) divergence report so a failure is actionable.
      throw new Error(
        `v1↔v2 divergence: ${diff.totalDivergences} total\n` +
          diff.divergences
            .map((d) => `  [${d.kind}] ${d.ruleId}: ${d.detail}`)
            .join("\n")
      );
    }
    expect(diff).toEqual({
      identical: true,
      divergences: [],
      totalDivergences: 0,
    });
    // Byte-identical serialization is the strongest form of the same claim.
    expect(serializeBaseline(v2)).toBe(serializeBaseline(v1));

    // Pinned canonical stats (v1 == v2) — proves the fixture is the real,
    // rich, at-scale one, not a degenerate crawl. Exact pins double as a
    // rule-surface drift tripwire (see golden-baseline.test.ts for the same fixture).
    expect(v1.meta.pageCount).toBeGreaterThanOrEqual(
      GOLDEN_BASELINE_PAGE_COUNT
    );
    // 48 -> 49 (#1353). Every earlier +500 landed on a category whose score was
    // already far enough from a rounding boundary to absorb it; this one is not.
    // content/dev-leakage passes on all 500 pages, which lifts the content
    // category's pass ratio just past the point where the weighted overall
    // rounds up. A MOVE here is only correct alongside a deliberate rule
    // addition — if this number shifts on its own, a rule started failing.
    // 49 -> 50 (pub#487): crawl/indexability-conflicts no longer warns on
    // robots.txt Allow plus noindex, the supported way to deindex a page.
    // 50 -> 51: security/token-storage passes on all 500 pages, which lifts the
    // security score just past the point where the weighted overall rounds up,
    // the same shape as 48 -> 49 above. main alone is 50 (verified with the rule
    // removed), so the move comes from this deliberate rule addition.
    // 51 -> 52 (#110): links/anchor-mismatch judges 1,547 link pairs on the synthetic site and
    // passes (a real pass, not a vacuous one: a run that judges nothing is skipped), and that
    // one extra pass lifts the weighted overall past a rounding boundary. A deliberate rule
    // addition again; without the rule the number is 51.
    // 52 -> 53: the 2026-11 rule batch (nine new rules: crawl/rendered-signal-mismatch, a11y/svg-img-alt,
    // security/password-form-get, url/session-ids, crawl/indexable-search-results, links/click-depth,
    // analytics/duplicate-tags, i18n/hreflang-targets, content/duplicate-content). Their passes lift the weighted
    // overall past one more rounding boundary. The skipped and info rows among them do not score; the one warn row, links/click-depth
    // on the synthetic site, is also a finding (it is among the 105251 below) and counts in that move too.
    // 53 -> 54 (#1741): the integrity page rules (brand-impersonation, fake-auth-overlay, obfuscated-script,
    // seo-doorway) now PASS on every page they read instead of saying nothing, which lifts the weighted overall
    // past one more rounding boundary. A deliberate change: a clean run is a check, not an empty list.
    // 54 -> 56 (#1765): core/meta-title, core/meta-description and links/internal-links report too short and too
    // long as separate checks, so a page inside both limits records two passes where it recorded one. More
    // passes lift the weighted overall past two more rounding boundaries. Failing pages are unchanged.
    // 56 -> 57 (#711): a11y/reduced-motion adds a pass row on each of the 500 pages with a document (the
    // fixture has no looping animation or smooth scrolling), which lifts the weighted overall past one more
    // rounding boundary. Without the rule the number is 56.
    // 57 -> 58 (release batch 2): needs BOTH content/conversion-path (a pass row on each of the 100
    // synthetic /product/ pages, money pages by path with no prominent call to action, and a not-applicable
    // skip on the other 400) AND content/near-duplicate (one site pass). Together they lift the weighted
    // overall past one more rounding boundary; without either one (or both) the number is 57.
    // ax/commerce-readiness adds an info row on each of the 500 pages (the harness has no site type, and no
    // page carries Product markup) and does not move it.
    // #2350: a11y/svg-img-alt, mobile/input-zoom and security/password-form-get emit a declared skipped
    // (not-applicable) row on each of the 500 pages that have nothing in their scope, and a11y/aria-labels
    // does the same (no button). schema/website-search emits one on each of the 499 pages other than the
    // home page, which keeps its info row (1 to 500). Skipped rows do not score, so the number stays 58 and
    // only those five per-rule totals move.
    // 58 -> 59 (#2334): security/info-disclosure passes on all 500 pages (the synthetic site shows no stack
    // trace, path, debug page or database error), which lifts the weighted overall past one more rounding
    // boundary, the same shape as security/token-storage above. Without the rule the number is 58.
    expect(v1.healthScore.overall).toBe(59);
    // Per-rule finding totals live in golden/canonical-rule-totals.json, one
    // sorted line per rule, so two new-rule PRs touch different lines and
    // rebase cleanly (#2055). There is no grand total or rule count to edit:
    // both are derived below. A new rule adds one line; EXTENDING a rule moves
    // its own line only. A rule id appearing or vanishing without a deliberate
    // rule change means one leaked in, so fix that rather than the file.
    const expectedTotals = (await Bun.file(
      new URL("./golden/canonical-rule-totals.json", import.meta.url)
    ).json()) as Record<string, number>;
    const actualTotals = Object.fromEntries(
      v1.perRuleTally.map((t) => [t.ruleId, t.total])
    );
    expect(Object.keys(actualTotals).sort()).toEqual(
      Object.keys(expectedTotals).sort()
    );
    expect(actualTotals).toEqual(expectedTotals);
    expect(v1.findings.length).toBe(
      Object.values(expectedTotals).reduce((sum, n) => sum + n, 0)
    );
    expect(
      v1.perRuleTally.find((t) => t.ruleId === "security/tls-certificate")
    ).toEqual({
      ruleId: "security/tls-certificate",
      pass: 0,
      warn: 0,
      fail: 0,
      info: 0,
      skipped: 1,
      total: 1,
    });
    expect(
      v1.perRuleTally.find((t) => t.ruleId === "reliability/broken-forms")
    ).toEqual({
      ruleId: "reliability/broken-forms",
      pass: 0,
      warn: 0,
      fail: 0,
      info: 1,
      skipped: 0,
      total: 1,
    });
    expect(
      v1.perRuleTally.find((t) => t.ruleId === "mobile/web-app-manifest")
    ).toEqual({
      ruleId: "mobile/web-app-manifest",
      pass: 0,
      warn: 0,
      fail: 0,
      info: 0,
      // A probe that was never sent is skipped with a coded reason (#1794), not an info note.
      skipped: 1,
      total: 1,
    });
    expect(
      v1.perRuleTally.find((t) => t.ruleId === "content/common-misspellings")
    ).toEqual({
      ruleId: "content/common-misspellings",
      pass: 1,
      warn: 0,
      fail: 0,
      info: 0,
      skipped: 0,
      total: 1,
    });
    expect(
      v1.perRuleTally.find((t) => t.ruleId === "links/broken-anchors")
    ).toEqual({
      ruleId: "links/broken-anchors",
      pass: 1,
      warn: 0,
      fail: 0,
      info: 0,
      skipped: 0,
      total: 1,
    });
    expect(
      v1.perRuleTally.find((t) => t.ruleId === "reliability/broken-resources")
    ).toEqual({
      ruleId: "reliability/broken-resources",
      pass: 0,
      warn: 0,
      fail: 0,
      info: 1,
      skipped: 0,
      total: 1,
    });
    for (const [ruleId, outcome] of [
      ["security/security-txt", "skipped"],
      ["security/version-disclosure", "skipped"],
    ] as const) {
      expect(v1.perRuleTally.find((t) => t.ruleId === ruleId)).toEqual({
        ruleId,
        pass: 0,
        warn: 0,
        fail: 0,
        info: 0,
        skipped: 0,
        [outcome as string]: 1,
        total: 1,
      });
    }
    // Passive: the probing rules skip without sending a request.
    for (const ruleId of [
      "security/graphql-introspection",
      "security/graphql-get-mutations",
      "security/unauthenticated-api",
      "security/unpaginated-api",
      "security/json-sensitive-fields",
      "security/exposed-files",
      "security/exposed-backups",
      "security/auth-endpoint-disclosure",
      "security/open-redirect",
      "security/query-error-fuzz",
      "security/client-side-authz",
      "security/exposed-actuator",
      "security/http-methods",
    ]) {
      expect(v1.perRuleTally.find((t) => t.ruleId === ruleId)).toEqual({
        ruleId,
        pass: 0,
        warn: 0,
        fail: 0,
        info: 0,
        skipped: 1,
        total: 1,
      });
    }
    const cspBlocks = v1.perRuleTally.find(
      (t) => t.ruleId === "security/csp-blocks-own-resources"
    );
    expect(cspBlocks).toEqual({
      ruleId: "security/csp-blocks-own-resources",
      pass: 500,
      warn: 0,
      fail: 0,
      info: 0,
      skipped: 0,
      total: 500,
    });
    // Each +500 above is only "all passes" if nothing warned. healthScore
    // staying at 48 does not prove that — a handful of weight-5 warnings in a
    // 20-rule category would not move it — so pin the tally directly.
    const unrendered = v1.perRuleTally.find(
      (t) => t.ruleId === "content/unrendered-markup"
    );
    expect(unrendered).toEqual({
      ruleId: "content/unrendered-markup",
      pass: 500,
      warn: 0,
      fail: 0,
      info: 0,
      skipped: 0,
      total: 500,
    });
    const placeholderContact = v1.perRuleTally.find(
      (t) => t.ruleId === "content/placeholder-contact"
    );
    expect(placeholderContact).toEqual({
      ruleId: "content/placeholder-contact",
      pass: 500,
      warn: 0,
      fail: 0,
      info: 0,
      skipped: 0,
      total: 500,
    });
    const tokenStorage = v1.perRuleTally.find(
      (t) => t.ruleId === "security/token-storage"
    );
    expect(tokenStorage).toEqual({
      ruleId: "security/token-storage",
      pass: 500,
      warn: 0,
      fail: 0,
      info: 0,
      skipped: 0,
      total: 500,
    });
    const devLeakage = v1.perRuleTally.find(
      (t) => t.ruleId === "content/dev-leakage"
    );
    expect(devLeakage).toEqual({
      ruleId: "content/dev-leakage",
      pass: 500,
      warn: 0,
      fail: 0,
      info: 0,
      skipped: 0,
      total: 500,
    });
  }, 180_000);
});
