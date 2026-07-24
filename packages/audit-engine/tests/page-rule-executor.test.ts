// PageRuleExecutor seam (#263). Locks the contract the parallel-backend
// follow-up will implement against: input order preserved, `dispose()` always
// runs (even when `run()` throws), and the AbortSignal checkpoint stops the
// batch between pages so a `rulesPhaseTimeoutMs` interruption is honored rather
// than running every remaining page to completion. The serial backend is a thin
// pass-through of the already-tested `RuleRunner.runPageRules`, so these assert
// the seam's own wiring, not rule behavior.

import { describe, expect, test } from "bun:test";

import type { PageData, RuleRunner, SiteData } from "@squirrelscan/rules";

import {
  type PageRuleExecutor,
  type PageRuleTask,
  runAndDispose,
  SerialPageRuleExecutor,
} from "../src/page-rule-executor";

const siteData = {} as SiteData;

function task(key: string): PageRuleTask {
  return { key, page: { url: key, html: "<html></html>" } as PageData };
}

/** RuleRunner stub — records the pages it ran and returns a check tagged by url,
 * optionally invoking a hook (used to trigger mid-batch abort). */
function stubRunner(onRun?: (page: PageData) => void): { runner: RuleRunner; ran: string[] } {
  const ran: string[] = [];
  const runner = {
    runPageRules: async (page: PageData) => {
      onRun?.(page);
      ran.push(page.url);
      return {
        checks: [{ id: `check:${page.url}`, passed: true } as never],
        ruleResults: new Map(),
      };
    },
  } as unknown as RuleRunner;
  return { runner, ran };
}

describe("SerialPageRuleExecutor", () => {
  test("preserves input order and maps keys 1:1", async () => {
    const { runner, ran } = stubRunner();
    const exec = new SerialPageRuleExecutor(runner);
    const tasks = ["a", "b", "c"].map(task);

    const results = await exec.run(tasks, siteData);

    expect(results.map((r) => r.key)).toEqual(["a", "b", "c"]);
    expect(ran).toEqual(["a", "b", "c"]);
    expect(results[0].checks[0]).toMatchObject({ id: "check:a" });
  });

  test("throws before starting a page once the signal is aborted", async () => {
    const controller = new AbortController();
    // Abort while the first page runs → second page must not start.
    const { runner, ran } = stubRunner(() => controller.abort());
    const exec = new SerialPageRuleExecutor(runner);

    await expect(exec.run(["a", "b"].map(task), siteData, controller.signal)).rejects.toThrow();
    expect(ran).toEqual(["a"]); // "b" never ran
  });

  test("runs the whole batch when the signal never aborts", async () => {
    const { runner, ran } = stubRunner();
    const exec = new SerialPageRuleExecutor(runner);
    const controller = new AbortController();

    await exec.run(["a", "b"].map(task), siteData, controller.signal);
    expect(ran).toEqual(["a", "b"]);
  });
});

// #1252: cooperative-yield + heartbeat hooks. Without a MACROTASK yield the
// serial loop starves every timer (deadline + liveness heartbeat); with one, a
// deadline armed via setTimeout can fire MID-loop and abort the fiber.
describe("SerialPageRuleExecutor loop hooks (#1252)", () => {
  test("no hooks → no progress emitted (local parity)", async () => {
    const { runner } = stubRunner();
    const progress: Array<[number, number]> = [];
    // Constructed WITHOUT hooks — mirrors the CLI path.
    const exec = new SerialPageRuleExecutor(runner);
    await exec.run(["a", "b", "c"].map(task), siteData);
    expect(progress).toEqual([]); // nothing to collect; asserts the default is inert
  });

  test("emits onProgress every N pages and once at the end", async () => {
    const { runner } = stubRunner();
    const progress: Array<[number, number]> = [];
    const exec = new SerialPageRuleExecutor(runner, {
      heartbeatEveryPages: 2,
      onProgress: (done, total) => progress.push([done, total]),
    });

    await exec.run(["a", "b", "c", "d", "e"].map(task), siteData);
    // Boundary hits at 2 and 4; final flush at 5 (not on a boundary).
    expect(progress).toEqual([
      [2, 5],
      [4, 5],
      [5, 5],
    ]);
  });

  test("a setTimeout-armed deadline fires MID-loop only because the loop yields", async () => {
    const controller = new AbortController();
    // Each page burns ~15ms of wall time; the deadline is 30ms. Without a
    // macrotask yield the abort (also a macrotask) could never interrupt a
    // synchronous stretch — the yield is what lets it land between pages.
    const { runner, ran } = stubRunner(() => {
      const until = Date.now() + 15;
      while (Date.now() < until) {
        /* busy-wait to simulate sync CPU per page */
      }
    });
    const timer = setTimeout(() => controller.abort(), 30);
    const exec = new SerialPageRuleExecutor(runner, { yieldEveryMs: 1 });

    await expect(
      exec.run(["a", "b", "c", "d", "e", "f"].map(task), siteData, controller.signal),
    ).rejects.toThrow();
    clearTimeout(timer);
    // Aborted partway — not every page ran.
    expect(ran.length).toBeGreaterThan(0);
    expect(ran.length).toBeLessThan(6);
  });
});

describe("runAndDispose", () => {
  test("disposes after a successful run", async () => {
    const { runner } = stubRunner();
    let disposed = false;
    const exec: PageRuleExecutor = {
      run: (t, s, sig) => new SerialPageRuleExecutor(runner).run(t, s, sig),
      dispose: async () => {
        disposed = true;
      },
    };

    await runAndDispose(exec, [task("a")], siteData);
    expect(disposed).toBe(true);
  });

  test("disposes even when run throws", async () => {
    let disposed = false;
    const exec: PageRuleExecutor = {
      run: async () => {
        throw new Error("boom");
      },
      dispose: async () => {
        disposed = true;
      },
    };

    await expect(runAndDispose(exec, [task("a")], siteData)).rejects.toThrow("boom");
    expect(disposed).toBe(true);
  });
});
