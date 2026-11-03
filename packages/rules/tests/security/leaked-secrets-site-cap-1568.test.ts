// security/leaked-secrets: probes of the site-wide cap on kept findings (#1568): pages under the per-page cap cannot add up to an unbounded total.
// Values are built at runtime from parts; no secret-shaped literal is committed.

import { describe, expect, test } from "bun:test";
import { parsePage } from "@squirrelscan/parser";

import { applySiteFindingBudget, buildCollectedPageSignal, type CollectedPageSignal } from "../../src/collected-signals";
import {
  createSiteFindingBudget,
  leakedSecretsRule,
  type LeakedSecret,
  PAGE_FINDINGS_CAP,
  SITE_FINDINGS_CAP,
} from "../../src/security/leaked-secrets";
import type { RuleContext } from "../../src/types";

type Tier = 0 | 1 | 2 | 3;
const fake = (tier: Tier, name: string): LeakedSecret => ({
  type: tier === 0 ? "Stripe Live Key" : tier === 3 ? "Public Key" : "Some Pattern",
  value: `${tier}-${name}`,
  confidence: tier === 3 ? "info" : tier === 2 ? "medium" : "high",
  publicByDesign: false,
  location: tier === 0 ? "inline-script" : "html",
  length: 8,
  offset: 0,
});

describe("the site budget: pages under the page cap cannot add up to an unbounded total (#1568)", () => {
  test("the cap is above one page's and well below a crawl's worth", () => {
    expect(SITE_FINDINGS_CAP).toBeGreaterThan(PAGE_FINDINGS_CAP);
    expect(SITE_FINDINGS_CAP).toBeLessThanOrEqual(PAGE_FINDINGS_CAP * 20);
  });

  test("100 pages of 900 distinct findings each keep at most the site cap, and the rest are counted", () => {
    const budget = createSiteFindingBudget();
    let kept = 0;
    let omitted = 0;
    for (let p = 0; p < 100; p++) {
      const page = Array.from({ length: 900 }, (_, i) => fake(2, `${p}-${i}`));
      const out = budget.admit(page);
      kept += out.secrets.length;
      omitted += out.omitted;
    }
    expect(kept).toBeLessThanOrEqual(SITE_FINDINGS_CAP);
    expect(kept).toBeGreaterThan(0);
    expect(kept + omitted).toBe(90_000);
  });

  test("a flood of low findings cannot take the room of a critical one on a later page", () => {
    const budget = createSiteFindingBudget();
    for (let p = 0; p < 100; p++) budget.admit(Array.from({ length: 900 }, (_, i) => fake(3, `${p}-${i}`)));
    const late = budget.admit(Array.from({ length: 300 }, (_, i) => fake(0, `late-${i}`)));
    expect(late.secrets).toHaveLength(300);
    expect(late.omitted).toBe(0);
  });

  test("every tier is preferred in turn: medium findings cannot starve high ones", () => {
    const budget = createSiteFindingBudget();
    for (let p = 0; p < 100; p++) budget.admit(Array.from({ length: 900 }, (_, i) => fake(2, `${p}-${i}`)));
    const high = budget.admit(Array.from({ length: 500 }, (_, i) => fake(1, `h-${i}`)));
    expect(high.secrets).toHaveLength(500);
  });

  test("the same 900 values on 200 pages are copies the rule merges: bounded, the dropped copies counted and never serious", () => {
    const budget = createSiteFindingBudget();
    let kept = 0;
    let omitted = 0;
    for (let p = 0; p < 200; p++) {
      const out = budget.admit(Array.from({ length: 900 }, (_, i) => fake(2, `shared-${i}`)));
      kept += out.secrets.length;
      omitted += out.omitted;
    }
    expect(kept + omitted).toBe(200 * 900);
    expect(kept).toBeLessThanOrEqual(900 + SITE_FINDINGS_CAP);
    expect(budget.admit([fake(2, "shared-1")]).omittedSerious).toBe(false);
  });

  test("a copy of higher precedence is kept even when the copy allowance is spent", () => {
    const budget = createSiteFindingBudget(100);
    budget.admit([{ ...fake(2, "x"), type: "Generic Secret", value: "k" }]);
    for (let p = 0; p < 300; p++) budget.admit([{ ...fake(2, "x"), type: "Generic Secret", value: "k" }]);
    const out = budget.admit([{ ...fake(3, "x"), publicByDesign: true, value: "k" }]);
    expect(out.secrets).toHaveLength(1);
  });

  test("through the rule: omitted findings are in the result, and a late critical finding is listed", () => {
    const budget = createSiteFindingBudget();
    const pages: CollectedPageSignal[] = [];
    const base = buildCollectedPageSignal({ url: "https://a.test/", parsed: parsePage("<html><body>x</body></html>", "https://a.test/") });
    for (let p = 0; p < 40; p++) {
      const signal = { ...base, url: `https://a.test/${p}`, secrets: Array.from({ length: 900 }, (_, i) => fake(3, `${p}-${i}`)) };
      pages.push(applySiteFindingBudget(signal, budget));
    }
    pages.push(applySiteFindingBudget({ ...base, url: "https://a.test/late", secrets: [fake(0, "late")] }, budget));
    const result = leakedSecretsRule.run({
      site: { baseUrl: "https://a.test/", pages: [], scripts: [] },
      collectedSignals: { pages },
    } as unknown as RuleContext);
    const omitted = result.checks.find((c) => c.name === "leaked-secrets-omitted");
    expect(omitted).toBeDefined();
    expect(omitted!.details).toMatchObject({ siteCap: SITE_FINDINGS_CAP });
    expect(result.checks.find((c) => c.name === "leaked-secrets-critical")?.message).toContain("1 critical");
  });

  test("the record the page cache holds is not changed by the budget", () => {
    const budget = createSiteFindingBudget(10);
    const base = buildCollectedPageSignal({ url: "https://a.test/", parsed: parsePage("<html><body>x</body></html>", "https://a.test/") });
    const own = { ...base, secrets: Array.from({ length: 50 }, (_, i) => fake(2, String(i))) };
    const kept = applySiteFindingBudget(own, budget);
    expect(own.secrets).toHaveLength(50);
    expect(kept.secrets.length).toBeLessThan(50);
    expect(kept.secretsOmitted).toBe(50 - kept.secrets.length);
  });

  test("a later, more serious copy of a value is admitted after the copy allowance is spent (review)", () => {
    const budget = createSiteFindingBudget();
    let dropped = 0;
    for (let p = 0; p < 12; p++) {
      const out = budget.admit(Array.from({ length: 1000 }, (_, i) => fake(3, `v${i}`)));
      dropped += out.omitted;
    }
    expect(dropped).toBeGreaterThan(0); // copies past the allowance are counted, not lost in silence
    const late = budget.admit([{ ...fake(1, "v5"), value: "3-v5" }]);
    expect(late.secrets).toHaveLength(1);
    expect(late.omitted).toBe(0);
  });

  test("omitted findings that are all public or informational are not flagged serious", () => {
    const budget = createSiteFindingBudget(100);
    const out = budget.admit(Array.from({ length: 200 }, (_, i) => fake(3, String(i))));
    expect(out.omitted).toBeGreaterThan(0);
    expect(out.omittedSerious).toBe(false);
    expect(budget.admit([fake(1, "x")]).omittedSerious).toBe(false);
    const full = createSiteFindingBudget(10);
    full.admit(Array.from({ length: 10 }, (_, i) => fake(0, String(i))));
    expect(full.admit([fake(1, "y")]).omittedSerious).toBe(true);
  });
});

describe("one site cap, and the omitted check says at least (review)", () => {
  const U = "https://a.test/";
  const key = (n: number): string => `${["sk", "live"].join("_")}_${String(n).padStart(24, "k")}`;
  const run = (ctx: Partial<RuleContext>) =>
    leakedSecretsRule.run({ site: { baseUrl: U, pages: [], scripts: [] }, ...ctx } as unknown as RuleContext);

  test("external scripts draw on the collector's budget: a full site keeps none of them and counts them", () => {
    const budget = createSiteFindingBudget();
    budget.admit(Array.from({ length: SITE_FINDINGS_CAP }, (_, i) => fake(0, `c${i}`)));
    const scripts = [{ url: "https://a.test/app.js", content: Array.from({ length: 5 }, (_, i) => `var k${i}="${key(i)}";`).join("\n") }];
    const shared = run({ collectedSignals: { pages: [], secretsBudget: budget }, site: { baseUrl: U, pages: [], scripts } } as never);
    expect(shared.checks.find((c) => c.name === "leaked-secrets-critical")).toBeUndefined();
    const omitted = shared.checks.find((c) => c.name === "leaked-secrets-omitted");
    expect(omitted?.status).toBe("warn");
    expect(omitted?.message).toContain("At least 5");
    expect(omitted?.details).toMatchObject({ atLeast: true });
    // control: without a shared budget the same scripts are listed
    const alone = run({ collectedSignals: { pages: [] }, site: { baseUrl: U, pages: [], scripts } } as never);
    expect(alone.checks.find((c) => c.name === "leaked-secrets-critical")).toBeDefined();
  });

  test("the omitted check is info when only public or informational findings were left out, warn otherwise", () => {
    const base = buildCollectedPageSignal({ url: U, parsed: parsePage("<html><body>x</body></html>", U) });
    const info = run({ collectedSignals: { pages: [{ ...base, secretsOmitted: 3, secretsOmittedSerious: false }] } });
    expect(info.checks.find((c) => c.name === "leaked-secrets-omitted")?.status).toBe("info");
    const warn = run({ collectedSignals: { pages: [{ ...base, secretsOmitted: 3, secretsOmittedSerious: true }] } });
    expect(warn.checks.find((c) => c.name === "leaked-secrets-omitted")?.status).toBe("warn");
    const unknown = run({ collectedSignals: { pages: [{ ...base, secretsOmitted: 3 }] } });
    expect(unknown.checks.find((c) => c.name === "leaked-secrets-omitted")?.status).toBe("warn");
  });
});
