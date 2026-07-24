// Debug-summary formatting for the per-phase audit timer (#857). The map is
// built by sequential markPhase() calls in runAudit, so key insertion order
// already matches execution order — formatPhaseTimings just renders it.

import { describe, expect, test } from "bun:test";

import { formatPhaseTimings, PhaseTimer } from "../../src/controllers/audit";

describe("PhaseTimer (#871 — a crash mid-phase must still attribute)", () => {
  test("mark() records elapsed ms and clears the in-flight phase", () => {
    const timer = new PhaseTimer<"crawl" | "rules">();
    timer.enter("crawl");
    timer.mark("crawl");
    expect(Object.keys(timer.timingsMs)).toEqual(["crawl"]);
    // Nothing in flight anymore — a subsequent attributeInFlight() is a no-op.
    timer.attributeInFlight();
    expect(Object.keys(timer.timingsMs)).toEqual(["crawl"]);
  });

  test("attributeInFlight() assigns elapsed time to a phase that entered but never marked — the wedged-crawl case", () => {
    const timer = new PhaseTimer<"crawl" | "rules">();
    timer.enter("crawl");
    // ...crash here, before timer.mark("crawl") ever runs...
    timer.attributeInFlight();
    expect(Object.keys(timer.timingsMs)).toEqual(["crawl"]);
    expect(timer.timingsMs.crawl).toBeGreaterThanOrEqual(0);
  });

  test("attributeInFlight() is a no-op when nothing was entered (crash before the first phase)", () => {
    const timer = new PhaseTimer<"crawl">();
    timer.attributeInFlight();
    expect(timer.timingsMs).toEqual({});
  });

  test("a skipped phase's cursor rolls into whichever phase actually runs next", () => {
    const timer = new PhaseTimer<"external_links" | "assets">();
    // external_links is conditionally skipped entirely (no enter() call for
    // it), matching runAudit()'s `if (config.enabled) { enter(...); ...; mark(...) }`.
    timer.enter("assets");
    timer.mark("assets");
    expect(Object.keys(timer.timingsMs)).toEqual(["assets"]);
  });

  test("multi-phase sequence: only the truly in-flight phase gets attributed on a crash", () => {
    const timer = new PhaseTimer<"crawl" | "external_links" | "rules">();
    timer.enter("crawl");
    timer.mark("crawl");
    timer.enter("external_links");
    timer.mark("external_links");
    timer.enter("rules");
    // ...crash during rules...
    timer.attributeInFlight();
    expect(Object.keys(timer.timingsMs)).toEqual([
      "crawl",
      "external_links",
      "rules",
    ]);
  });

  test("resetCursor() excludes prior setup time from the next entered phase", async () => {
    const timer = new PhaseTimer<"crawl">();
    await new Promise((resolve) => setTimeout(resolve, 20)); // simulated setup time
    timer.resetCursor();
    timer.enter("crawl");
    timer.mark("crawl");
    // Elapsed reflects time since resetCursor(), not since PhaseTimer construction.
    expect(timer.timingsMs.crawl).toBeLessThan(20);
  });
});

describe("formatPhaseTimings", () => {
  test("empty map → just the (zero) total", () => {
    expect(formatPhaseTimings({})).toBe("total=0.0s");
  });

  test("renders phases in insertion order, 1-decimal seconds, plus a total", () => {
    const line = formatPhaseTimings({
      crawl: 47_200,
      rules: 237_400,
      report: 62_100,
    });
    expect(line).toBe("crawl=47.2s rules=237.4s report=62.1s total=346.7s");
  });

  test("a phase that didn't run is simply absent, not zeroed", () => {
    const line = formatPhaseTimings({ crawl: 1_000, rules: 2_000 });
    expect(line).not.toContain("external_links");
    expect(line).not.toContain("cloud_prefetch");
    expect(line).toBe("crawl=1.0s rules=2.0s total=3.0s");
  });

  test("sub-second phases round to one decimal, not zero", () => {
    expect(formatPhaseTimings({ assets: 940 })).toBe("assets=0.9s total=0.9s");
  });
});
