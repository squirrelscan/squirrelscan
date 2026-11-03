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
  SITE_FINDINGS_CAP,
  scanContent,
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
  const run = (n: number): string =>
    Array.from({ length: n }, () => ALNUM[next() % ALNUM.length]).join("");
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
    const input = [
      fake(3, 1),
      fake(3, 2),
      fake(2, 3),
      fake(2, 4),
      fake(1, 5),
      fake(0, 6),
      fake(2, 7),
      fake(0, 8),
      fake(3, 9),
    ];
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

describe("the sink dedupes by value with the rule's precedence before it counts (#1554 review)", () => {
  const withValue = (
    f: LeakedSecret,
    value: string,
    extra: Partial<LeakedSecret> = {},
  ): LeakedSecret => ({ ...f, value, ...extra });

  test("copies of one value fill nothing and are not counted as omitted", () => {
    const sink = createFindingSink(2);
    const x = fake(0, 1);
    for (let i = 0; i < 50; i++) sink.add({ ...x, offset: i });
    sink.add(fake(0, 2));
    expect(sink.result().map((f) => f.value)).toEqual([x.value, "v0-2"]);
    expect(sink.omitted()).toBe(0);
  });

  test("a value dropped by the cap is counted once however many times it is found", () => {
    const sink = createFindingSink(1);
    sink.add(fake(0, 1));
    for (let i = 0; i < 20; i++) sink.add({ ...fake(2, 2), offset: i });
    expect(sink.omitted()).toBe(1);
    sink.add(fake(2, 3));
    expect(sink.omitted()).toBe(2);
  });

  test("a value that was left out and is then kept at a higher tier is not counted as omitted", () => {
    const sink = createFindingSink(1);
    sink.add(fake(3, 1)); // kept
    const b = fake(3, 2);
    sink.add(b); // left out: counted
    expect(sink.omitted()).toBe(1);
    sink.add({ ...b, type: "Stripe Live Key", confidence: "high", location: "inline-script" }); // same value, now critical: it replaces the first
    expect(sink.result().map((f) => f.value)).toEqual([b.value]);
    expect(sink.omitted()).toBe(1); // only the first one is out now
  });

  test("scanContent stays a plain scanner: no cap, nested blobs included", () => {
    const v2 = values(5);
    const text = Array.from({ length: 1_600 }, () => `var k="${v2.stripe()}";`).join("");
    expect(scanContent(text, "inline-script", URL_).length).toBeGreaterThan(1_500);
    const blob = Buffer.from(text).toString("base64");
    expect(scanContent(`var d="${blob}";`, "inline-script", URL_).length).toBeGreaterThan(PAGE_FINDINGS_CAP);
  });

  test("the higher precedence wins a value, the last of equals, and it keeps the first place", () => {
    const sink = createFindingSink(10);
    const plain = fake(2, 1); // medium, not shipped
    sink.add(plain);
    sink.add(fake(1, 2));
    sink.add(withValue(fake(0, 3), plain.value)); // a shipped server secret of the same value wins
    sink.add(withValue(plain, plain.value, { offset: 99 })); // a plain one does not beat it back
    const [first, second] = sink.result();
    expect(first).toMatchObject({ value: plain.value, location: "inline-script", offset: 3 });
    expect(second!.value).toBe("v1-2");
    const pub = createFindingSink(10);
    pub.add(withValue(fake(0, 4), "same"));
    pub.add(withValue(fake(2, 5), "same", { publicByDesign: true }));
    pub.add(withValue(fake(0, 6), "same")); // public over shipped
    expect(pub.result()).toHaveLength(1);
    expect(pub.result()[0]!.publicByDesign).toBe(true);
    const later = createFindingSink(10);
    later.add(withValue(fake(2, 7), "v", { offset: 1 }));
    later.add(withValue(fake(2, 8), "v", { offset: 2 }));
    expect(later.result()[0]!.offset).toBe(2); // last of equals
  });

  test("a generic assignment is dropped when a public record has its quoted body, in either order and past the cap", () => {
    const generic = (body: string): LeakedSecret => ({
      ...fake(2, 1),
      type: "Generic API Key",
      value: `accessToken":"${body}"`,
    });
    const pub = (body: string): LeakedSecret => ({
      ...fake(3, 2),
      publicByDesign: true,
      value: body,
    });
    const a = createFindingSink(5);
    a.add(generic("PUBTOKEN"));
    a.add(pub("PUBTOKEN"));
    expect(a.result().map((f) => f.value)).toEqual(["PUBTOKEN"]);
    const b = createFindingSink(5);
    b.add(pub("PUBTOKEN"));
    b.add(generic("PUBTOKEN"));
    expect(b.result().map((f) => f.value)).toEqual(["PUBTOKEN"]);
    expect(b.omitted()).toBe(0);
    // the cap evicts the public record, and the generic one must still not be kept in its place
    const c = createFindingSink(1);
    c.add(pub("PUBTOKEN"));
    c.add(fake(0, 9)); // evicts the public record
    c.add(generic("PUBTOKEN"));
    expect(c.result().map((f) => f.value)).toEqual(["v0-9"]);
    // a generic with another body is kept
    const d = createFindingSink(5);
    d.add(pub("PUBTOKEN"));
    d.add(generic("OTHER"));
    expect(d.result()).toHaveLength(2);
  });
});

describe("one repeated server key cannot crowd out a distinct critical one (#1554 review)", () => {
  const v = values(77);
  for (const n of [1_000, 1_200, 5_000]) {
    test(`${n} inline scripts holding the same key, then one holding another`, () => {
      const x = v.stripe();
      const y = v.stripe();
      const scripts = Array.from({ length: n }, () => `<script>var k="${x}";</script>`).join("");
      const { secrets, omitted } = scanPageBounded(
        page(`<html><body>${scripts}<script>var k="${y}";</script></body></html>`).document!,
        URL_,
      );
      expect(secrets.map((s) => s.value).sort()).toEqual([x, y].sort());
      expect(omitted).toBe(0);
    });
  }

  test("distinct omitted counts, not records: 5,000 distinct keys in one inline script", () => {
    const body = Array.from({ length: 5_000 }, () => v.publishable()).join(";");
    const html = `<html><body><script>var all="${body}";</script></body></html>`;
    const distinct = new Set(scanContent(body, "inline-script", URL_).map((f) => f.value)).size;
    expect(distinct).toBeGreaterThan(1_500);
    const { secrets, omitted } = scanPageBounded(page(html).document!, URL_);
    expect(secrets).toHaveLength(PAGE_FINDINGS_CAP);
    expect(secrets.length + omitted).toBeGreaterThanOrEqual(distinct);
    expect(secrets.length + omitted).toBeLessThanOrEqual(distinct + 2); // found in both passes, counted once
  });
});

describe("a page keeps at most the per-page cap and says how many it left out", () => {
  const v = values(1554);

  test("the cap is the report's per-check item cap, so the caps agree", () => {
    expect(PAGE_FINDINGS_CAP).toBe(1000);
  });

  test("a page of distinct values: the cap is kept, the rest counted, the total is conserved", () => {
    const body = Array.from({ length: 3_000 }, () => `<p>${v.stripe()}</p>`).join("");
    const { secrets, omitted } = scanPageBounded(
      page(`<html><body>${body}</body></html>`).document!,
      URL_,
    );
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
    const { secrets, omitted } = scanContentBounded(
      `var data="${blob}";`,
      "inline-script",
      URL_,
      0,
      {},
    );
    expect(secrets.length).toBeLessThanOrEqual(PAGE_FINDINGS_CAP);
    const direct = scanContentBounded(text, "inline-script", URL_, 0, {});
    expect(secrets.length + omitted).toBeGreaterThanOrEqual(direct.secrets.length + direct.omitted);
    expect(omitted).toBeGreaterThan(0);
  });

  test("critical findings late in a page outrank medium ones before them", () => {
    const filler = Array.from({ length: 1_500 }, () => `<p>${v.publishable()}</p>`).join("");
    const critical = Array.from({ length: 12 }, () => `${v.stripe()}`);
    const script = `<script>${critical.map((c) => `var k="${c}";`).join("")}</script>`;
    const { secrets, omitted } = scanPageBounded(
      page(`<html><body>${filler}${script}</body></html>`).document!,
      URL_,
    );
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
  const signal = (html: string, url = URL_) =>
    buildCollectedPageSignal({ url, parsed: parsePage(html, url), rendered: false });
  const run = (pages: ReturnType<typeof signal>[], extra: Partial<RuleContext> = {}) =>
    leakedSecretsRule.run({
      site: { baseUrl: URL_, pages: [], scripts: [] },
      collectedSignals: { pages },
      ...extra,
    } as unknown as RuleContext);
  const named = (r: ReturnType<typeof run>, name: string) => r.checks.find((c) => c.name === name);

  test("a page record with far more findings than an argument list can hold does not throw, and other pages still report", () => {
    const hostile = signal("<html><body>x</body></html>", "https://shop.acme.test/dump");
    const one = fake(1, 1);
    hostile.secrets = Array.from({ length: 1_000_000 }, () => one); // what a spread of this size throws on
    const normal = signal(
      `<html><body><p>${v.stripe()}</p></body></html>`,
      "https://shop.acme.test/real",
    );
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
      site: {
        baseUrl: URL_,
        pages: [{ url: URL_, statusCode: 200, parsed }],
        scripts: [{ url: "https://shop.acme.test/a.js", content: body }],
      },
    } as unknown as RuleContext);
    expect(named(legacy, "leaked-secrets-omitted")).toBeDefined();
    expect(named(legacy, "leaked-secrets-omitted")!.items!.map((i) => i.id)).toContain(URL_);
    expect(named(legacy, "leaked-secrets-omitted")!.items!.map((i) => i.id)).toContain(
      "https://shop.acme.test/a.js",
    );
  });

  test("a check lists at most the report's cap, the rest is details.additional, and the message counts them all", () => {
    const pages = Array.from({ length: 3 }, (_, i) =>
      signal(
        `<html><body>${Array.from({ length: 800 }, () => `<p>${v.stripe()}</p>`).join("")}</body></html>`,
        `https://shop.acme.test/p${i}`,
      ),
    );
    const high = named(run(pages), "leaked-secrets-high")!;
    expect(high.items).toHaveLength(1000);
    expect(high.details).toEqual({ additional: 2400 - 1000 });
    expect(high.message).toContain("2400 high-confidence");
  });

  test("a page cut by the cap adds a warn check naming the page and the count, in the JSON too", () => {
    const hostile = signal(
      `<html><body>${Array.from({ length: 3_000 }, () => `<p>${v.stripe()}</p>`).join("")}</body></html>`,
      "https://shop.acme.test/dump",
    );
    const omittedCount = hostile.secretsOmitted!;
    expect(omittedCount).toBeGreaterThan(0);
    const check = named(run([hostile]), "leaked-secrets-omitted")!;
    expect(check.status).toBe("warn");
    expect(check.message).toContain(`${omittedCount} more`);
    expect(check.details).toEqual({ omitted: omittedCount, perPageCap: PAGE_FINDINGS_CAP, siteCap: SITE_FINDINGS_CAP, atLeast: true });
    expect(check.items![0]).toEqual({
      id: "https://shop.acme.test/dump",
      label: `${omittedCount} finding(s) not kept`,
    });
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

describe("the rule's lists, from forged page records (#1554 review)", () => {
  const signal = (url: string) =>
    buildCollectedPageSignal({
      url,
      parsed: parsePage("<html><body>x</body></html>", url),
      rendered: false,
    });
  const run = (pages: ReturnType<typeof signal>[]) =>
    leakedSecretsRule.run({
      site: { baseUrl: URL_, pages: [], scripts: [] },
      collectedSignals: { pages },
    } as unknown as RuleContext);

  test("the critical check lists at most the cap and records the rest in details.additional", () => {
    const rec = signal("https://shop.acme.test/dump");
    rec.secrets = Array.from({ length: 1_500 }, (_, i) => fake(0, i));
    const check = run([rec]).checks.find((c) => c.name === "leaked-secrets-critical")!;
    expect(check.items).toHaveLength(PAGE_FINDINGS_CAP);
    expect(check.details).toEqual({ severity: "critical", additional: 500 });
    expect(check.message).toContain("1500 critical");
  });

  test("the medium, public and informational checks do the same", () => {
    const rec = signal("https://shop.acme.test/dump");
    rec.secrets = [
      ...Array.from({ length: 1_200 }, (_, i) => fake(2, i)),
      ...Array.from({ length: 1_100 }, (_, i) => ({
        ...fake(3, i),
        publicByDesign: true,
        value: `pub-${i}`,
      })),
      ...Array.from({ length: 1_050 }, (_, i) => fake(3, 10_000 + i)),
    ];
    const checks = run([rec]).checks;
    expect(checks.find((c) => c.name === "leaked-secrets-medium")!.details).toEqual({
      additional: 200,
    });
    expect(checks.find((c) => c.name === "leaked-secrets-public")!.details).toEqual({
      additional: 100,
    });
    expect(checks.find((c) => c.name === "leaked-secrets-info")!.details).toEqual({
      additional: 50,
    });
  });

  test("the omitted check lists at most 20 sources and counts all of them", () => {
    const pages = Array.from({ length: 30 }, (_, i) => {
      const rec = signal(`https://shop.acme.test/p${i}`);
      rec.secretsOmitted = 5;
      return rec;
    });
    const check = run(pages).checks.find((c) => c.name === "leaked-secrets-omitted")!;
    expect(check.items).toHaveLength(20);
    expect(check.details).toEqual({ omitted: 150, perPageCap: PAGE_FINDINGS_CAP, siteCap: SITE_FINDINGS_CAP, atLeast: true });
    expect(check.message).toContain("150 more");
    expect(check.message).toContain("30 source(s)");
  });
});
