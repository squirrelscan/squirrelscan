// security/leaked-secrets: findings per page are capped, most serious first, and what was left out is counted (#1554).
// Every value is built at runtime from parts and a seeded generator: no secret-shaped literal is committed.

import { describe, expect, test } from "bun:test";
import { parsePage } from "@squirrelscan/parser";

import { buildCollectedPageSignal } from "../../src/collected-signals";
import {
  createFindingSink,
  leakedSecretsRule,
  type LeakedSecret,
  PAGE_FINDINGS_CAP,
  scanContentBounded,
  scanPageBounded,
  scanPageForSecrets,
} from "../../src/security/leaked-secrets";
import type { RuleContext } from "../../src/types";

const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** A deterministic stream of distinct secret-shaped values, built from parts. */
function values(seed: number) {
  let state = seed >>> 0;
  const next = (): number => {
    // mulberry32: a plain LCG has short low-bit cycles that make values repeat
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  const run = (n: number): string => Array.from({ length: n }, () => ALNUM[next() % ALNUM.length]).join("");
  return {
    /** A live payment key shape: a server-only secret (critical in a script, high in text). */
    stripe: (): string => `${["sk", "live"].join("_")}_${run(24)}`,
    /** A publishable key shape: public by design, the lowest tier. */
    publishable: (): string => `${["pk", "live"].join("_")}_${run(24)}`,
  };
}

const URL_ = "https://shop.acme.test/";
const page = (html: string) => parsePage(html, URL_);

const fake = (tier: 0 | 1 | 2 | 3, n: number): LeakedSecret => ({
  type: tier === 0 ? "Stripe Live Key" : "Some Pattern",
  value: `v${tier}-${n}`,
  confidence: tier === 3 ? "info" : tier === 2 ? "medium" : "high",
  publicByDesign: false,
  location: tier === 0 ? "inline-script" : "html",
  length: 8,
  offset: n,
});

describe("the sink keeps a plain list below the cap and the most serious findings above it", () => {
  test("below or at the cap: every finding, in scan order, nothing omitted", () => {
    const sink = createFindingSink(5);
    const input = [fake(2, 1), fake(0, 2), fake(3, 3), fake(1, 4), fake(2, 5)];
    for (const f of input) sink.add(f);
    expect(sink.result()).toEqual(input);
    expect(sink.omitted()).toBe(0);
  });

  test("over the cap: critical before high before medium before informational, each tier in scan order", () => {
    const sink = createFindingSink(4);
    const input = [fake(3, 1), fake(3, 2), fake(2, 3), fake(2, 4), fake(1, 5), fake(0, 6), fake(2, 7), fake(0, 8), fake(3, 9)];
    for (const f of input) sink.add(f);
    // kept: both criticals (6, 8), the high (5), and the earliest medium (3); the rest are counted
    expect(sink.result().map((f) => f.offset)).toEqual([3, 5, 6, 8]);
    expect(sink.omitted()).toBe(input.length - 4);
  });

  test("a later, more serious finding replaces the most recent one of the least serious tier", () => {
    const sink = createFindingSink(3);
    for (const f of [fake(2, 1), fake(2, 2), fake(2, 3)]) sink.add(f);
    sink.add(fake(0, 4));
    expect(sink.result().map((f) => f.offset)).toEqual([1, 2, 4]);
    sink.add(fake(2, 5)); // not better than the worst tier: counted, not kept
    expect(sink.result().map((f) => f.offset)).toEqual([1, 2, 4]);
    expect(sink.omitted()).toBe(2);
  });

  test("a critical finding outranks a high one that came first", () => {
    const sink = createFindingSink(2);
    for (const f of [fake(1, 1), fake(1, 2), fake(0, 3)]) sink.add(f);
    expect(sink.result().map((f) => f.offset)).toEqual([1, 3]);
    expect(sink.omitted()).toBe(1);
  });

  test("omit() adds a nested scan's count", () => {
    const sink = createFindingSink(2);
    sink.omit(7);
    expect(sink.omitted()).toBe(7);
  });
});

describe("a page keeps at most the per-page cap and says how many it left out", () => {
  const v = values(1554);

  test("the cap is the report's per-check item cap, so the caps agree", () => {
    expect(PAGE_FINDINGS_CAP).toBe(1000);
  });

  test("a page of distinct values: the cap is kept, the rest counted, the total is conserved", () => {
    const body = Array.from({ length: 3_000 }, () => `<p>${v.stripe()}</p>`).join("");
    const { secrets, omitted } = scanPageBounded(page(`<html><body>${body}</body></html>`).document!, URL_);
    expect(secrets).toHaveLength(PAGE_FINDINGS_CAP);
    expect(omitted).toBeGreaterThan(0);
    // the same page with a cap that never applies finds exactly kept + omitted
    const all = scanContentBounded(body, "html", URL_, 0, {});
    expect(all.secrets.length + all.omitted).toBe(secrets.length + omitted);
  });

  test("a decoded base64 blob is capped too, and what it left out is counted on the page", () => {
    const text = Array.from({ length: 1_600 }, () => `var k="${v.stripe()}";`).join("");
    const blob = Buffer.from(text).toString("base64");
    expect(blob.length).toBeLessThan(200_000);
    const { secrets, omitted } = scanContentBounded(`var data="${blob}";`, "inline-script", URL_, 0, {});
    expect(secrets.length).toBeLessThanOrEqual(PAGE_FINDINGS_CAP);
    const direct = scanContentBounded(text, "inline-script", URL_, 0, {});
    expect(secrets.length + omitted).toBeGreaterThanOrEqual(direct.secrets.length + direct.omitted);
    expect(omitted).toBeGreaterThan(0);
  });

  test("critical findings late in a page outrank medium ones before them", () => {
    const filler = Array.from({ length: 1_500 }, () => `<p>${v.publishable()}</p>`).join("");
    const critical = Array.from({ length: 12 }, () => `${v.stripe()}`);
    const script = `<script>${critical.map((c) => `var k="${c}";`).join("")}</script>`;
    const { secrets, omitted } = scanPageBounded(page(`<html><body>${filler}${script}</body></html>`).document!, URL_);
    expect(secrets.length).toBeLessThanOrEqual(PAGE_FINDINGS_CAP);
    expect(omitted).toBeGreaterThan(0);
    const kept = new Set(secrets.map((s) => s.value));
    for (const c of critical) expect(kept.has(c)).toBe(true);
  });

  test("a page under the cap is unchanged: scanPageForSecrets and scanPageBounded agree, nothing omitted", () => {
    const body = Array.from({ length: 40 }, () => `<p>${v.stripe()}</p>`).join("");
    const doc = page(`<html><body>${body}</body></html>`).document!;
    const bounded = scanPageBounded(doc, URL_);
    expect(bounded.omitted).toBe(0);
    expect(bounded.secrets).toEqual(scanPageForSecrets(doc, URL_));
  });
});

describe("the rule: no spread, one cap with the report, and the omitted count is in the result", () => {
  const v = values(9);
  const signal = (html: string, url = URL_) => buildCollectedPageSignal({ url, parsed: parsePage(html, url), rendered: false });
  const run = (pages: ReturnType<typeof signal>[], extra: Partial<RuleContext> = {}) =>
    leakedSecretsRule.run({ site: { baseUrl: URL_, pages: [], scripts: [] }, collectedSignals: { pages }, ...extra } as unknown as RuleContext);
  const named = (r: ReturnType<typeof run>, name: string) => r.checks.find((c) => c.name === name);

  test("a page record with far more findings than an argument list can hold does not throw, and other pages still report", () => {
    const hostile = signal("<html><body>x</body></html>", "https://shop.acme.test/dump");
    const one = fake(1, 1);
    hostile.secrets = Array.from({ length: 1_000_000 }, () => one); // what a spread of this size throws on
    const normal = signal(`<html><body><p>${v.stripe()}</p></body></html>`, "https://shop.acme.test/real");
    const result = run([hostile, normal]);
    const high = named(result, "leaked-secrets-high");
    expect(high).toBeDefined();
    expect(high!.message).toContain("high-confidence");
    expect(JSON.stringify(result).length).toBeLessThan(2 * 1024 * 1024);
  });

  test("the same holds for the legacy site.pages path and for external scripts", () => {
    const body = Array.from({ length: 2_500 }, () => `<p>${v.stripe()}</p>`).join("");
    const parsed = page(`<html><body>${body}</body></html>`);
    const legacy = leakedSecretsRule.run({
      site: { baseUrl: URL_, pages: [{ url: URL_, statusCode: 200, parsed }], scripts: [{ url: "https://shop.acme.test/a.js", content: body }] },
    } as unknown as RuleContext);
    expect(named(legacy, "leaked-secrets-omitted")).toBeDefined();
    expect(named(legacy, "leaked-secrets-omitted")!.items!.map((i) => i.id)).toContain(URL_);
    expect(named(legacy, "leaked-secrets-omitted")!.items!.map((i) => i.id)).toContain("https://shop.acme.test/a.js");
  });

  test("a check lists at most the report's cap, the rest is details.additional, and the message counts them all", () => {
    const pages = Array.from({ length: 3 }, (_, i) => signal(`<html><body>${Array.from({ length: 800 }, () => `<p>${v.stripe()}</p>`).join("")}</body></html>`, `https://shop.acme.test/p${i}`));
    const high = named(run(pages), "leaked-secrets-high")!;
    expect(high.items).toHaveLength(1000);
    expect(high.details).toEqual({ additional: 2400 - 1000 });
    expect(high.message).toContain("2400 high-confidence");
  });

  test("a page cut by the cap adds a warn check naming the page and the count, in the JSON too", () => {
    const hostile = signal(`<html><body>${Array.from({ length: 3_000 }, () => `<p>${v.stripe()}</p>`).join("")}</body></html>`, "https://shop.acme.test/dump");
    const omittedCount = hostile.secretsOmitted!;
    expect(omittedCount).toBeGreaterThan(0);
    const check = named(run([hostile]), "leaked-secrets-omitted")!;
    expect(check.status).toBe("warn");
    expect(check.message).toContain(`${omittedCount} more`);
    expect(check.details).toEqual({ omitted: omittedCount, perPageCap: PAGE_FINDINGS_CAP });
    expect(check.items![0]).toEqual({ id: "https://shop.acme.test/dump", label: `${omittedCount} finding(s) not kept` });
    expect(JSON.parse(JSON.stringify(check)).details.omitted).toBe(omittedCount);
  });

  test("a page under every cap: no omitted check, no details on the tiers, no extra field on the record", () => {
    const small = signal(`<html><body><p>${v.stripe()}</p></body></html>`);
    expect("secretsOmitted" in small).toBe(false);
    const result = run([small]);
    expect(named(result, "leaked-secrets-omitted")).toBeUndefined();
    expect(named(result, "leaked-secrets-high")!.details).toBeUndefined();
  });
});
