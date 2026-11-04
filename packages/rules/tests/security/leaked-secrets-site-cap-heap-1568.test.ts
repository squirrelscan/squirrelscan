// security/leaked-secrets: the heap a crawl keeps for findings stays under the site cap's bound (#1568).
// Values are built at runtime from parts; no secret-shaped literal is committed. Measured with a forced GC, no timing.

import { expect, test } from "bun:test";
import { parsePage } from "@squirrelscan/parser";

import { applySiteFindingBudget, buildCollectedPageSignal, type CollectedPageSignal } from "../../src/collected-signals";
import { createSiteFindingBudget, PAGE_FINDINGS_CAP, SITE_FINDINGS_CAP } from "../../src/security/leaked-secrets";

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

const PAGES = 150;
// Measured on Bun 1.3.14 over 150 pages of 1,100 distinct keys each (per-page cap 1,000): 80.9 MB kept with no site cap,
// 12.7 to 17 MB with it (about 11 to 15 MB for the cap's 10,000 findings, 1.6 MB of per-page overhead). Another 10,000 findings are
// allowed as copies of a kept value, so the worst case is about twice the distinct figure. 28 MB is the distinct case (12.7 to 17 MB over runs) with
// margin: it fails with no cap (81 MB) and does not move with the page count.
const BOUND_MB = 28;

// A forced collection is not always complete on the first call: collect until the figure stops falling.
const heapMb = async (): Promise<number> => {
  let last = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 8; i++) {
    Bun.gc(true);
    await Bun.sleep(5);
    const now = process.memoryUsage().heapUsed;
    if (now >= last * 0.995) break;
    last = now;
  }
  return Math.min(last, process.memoryUsage().heapUsed) / 1_048_576;
};

test(`${PAGES} pages at the per-page cap keep under ${BOUND_MB} MB of findings, and the rest are counted`, async () => {
  const budget = createSiteFindingBudget();
  const url = (p: number) => `https://shop.example/p${p}`;
  const build = (p: number): CollectedPageSignal => {
    const values = Array.from({ length: PAGE_FINDINGS_CAP + 100 }, (_, i) => `<p>${stripe(p * 10_000 + i)}</p>`).join("");
    const html = `<!doctype html><html><body>${values}</body></html>`;
    const signal = buildCollectedPageSignal({ url: url(p), parsed: parsePage(html, url(p)), htmlBytes: html.length, budgetMs: 60_000 });
    return applySiteFindingBudget(signal, budget);
  };
  for (let p = 0; p < 3; p++) build(900 + p); // warm up, then drop
  const base = await heapMb();
  const kept: CollectedPageSignal[] = [];
  let findings = 0;
  for (let p = 0; p < PAGES; p++) {
    const signal = build(p);
    kept.push(signal);
    findings += signal.secrets.length;
  }
  const grown = (await heapMb()) - base;
  expect(kept).toHaveLength(PAGES);
  expect(findings).toBeLessThanOrEqual(SITE_FINDINGS_CAP + SITE_FINDINGS_CAP); // distinct room plus the copy allowance
  expect(budget.kept()).toBeLessThanOrEqual(SITE_FINDINGS_CAP);
  expect(kept.reduce((n, s) => n + (s.secretsOmitted ?? 0), 0), "a cut site is counted, not silent").toBeGreaterThan(0);
  expect(grown, `kept ${grown.toFixed(1)} MB`).toBeLessThan(BOUND_MB);
}, 180_000);
