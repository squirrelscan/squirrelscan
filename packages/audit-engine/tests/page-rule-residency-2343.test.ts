// PER-PAGE HEAP RESIDENCY (squirrelscan/repo#2343).
//
// `streamPageRules` bounded the DOMs to one batch (#1021) but kept every page's
// CHECKS for the whole run, and a check's message/value/items are content cut out
// of the page it was found on. So the pass's heap scaled with pages × page BYTES,
// not with pages: measured ~161 KB/page at 45 KB pages and ~710 KB/page at 1.28 MB
// pages, which is what killed a 4,000-page crawl of a 1.8 MB/page site before it
// ever reached the report.
//
// THE INVARIANT THIS PINS: with a sink taking the checks (`retainPageResults:
// false`), what the loop retains per page must not grow when the pages do. The
// same measurement in RETAINING mode is the positive control — without it a test
// that cannot see page size at all would pass for the wrong reason, which is the
// failure mode a residency assertion is most prone to.
//
// The rule here is synthetic ON PURPOSE. Real page rules are covered by the
// golden diffs; what this needs is a rule whose finding QUOTES the page, which is
// the behaviour that makes real findings scale with page bytes — the synthetic
// site pads pages with prose, so most shipped rules would emit a constant-size
// check over a bigger page and the independent variable would vanish.
//
// Each measurement runs in its own process (helpers/residency-probe.ts): in
// CI's one-process run of the whole package, a stale conservative stack root
// can pin a finished pass and fake (or, when it is released, hide) megabytes.

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { generateSiteModel, writeCrawlToStorage } from "@squirrelscan/synthetic-site";

import type { Residency } from "./helpers/residency-probe";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

const PAGE_COUNT = 40;
const SMALL_BYTES = 32 * 1024;
const LARGE_BYTES = 384 * 1024;
const MB = 1024 * 1024;
/** Band for the bounded arm's whole-crawl delta — 7x the widest sample seen. */
const NOISE_BYTES = 1.5 * MB;

const PROBE = join(import.meta.dir, "helpers", "residency-probe.ts");

/** One measurement, in a fresh process. Throws with the child's stderr on failure. */
function probe(dbPath: string, retain: boolean): Residency {
  const proc = Bun.spawnSync([process.execPath, PROBE, dbPath, retain ? "1" : "0"], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      `residency probe exited ${proc.exitCode}: ${proc.stderr.toString().slice(-2000)}`,
    );
  }
  const r = JSON.parse(proc.stdout.toString().trim().split("\n").pop()!) as Residency;
  if (process.env.RESIDENCY_DEBUG)
    console.log(
      `db=${dbPath.slice(-12)} retain=${retain} delta=${(r.totalBytes / MB).toFixed(2)}MB pages=${r.pagesScored}`,
    );
  return r;
}

const tmpDbs: string[] = [];
afterAll(() => {
  for (const p of tmpDbs) rmSync(p, { force: true });
});

/**
 * Write the crawl to a temp FILE, then hand back only its path.
 *
 * `:memory:` plus "build the model in another function" was not enough: under
 * `bun test` the 15 MB SiteModel was still reachable when the sample window
 * opened and was collected DURING the pass, so every arm read a delta of -3 to
 * -58 MB and the positive control asserted `> a negative number`. Going through
 * a file means the measured process opens a store whose fixture was built in a
 * frame that has fully returned, and nothing JS-side can still be holding the
 * pages.
 */
async function writeFixture(pageSizeBytes: number): Promise<string> {
  const path = join(tmpdir(), `squirrel-2343-${randomUUID()}.db`);
  tmpDbs.push(path);
  const { storage } = await writeCrawlToStorage(
    generateSiteModel({
      seed: 11,
      pageCount: PAGE_COUNT,
      templateCount: 2,
      minPageSizeBytes: pageSizeBytes,
      maxPageSizeBytes: pageSizeBytes,
    }),
    path,
  );
  await run(storage.close());
  return path;
}

describe("streamPageRules — per-page residency is independent of page size (#2343)", () => {
  test(
    "bounded mode holds the same heap at 32 KB and 384 KB pages",
    async () => {
      // Each probe runs a discarded warm-up pass first: the FIRST pass in a
      // process pays module-load + JIT garbage that the next forced collection
      // reclaims, so its delta comes out NEGATIVE, which would make the positive
      // control below assert `> a negative number` and pass on anything.
      const smallDb = await writeFixture(SMALL_BYTES);
      const largeDb = await writeFixture(LARGE_BYTES);

      const smallRetained = probe(smallDb, true);
      const largeRetained = probe(largeDb, true);
      const smallBounded = probe(smallDb, false);
      const largeBounded = probe(largeDb, false);

      // Non-vacuous: the pass really scored every page and the sink really got
      // its checks, in both modes.
      for (const r of [smallRetained, largeRetained, smallBounded, largeBounded]) {
        expect(r.pagesScored).toBe(PAGE_COUNT);
        expect(r.checksSunk).toBe(PAGE_COUNT);
        expect(r.ruleIdsTallied).toBe(1);
      }
      // Bounded mode keeps no per-page map; retaining mode keeps two per page.
      expect(smallBounded.retainedPageMaps).toBe(0);
      expect(largeBounded.retainedPageMaps).toBe(0);
      expect(largeRetained.retainedPageMaps).toBe(PAGE_COUNT * 2);

      // POSITIVE CONTROL. 12x the page bytes has to show up as materially more
      // retained heap when the maps are kept, or the instrument is blind and the
      // real assertion below proves nothing. Measured: 1.01 MB at 32 KB pages vs
      // 11.04 MB at 384 KB — 25 KB/page vs 276 KB/page, the defect this fixes.
      expect(largeRetained.totalBytes).toBeGreaterThan(6 * MB);
      expect(largeRetained.totalBytes - smallRetained.totalBytes).toBeGreaterThan(4 * MB);

      // THE INVARIANT. With the checks sunk, growing the pages 12x must not grow
      // what the pass holds: measured 0.05 MB at 32 KB and 0.03 MB at 384 KB,
      // against 1.01 MB / 11.04 MB retaining. NOISE_BYTES is a band 7x wider
      // than any sample observed, and the term being guarded against is ten
      // megabytes, so the slack costs no sensitivity — re-introducing ONLY the
      // `ruleResultsMap` merge (leaving both per-page maps empty) puts
      // largeBounded back at 10.96 MB and fails here.
      expect(largeBounded.totalBytes - smallBounded.totalBytes).toBeLessThan(NOISE_BYTES);
      expect(largeBounded.totalBytes).toBeLessThan(NOISE_BYTES);

      // ...and at the SAME page size, bounded holds a small fraction of what
      // retaining does, which is the point of the whole exercise.
      expect(largeBounded.totalBytes).toBeLessThan(largeRetained.totalBytes * 0.25);
    },
    180_000,
  );
});
