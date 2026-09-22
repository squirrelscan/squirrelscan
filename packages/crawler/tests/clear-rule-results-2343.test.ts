// Partial rule_results from a killed rules phase (squirrelscan/repo#2343).
//
// The rules phase spills its checks to `rule_results` as it produces them
// instead of writing them all once at the end, so a run that dies part way
// through now leaves rows behind where it used to leave none. Running rules
// again over the same crawl_id would then append a SECOND copy of every check,
// and the report reads those rows, so the audit would double-count every
// finding without anything looking wrong.
//
// `clearRuleResults` is what makes re-running safe, and these pin the two
// things it has to get right: it removes this crawl's rows, and it removes
// ONLY this crawl's rows (a project.db holds every audit of the site, so a
// DELETE without the crawl_id predicate would wipe the history).

import type { CheckResult } from "@squirrelscan/core-contracts";

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SQLiteStorage } from "../src/storage/sqlite";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

const tmpFiles: string[] = [];
afterEach(() => {
  for (const p of tmpFiles) rmSync(p, { force: true });
  tmpFiles.length = 0;
});

function tmpDbPath(): string {
  const p = join(tmpdir(), `squirrel-2343-${randomUUID()}.db`);
  tmpFiles.push(p);
  return p;
}

function check(name: string): CheckResult {
  return { name, status: "fail", message: `${name} failed` };
}

/** One batch of page results, shaped the way the rules-phase sink flushes them. */
function batch(pageUrl: string): Map<string, { ruleId: string; checks: CheckResult[] }[]> {
  return new Map([[pageUrl, [{ ruleId: "core/meta-title", checks: [check("meta-title")] }]]]);
}

describe("clearRuleResults (#2343)", () => {
  test("a re-run over a half-written crawl does not double its checks", async () => {
    const store = new SQLiteStorage(tmpDbPath());
    await run(store.init());
    const crawlId = "crawl-killed";

    // A rules phase that died after flushing two batches.
    await run(store.saveRuleResultsBatch(crawlId, batch("https://example.com/a")));
    await run(store.saveRuleResultsBatch(crawlId, batch("https://example.com/b")));
    const partial = await run(store.getRuleResultsGrouped(crawlId));
    expect(partial.byPage.size).toBe(2);

    // The re-run clears first, then writes the same two pages again.
    await run(store.clearRuleResults(crawlId));
    await run(store.saveRuleResultsBatch(crawlId, batch("https://example.com/a")));
    await run(store.saveRuleResultsBatch(crawlId, batch("https://example.com/b")));

    const after = await run(store.getRuleResultsGrouped(crawlId));
    expect(after.byPage.size).toBe(2);
    // ONE check per page, not two. Without the clear this reads 2 and the
    // report counts every finding twice.
    expect(after.byPage.get("https://example.com/a")).toHaveLength(1);
    expect(after.byRuleId.get("core/meta-title")).toHaveLength(2);

    await run(store.close());
  });

  test("it clears only the named crawl, leaving the project's other audits alone", async () => {
    const store = new SQLiteStorage(tmpDbPath());
    await run(store.init());

    await run(store.saveRuleResultsBatch("crawl-old", batch("https://example.com/a")));
    await run(store.saveRuleResultsBatch("crawl-new", batch("https://example.com/a")));

    await run(store.clearRuleResults("crawl-new"));

    // A project.db holds every audit of the site; the previous one is history a
    // diff and the findings store both read.
    expect((await run(store.getRuleResultsGrouped("crawl-new"))).byPage.size).toBe(0);
    expect((await run(store.getRuleResultsGrouped("crawl-old"))).byPage.size).toBe(1);

    await run(store.close());
  });

  test("clearing a crawl that has no rows is a no-op, not an error", async () => {
    const store = new SQLiteStorage(tmpDbPath());
    await run(store.init());
    // The normal path: every run calls this, and on every run it finds nothing.
    await run(store.clearRuleResults("never-audited"));
    expect((await run(store.getRuleResultsGrouped("never-audited"))).byPage.size).toBe(0);
    await run(store.close());
  });
});
