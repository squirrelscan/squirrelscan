// security/leaked-secrets: probes that try to defeat the per-page sink (#1554): its own bookkeeping stays bounded whatever a crafted page repeats.
// Values are built at runtime from parts; no secret-shaped literal is committed.

import { describe, expect, test } from "bun:test";

import { createFindingSink, type LeakedSecret, PAGE_FINDINGS_CAP } from "../../src/security/leaked-secrets";

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
const publicKey = (name: string): LeakedSecret => ({ ...fake(3, name), type: "Stripe Publishable Key", publicByDesign: true });

describe("the page sink's own bookkeeping is bounded (probes of the per-page cap)", () => {
  test("one value found 50,000 times leaves no residue", () => {
    const sink = createFindingSink();
    for (let i = 0; i < 50_000; i++) sink.add(fake(1, "same"));
    expect(sink.result()).toHaveLength(1);
    expect(sink.omitted()).toBe(0);
    expect(sink.retained()).toBeLessThan(200);
  });

  test("a value that flips tier on every copy leaves no residue", () => {
    const sink = createFindingSink();
    for (let i = 0; i < 50_000; i++) sink.add({ ...fake(i % 2 === 0 ? 1 : 2, "flip"), value: "flip", type: "Generic X" });
    expect(sink.result()).toHaveLength(1);
    expect(sink.retained()).toBeLessThan(200);
  });

  test("50,000 distinct findings: the cap is kept, the rest counted, the memory bounded", () => {
    const sink = createFindingSink();
    const n = 50_000;
    for (let i = 0; i < n; i++) sink.add(fake(2, String(i)));
    expect(sink.result()).toHaveLength(PAGE_FINDINGS_CAP);
    expect(sink.omitted()).toBe(n - PAGE_FINDINGS_CAP);
    expect(sink.retained()).toBeLessThan(PAGE_FINDINGS_CAP * 20);
  });

  test("50,000 distinct public keys cannot grow the sink without limit", () => {
    const sink = createFindingSink();
    for (let i = 0; i < 50_000; i++) sink.add(publicKey(String(i)));
    expect(sink.result()).toHaveLength(PAGE_FINDINGS_CAP);
    expect(sink.omitted()).toBe(50_000 - PAGE_FINDINGS_CAP);
    expect(sink.retained()).toBeLessThan(PAGE_FINDINGS_CAP * 20);
  });

  test("generic findings that churn in and out of the cap leave no residue", () => {
    const sink = createFindingSink(100);
    for (let i = 0; i < 20_000; i++) sink.add({ ...fake(2, String(i)), type: "Generic Secret", value: `secret":"v${i}"` });
    for (let i = 0; i < 20_000; i++) sink.add({ ...fake(0, String(i)), value: `crit-${i}` });
    expect(sink.result().filter((s) => s.value.startsWith("crit-"))).toHaveLength(100);
    expect(sink.retained()).toBeLessThan(100 * 12);
  });

  test("a critical finding after the cap is full of lower ones is kept, and the evicted one is counted", () => {
    const sink = createFindingSink(50);
    for (let i = 0; i < 5_000; i++) sink.add(fake(3, String(i)));
    sink.add(fake(0, "late"));
    expect(sink.result().some((s) => s.value === "0-late")).toBe(true);
    expect(sink.omitted()).toBe(5_000 - 50 + 1);
  });
});

