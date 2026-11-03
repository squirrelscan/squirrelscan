// security/leaked-secrets: probes of a scan that overruns the time budget (#1556): what it found before the stop is kept.
// Values are built at runtime from parts; no secret-shaped literal is committed.

import { describe, expect, test } from "bun:test";
import { parsePage } from "@squirrelscan/parser";

import { buildCollectedPageSignal } from "../../src/collected-signals";
import { leakedSecretsRule } from "../../src/security/leaked-secrets";
import type { RuleContext } from "../../src/types";

const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const stripe = (n: number): string => {
  let x = n * 2654435761 + 12345;
  let out = "";
  for (let i = 0; i < 24; i++) {
    x = (Math.imul(x ^ (x >>> 15), 2246822519) + i) >>> 0;
    out += ALNUM[x % ALNUM.length];
  }
  return `${["sk", "live"].join("_")}_${out}`;
};

describe("a scan that overruns the time budget keeps what it found (#1556)", () => {
  const URL_ = "https://shop.acme.test/";

  test("a critical key before a huge tail of filler is kept, and the page is still listed as not fully scanned", () => {
    const filler = "var token = 'abcdefghijklmnopqrstuvwxyz0123456789';\n".repeat(60_000);
    const html = `<html><body><script>var k = "${stripe(7)}";</script><script>${filler}</script></body></html>`;
    const signal = buildCollectedPageSignal({ url: URL_, parsed: parsePage(html, URL_), budgetMs: 25 });
    expect(signal.timedOut?.ruleIds).toContain("security/leaked-secrets");
    expect(signal.secrets.some((s) => s.value === stripe(7))).toBe(true);
  });

  test("the rule still says the page was not fully scanned, and does not pass", () => {
    const filler = "var token = 'abcdefghijklmnopqrstuvwxyz0123456789';\n".repeat(60_000);
    const html = `<html><body><script>var k = "${stripe(8)}";</script><script>${filler}</script></body></html>`;
    const signal = buildCollectedPageSignal({ url: URL_, parsed: parsePage(html, URL_), budgetMs: 25 });
    const result = leakedSecretsRule.run({
      site: { baseUrl: URL_, pages: [], scripts: [] },
      collectedSignals: { pages: [signal] },
    } as unknown as RuleContext);
    expect(result.checks.find((c) => c.name === "leaked-secrets-unscanned")).toBeDefined();
    expect(result.checks.some((c) => c.status === "pass")).toBe(false);
    expect(result.checks.find((c) => c.name === "leaked-secrets-critical" || c.name === "leaked-secrets-high")).toBeDefined();
  });

  test("scripts are read first for the time budget, but the page's findings keep document-then-script order", () => {
    const html = `<html><body><p>${stripe(1)}</p><script>var k = "${stripe(2)}";</script><p>${stripe(3)}</p></body></html>`;
    const signal = buildCollectedPageSignal({ url: URL_, parsed: parsePage(html, URL_) });
    const values = signal.secrets.map((s) => s.value);
    expect(values).toEqual([stripe(1), stripe(2), stripe(3)].filter((v) => values.includes(v)));
    expect(values).toContain(stripe(2));
  });
});
