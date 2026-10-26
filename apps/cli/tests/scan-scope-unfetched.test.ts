// A saved report keeps the URLs its crawl left queued (`meta.unfetched`), so
// `squirrel report --input` re-renders a capped audit with the same discovered
// count the audit printed.

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadReport } from "@/controllers/report";

const slim = (meta: Record<string, unknown>) => ({
  meta: {
    version: "0.0.0",
    baseUrl: "http://example.test",
    timestamp: new Date(0).toISOString(),
    totalPages: 20,
    maxPages: 20,
    ...meta,
  },
  score: { overall: 90, categories: {} },
  summary: { passed: 1, warnings: 0, failed: 0 },
  issues: [],
});

async function reload(meta: Record<string, unknown>) {
  const path = join(
    tmpdir(),
    `squirrel-unfetched-${Math.random().toString(36).slice(2)}.json`
  );
  await Bun.write(path, JSON.stringify(slim(meta)));
  try {
    return loadReport(path);
  } finally {
    await Bun.file(path).delete();
  }
}

describe("unfetched survives a saved report", () => {
  test("a capped run reloads with its queued count", async () => {
    const loaded = await reload({ unfetched: 69 });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.data.scanScope?.capped).toBe(true);
    expect(loaded.data.scanScope?.unfetched).toBe(69);
  });

  test("a smart audit reloads with this run's pages, not every known page", async () => {
    // totalPages is the 300 known pages; this run crawled 150 of a 200 limit.
    // Counting from 300 would add the still-queued known pages twice and call
    // the run capped.
    const loaded = await reload({
      totalPages: 300,
      maxPages: 200,
      unfetched: 400,
      coverage: { auditedPages: 150, knownPages: 300, carriedFindings: 5 },
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.data.scanScope?.pagesCrawled).toBe(150);
    expect(loaded.data.scanScope?.capped).toBe(false);
    expect(loaded.data.scanScope?.unfetched).toBe(400);
  });

  test("a coverage count that is not a whole number falls back to totalPages", async () => {
    const loaded = await reload({ coverage: { auditedPages: "150" } });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.data.scanScope?.pagesCrawled).toBe(20);
    expect(loaded.data.scanScope?.capped).toBe(true);
  });

  test("absent, or not a whole count, reloads without one", async () => {
    for (const meta of [
      {},
      { unfetched: "69" },
      { unfetched: null },
      { unfetched: -1 },
      { unfetched: 2.7 },
    ]) {
      const loaded = await reload(meta);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.data.scanScope?.unfetched).toBeUndefined();
    }
  });
});
