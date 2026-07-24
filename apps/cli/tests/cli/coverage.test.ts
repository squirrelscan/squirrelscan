import { describe, expect, test } from "bun:test";

import {
  COVERAGE_MODES,
  coverageMaxPages,
  defaultCoverageMode,
  defaultSmartAudits,
  normalizeCoverageMode,
} from "@/cli/coverage";
import {
  COVERAGE_FULL_MAX_PAGES,
  COVERAGE_QUICK_MAX_PAGES,
  COVERAGE_SURFACE_MAX_PAGES,
} from "@/constants";

describe("normalizeCoverageMode", () => {
  test("accepts the canonical modes", () => {
    expect(normalizeCoverageMode("quick")).toBe("quick");
    expect(normalizeCoverageMode("surface")).toBe("surface");
    expect(normalizeCoverageMode("full")).toBe("full");
  });

  test("aliases 'fast' to 'quick' (the bug that produced `max NaN pages`)", () => {
    expect(normalizeCoverageMode("fast")).toBe("quick");
    expect(normalizeCoverageMode("FAST")).toBe("quick");
  });

  test("is case-insensitive and trims whitespace", () => {
    expect(normalizeCoverageMode("  Full  ")).toBe("full");
    expect(normalizeCoverageMode("SURFACE")).toBe("surface");
  });

  test("returns null for unknown modes (caller errors instead of NaN cap)", () => {
    expect(normalizeCoverageMode("turbo")).toBeNull();
    expect(normalizeCoverageMode("")).toBeNull();
    expect(normalizeCoverageMode("quickk")).toBeNull();
  });
});

describe("coverageMaxPages", () => {
  test("maps each mode to its default page budget", () => {
    expect(coverageMaxPages("quick")).toBe(COVERAGE_QUICK_MAX_PAGES);
    expect(coverageMaxPages("surface")).toBe(COVERAGE_SURFACE_MAX_PAGES);
    expect(coverageMaxPages("full")).toBe(COVERAGE_FULL_MAX_PAGES);
  });

  test("returns a finite integer budget for every valid mode", () => {
    for (const mode of COVERAGE_MODES) {
      expect(Number.isInteger(coverageMaxPages(mode))).toBe(true);
    }
  });
});

describe("defaultCoverageMode", () => {
  test("paid plan → surface (cloud rules + summary run)", () => {
    expect(defaultCoverageMode("paid")).toBe("surface");
  });

  test("free plan → surface (pro-parity demo #684)", () => {
    expect(defaultCoverageMode("free")).toBe("surface");
  });

  test("anonymous → quick (fast, free, no cloud)", () => {
    expect(defaultCoverageMode("anonymous")).toBe("quick");
  });
});

describe("defaultSmartAudits (#684)", () => {
  test("signed-in (free or paid, no outage) → on", () => {
    expect(defaultSmartAudits("free", null)).toBe(true);
    expect(defaultSmartAudits("paid", null)).toBe(true);
  });

  test("anonymous, no outage → off", () => {
    expect(defaultSmartAudits("anonymous", null)).toBe(false);
  });

  test("expired token → still on (local store; auth hiccup must not flip it)", () => {
    // Expired collapses accountPlan to "anonymous", but the outage proves an
    // account exists — smart audits is local SQLite and needs no cloud.
    expect(defaultSmartAudits("anonymous", "expired")).toBe(true);
  });

  test("unreachable cloud → still on for a signed-in user", () => {
    expect(defaultSmartAudits("anonymous", "unreachable")).toBe(true);
    expect(defaultSmartAudits("paid", "unreachable")).toBe(true);
  });
});
