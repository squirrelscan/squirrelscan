// #1552 through the streaming engine: the page-time collector keeps a page's leaked-secrets records until the site rule runs, so a
// record must not keep the page it was found in alive (a finding's `value` can be a slice of the page's serialized markup, and a slice
// holds its whole parent). Measured in a child process (helpers/leaked-secrets-residency-probe.ts) over `runStreamingRules`, with a
// forced GC after every batch, as a RATIO of the page's size: with the copies in place the heap grows by about 6% of a page per page,
// without them by about 100% (checked by mutation). Two layers copy the strings, `detachSecret` in the rule and the structuredClone in `detachFromPage`, and either
// alone is enough: removing one still passes, removing both reads about 1.5 MB a page (100%) and fails. The bound is 25%.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { PROBE_PAGES, PROBE_PAGE_BYTES } from "./helpers/leaked-secrets-residency-probe";

const PROBE = join(import.meta.dir, "helpers", "leaked-secrets-residency-probe.ts");
/** Batches before this one carry the run's own warm-up (modules, the first pages' working set). */
const WARM = 3;

describe("the streaming collector's leaked-secrets records do not keep their pages (#1552)", () => {
  test("the heap kept grows by under a quarter of a page's size per page", () => {
    const proc = Bun.spawnSync([process.execPath, PROBE], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) throw new Error(`probe exited ${proc.exitCode}: ${proc.stderr.toString().slice(-2000)}`);
    const { heap, findings } = JSON.parse(proc.stdout.toString().trim().split("\n").pop()!) as { heap: number[]; findings: number };

    // not vacuous: the rule found the secrets, and a sample was taken after every batch
    expect(findings).toBeGreaterThan(0);
    expect(heap.length).toBeGreaterThanOrEqual(PROBE_PAGES);
    const perPage = (heap[heap.length - 1]! - heap[WARM]!) / (heap.length - 1 - WARM);
    expect(perPage / PROBE_PAGE_BYTES, `heap per page ${Math.round(perPage)} bytes of ${PROBE_PAGE_BYTES}: ${JSON.stringify(heap)}`).toBeLessThan(0.25);
  }, 120_000);
});
