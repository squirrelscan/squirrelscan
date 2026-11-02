// security/leaked-secrets: a hostile page cannot switch the rule off or make it expensive (#1554). One page of distinct
// secret-shaped values at 5 MB and at 10 MiB, through the streaming path (collector, then the site rule). Values are built
// at runtime from parts; nothing secret-shaped is committed. Timings are printed, bounds are generous. The collector's own
// 2 s rule budget is lifted here: a loaded machine would abandon the scan and hand back an empty record, and what is asserted
// is the cap and the retention, not the speed.

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { parsePage } from "@squirrelscan/parser";

import { buildCollectedPageSignal } from "../../src/collected-signals";
import { leakedSecretsRule, PAGE_FINDINGS_CAP } from "../../src/security/leaked-secrets";
import type { RuleContext } from "../../src/types";

setDefaultTimeout(100_000);

const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const URL_ = "https://shop.acme.test/";

function stream(seed: number) {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  return (): string => `${["sk", "live"].join("_")}_${Array.from({ length: 24 }, () => ALNUM[next() % ALNUM.length]).join("")}`;
}

/** Distinct values, joined by `sep`, until the text is `bytes` long. */
function body(bytes: number, sep: string, seed = 1): string {
  const key = stream(seed);
  const parts: string[] = [];
  let size = 0;
  while (size < bytes) {
    const k = key();
    parts.push(k);
    size += k.length + sep.length;
  }
  return parts.join(sep);
}

/** Heap in use after collections that have settled: the scan's garbage is gone, only what is still referenced is counted. */
const heapMb = (): number => {
  let last = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 6; i++) {
    Bun.gc(true);
    const now = process.memoryUsage().heapUsed;
    if (Math.abs(last - now) < 256 * 1024) break;
    last = now;
  }
  return process.memoryUsage().heapUsed / 1024 / 1024;
};

const shapes: Array<[string, (bytes: number) => string]> = [
  ["in text", (n) => `<html><body><p>${body(n, "</p><p>")}</p></body></html>`],
  ["in one inline script", (n) => `<html><body><script>var k=["${body(n, '","')}"];</script></body></html>`],
];

for (const [label, bytes] of [
  ["5 MB", 5_000_000],
  ["10 MiB", 10 * 1024 * 1024],
] as const) {
  describe(`${label} of distinct key shapes`, () => {
    for (const [shape, build] of shapes) {
      test(shape, () => {
        const html = build(bytes);
        const parsed = parsePage(html, URL_);
        const started = performance.now();
        let signal = buildCollectedPageSignal({ url: URL_, parsed, rendered: false, budgetMs: 600_000 });
        const scanMs = performance.now() - started;
        expect(signal.secrets.length).toBeLessThanOrEqual(PAGE_FINDINGS_CAP);
        expect(signal.secretsOmitted ?? 0).toBeGreaterThan(0);
        const ruleStart = performance.now();
        const result = leakedSecretsRule.run({
          site: { baseUrl: URL_, pages: [], scripts: [] },
          collectedSignals: { pages: [signal] },
        } as unknown as RuleContext);
        const ruleMs = performance.now() - ruleStart;
        const json = JSON.stringify(result).length;
        expect(json).toBeLessThan(2 * 1024 * 1024);
        expect(result.checks.some((c) => c.name === "leaked-secrets-omitted")).toBe(true);
        // what the page keeps, after GC, with the page itself dropped
        const held = heapMb();
        (signal as { secrets: unknown }).secrets = [];
        signal = undefined as never;
        const dropped = heapMb();
        console.log(`TIMING ${label} ${shape}: collect ${Math.round(scanMs)} ms, rule ${Math.round(ruleMs)} ms, result ${(json / 1024).toFixed(0)} KB, retained ${(held - dropped).toFixed(1)} MB`);
        expect(held - dropped).toBeLessThan(20);
        expect(scanMs).toBeLessThan(60_000);
      });
    }
  });
}
