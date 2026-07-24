// #747 — quick-coverage runs read as broken on paid plans. Quick coverage skips
// ALL cloud enrichment by design, so a signed-in quick report must frame locked
// cloud rules as a coverage choice ("re-run with -C surface/full"), never a
// cloud outage, and must show the Agents score slot as a locked placeholder
// instead of silently omitting it.

import { describe, expect, test } from "bun:test";

import type { GroupScore, HealthScore } from "@squirrelscan/core-contracts";
import type { AuditReport } from "../src/types";
import { renderHtml } from "../src/output/html";

const QUICK_COPY = "cloud checks don&#x27;t run in quick coverage";
const OUTAGE_COPY = "temporarily unavailable";
const HTTP_COPY = "without cloud rendering (--http)";
const FAILED_COPY = "need a completed audit to run";
const SIGNUP_COPY = "free squirrelscan account";
const LOCKED_SLOT = 'class="group-circle group-circle-locked"';

function baseReport(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-06-16T14:30:00.000Z",
    totalPages: 25,
    passed: 10,
    warnings: 0,
    failed: 0,
    ruleResults: {},
    lockedRules: [
      { id: "ai/llm-parsability", name: "LLM Parsability" },
      { id: "ai/site-metadata", name: "Site Metadata" },
    ],
    ...overrides,
  };
}

function group(code: GroupScore["group"], score = 90): GroupScore {
  return { group: code, name: code, score, passed: 5, warnings: 0, failed: 0, total: 5 };
}

/** Health score with the ai group missing — the quick-run fingerprint (zero ai weight). */
function scoreWithoutAi(): HealthScore {
  return {
    overall: 90,
    categories: [],
    groups: [group("seo"), group("performance"), group("security")],
    errorCount: 0,
    warningCount: 0,
    passedCount: 5,
  };
}

describe("LockedRulesSection quick-coverage copy (#747)", () => {
  test("paid + quick gets the coverage hint, not the outage copy", () => {
    const html = renderHtml(baseReport({ cloudPlan: "paid", coverageMode: "quick" }));
    expect(html).toContain(QUICK_COPY);
    expect(html).toContain("-C surface or -C full");
    expect(html).not.toContain(OUTAGE_COPY);
  });

  test("free + quick gets the coverage hint, not the credits upsell", () => {
    const html = renderHtml(baseReport({ cloudPlan: "free", coverageMode: "quick" }));
    expect(html).toContain(QUICK_COPY);
    expect(html).not.toContain("out of credits");
  });

  test("paid outage copy stays for surface/full and unstamped reports", () => {
    for (const coverageMode of ["surface", "full", undefined] as const) {
      const html = renderHtml(baseReport({ cloudPlan: "paid", coverageMode }));
      expect(html).toContain(OUTAGE_COPY);
      expect(html).not.toContain(QUICK_COPY);
    }
  });

  test("anonymous + quick keeps the signup upsell", () => {
    const html = renderHtml(baseReport({ coverageMode: "quick" }));
    expect(html).toContain(SIGNUP_COPY);
    expect(html).not.toContain(QUICK_COPY);
  });

  test("failed audit wins over quick — nothing ran, cloud or local", () => {
    const html = renderHtml(
      baseReport({ cloudPlan: "paid", coverageMode: "quick", status: "failed" }),
    );
    expect(html).toContain(FAILED_COPY);
    expect(html).not.toContain(QUICK_COPY);
  });

  test("quick wins over --http — cloud never runs in quick regardless of render mode", () => {
    const html = renderHtml(
      baseReport({ cloudPlan: "paid", coverageMode: "quick", cloudMode: "http" }),
    );
    expect(html).toContain(QUICK_COPY);
    expect(html).not.toContain(HTTP_COPY);
  });

  test("--http opt-out copy stays for non-quick runs", () => {
    const html = renderHtml(
      baseReport({ cloudPlan: "paid", coverageMode: "surface", cloudMode: "http" }),
    );
    expect(html).toContain(HTTP_COPY);
    expect(html).not.toContain(QUICK_COPY);
  });
});

describe("Agents locked score slot (#747)", () => {
  test("signed-in quick run with no ai group renders the locked placeholder", () => {
    const html = renderHtml(
      baseReport({ cloudPlan: "paid", coverageMode: "quick", healthScore: scoreWithoutAi() }),
    );
    expect(html).toContain(LOCKED_SLOT);
    expect(html).toContain("Agents");
    expect(html).toContain("not scored in quick coverage");
  });

  test("no placeholder when the ai group scored (cloud checks ran)", () => {
    const score = scoreWithoutAi();
    score.groups!.push(group("ai"));
    const html = renderHtml(
      baseReport({ cloudPlan: "paid", coverageMode: "quick", healthScore: score }),
    );
    expect(html).not.toContain(LOCKED_SLOT);
  });

  test("no placeholder on surface/full or anonymous runs", () => {
    const surface = renderHtml(
      baseReport({ cloudPlan: "paid", coverageMode: "surface", healthScore: scoreWithoutAi() }),
    );
    expect(surface).not.toContain(LOCKED_SLOT);

    const anon = renderHtml(baseReport({ coverageMode: "quick", healthScore: scoreWithoutAi() }));
    expect(anon).not.toContain(LOCKED_SLOT);
  });
});
