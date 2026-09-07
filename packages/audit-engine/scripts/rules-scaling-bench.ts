// How the rules phases scale with page count (#1910).
//
// #1910 reports site rules going from 4s at 400 pages to 687s at 5,000 — about
// n^2 — with page rules at n^1.6 and per-page `parsePageRecord` cost rising from
// 5.5 to 40 ms, and asks for a re-measurement it can believe. Five things have
// to be controlled for the answer to mean anything, and four of them cost a
// wrong answer rather than a vague one:
//
//   1. THE NETWORK. `security/http-to-https` probes sample URLs over HTTP with
//      staggered sleeps, and none of the cloud/intel/external-link switches
//      turns it off. On this fixture it was 508-790 ms of a 518-790 ms site
//      phase: the whole phase was one rule waiting on sockets, and every other
//      site rule's scaling was invisible underneath it. It is DISABLED by
//      default here (`--disable`), and the disabled set is printed, because a
//      site-rule number measured with it on is a number about the network.
//   2. THE CONTENT STORE. #1908's full-table scan per stored page makes a crawl
//      quadratic in its own page count. The fixtures keep html in the crawl DB
//      and never touch the global store.
//   3. CONTENTION. #1910's own caveat records its 2,500 row as 589s wall against
//      360s CPU and its 5,000 row as 2,236s against 1,023s, on a 16 GB box doing
//      150 MB/s of swap at load average 13. Read the per-page columns on a quiet
//      machine; a superlinear term shows up there as a rising number.
//   4. ORDER AND WARMTH. Every measurement runs in its OWN child process, so no
//      arm inherits another's warm JIT, parser structures or SQLite cache, and
//      the sizes cannot warm each other.
//   5. WHICH PARSE. `parsePageRecord` is the full extraction. `buildSiteContext`
//      on a fixture with stored `parsedData` only re-parses the DOM and
//      deserializes the rest, which is a different and cheaper thing. Both are
//      timed, separately, and only the first answers #1910's parse observation.
//
//   bun run scripts/build-mixed-fixture.ts --db /tmp/mix400.sqlite --pages 400
//   bun run scripts/rules-scaling-bench.ts --dbs /tmp/mix400.sqlite,/tmp/mix2500.sqlite
//
// The CLI runs v1 (`runRulesOnStorage`, every page resident) and the cloud runs
// the streamed pass; #1910 measured the CLI, so both are timed, and v1 is split
// into its page-scope and site-scope halves with the rule profiler rather than
// reported as one number — a near-linear total cannot rule out a superlinear
// site component hiding inside it.
//
// --child is the inner half; the parent re-invokes this file with it.

import { getDefaultConfig, type Config } from "@squirrelscan/config";
import { SQLiteStorage } from "@squirrelscan/crawler";
import { Effect } from "effect";

import {
  buildSiteContext,
  parsePageRecord,
  runRulesOnStorage,
  runStreamingRules,
  type PreFetchedAssets,
  type StreamingRulePhase,
} from "../src/adapter";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}
const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? (process.argv[i + 1] ?? d) : d;
};

const MODE = arg("mode", "streamed");
const DB = arg("db", "");
const BATCH = Number.parseInt(arg("batch", "200"), 10);
/**
 * Rules excluded from every arm. Not a convenience: a rule that waits on the
 * network contributes a fixed, sleep-shaped cost that swamps the computational
 * term this benchmark exists to measure.
 */
const DISABLE = arg("disable", "security/http-to-https")
  .split(",")
  .map((d) => d.trim())
  .filter(Boolean);

const EMPTY_ASSETS: PreFetchedAssets = {
  resourceSizes: { css: [], images: [] },
  scripts: [],
  pdfSizes: [],
  sitemapUrlStatuses: [],
};

/**
 * Every rule on except the excluded ones. `rules.enable: ["*"]` is not optional:
 * `filterRules` defaults every rule to DISABLED, so a bench without it measures
 * an empty rule set and reports a flat, meaningless line.
 */
function benchConfig(): Config {
  const base = getDefaultConfig();
  return {
    ...base,
    cloud: { ...base.cloud, enabled: false },
    intel: { ...base.intel, enabled: false },
    external_links: { ...base.external_links, enabled: false },
    rules: { enable: ["*"], disable: DISABLE },
  } as unknown as Config;
}

// ── child ────────────────────────────────────────────────────────────────────

if (process.argv.includes("--child")) {
  const storage = new SQLiteStorage(DB);
  await run(storage.init());
  const crawls = await run(storage.listCrawls(1));
  const crawlId = (crawls as Array<{ id: string }>)[0]!.id;
  const pages = await run(storage.getPageCount(crawlId));
  const out: Record<string, number> = { pages };

  if (MODE === "streamed") {
    const started = new Map<StreamingRulePhase, number>();
    await run(
      runStreamingRules(storage, crawlId, benchConfig(), EMPTY_ASSETS, undefined, {
        batchSize: BATCH,
        onPhase: (name, boundary) => {
          if (boundary === "start") started.set(name, Date.now());
          else out[name] = Date.now() - started.get(name)!;
        },
      }),
    );
  } else if (MODE === "v1") {
    const t0 = Date.now();
    const all = await run(storage.getPages(crawlId));
    const ctx = await run(buildSiteContext(all));
    // NOT parsePageRecord: with stored parsedData this re-parses the DOM and
    // deserializes the rest. Named `hydrate` so it cannot be read as the parse
    // #1910 is talking about.
    out.hydrate = Date.now() - t0;
    const t1 = Date.now();
    await run(runRulesOnStorage(storage, crawlId, ctx, benchConfig(), EMPTY_ASSETS));
    out.v1Rules = Date.now() - t1;
  } else if (MODE === "parse") {
    // The real thing: full extraction per page, which is what #1910 reports
    // rising from 5.5 to 40 ms per page.
    const all = await run(storage.getPages(crawlId));
    const t0 = Date.now();
    let parsed = 0;
    for (const page of all) if (parsePageRecord(page)) parsed++;
    out.parse = Date.now() - t0;
    out.parsedPages = parsed;
  }

  await run(storage.close());
  console.log(`CHILD ${JSON.stringify(out)}`);
  process.exit(0);
}

// ── parent ───────────────────────────────────────────────────────────────────

const DBS = arg("dbs", "")
  .split(",")
  .map((d) => d.trim())
  .filter(Boolean);
const REPEATS = Math.max(1, Number.parseInt(arg("repeat", "3"), 10));
const PROFILE = process.argv.includes("--profile");

function child(mode: string, db: string): Record<string, number> | null {
  const proc = Bun.spawnSync({
    cmd: [
      process.execPath, "run", import.meta.path, "--child",
      "--mode", mode, "--db", db, "--batch", String(BATCH), "--disable", DISABLE.join(","),
    ],
    // The profiler is read from the environment at module load, so it has to be
    // set here rather than passed as a flag the child would have to re-plumb.
    env: PROFILE ? { ...process.env, SQUIRREL_RULE_PROFILE: "1" } : process.env,
    stdout: "pipe",
    stderr: PROFILE ? "inherit" : "pipe",
  });
  if (proc.exitCode !== 0) {
    console.error(`  ${mode} on ${db}: exit ${proc.exitCode}\n${proc.stderr?.toString().slice(-500) ?? ""}`);
    return null;
  }
  const line = proc.stdout.toString().split("\n").find((l) => l.startsWith("CHILD "));
  return line ? (JSON.parse(line.slice(6)) as Record<string, number>) : null;
}

const MODES = ["streamed", "v1", "parse"] as const;
/** db -> mode -> metric -> the best (lowest) of the repeats. */
const results = new Map<string, Map<string, Record<string, number>>>();

for (const db of DBS) {
  const perMode = new Map<string, Record<string, number>>();
  for (const mode of MODES) {
    let best: Record<string, number> | null = null;
    for (let attempt = 0; attempt < REPEATS; attempt++) {
      const got = child(mode, db);
      if (!got) continue;
      // Lowest of the repeats per metric. Noise on a timing bench adds work; it
      // does not remove it, so the minimum is the closest thing to the cost.
      if (!best) best = got;
      else for (const [k, v] of Object.entries(got)) best[k] = Math.min(best[k] ?? v, v);
    }
    if (best) perMode.set(mode, best);
  }
  results.set(db, perMode);
  console.log(`measured ${db.split("/").pop()}`);
}

const COLUMNS: Array<[string, string, string]> = [
  ["streamed", "universe", "universe"],
  ["streamed", "page-rules", "pageRules"],
  ["streamed", "site-query", "siteQuery"],
  ["streamed", "site-rules", "siteRules"],
  ["v1", "hydrate", "v1 hydrate"],
  ["v1", "v1Rules", "v1 rules"],
  ["parse", "parse", "parsePageRecord"],
];

const rows = DBS.map((db) => {
  const perMode = results.get(db)!;
  const pages = perMode.get("streamed")?.pages ?? perMode.get("v1")?.pages ?? perMode.get("parse")?.pages ?? 0;
  const values = COLUMNS.map(([mode, key]) => perMode.get(mode)?.[key] ?? 0);
  return { db, pages, values };
}).filter((r) => r.pages > 0);

console.log(`\nrules disabled: ${DISABLE.join(", ") || "(none)"}   repeats: ${REPEATS} (minimum shown)`);
console.log(
  `${"pages".padStart(6)} ` + COLUMNS.map(([, , label]) => `${label.padStart(16)} ${"/pg".padStart(6)}`).join(" "),
);
for (const row of rows) {
  console.log(
    `${String(row.pages).padStart(6)} ` +
      row.values
        .map((ms) => `${`${ms}ms`.padStart(16)} ${(ms / row.pages).toFixed(2).padStart(6)}`)
        .join(" "),
  );
}

// Slopes across the endpoints, and only when the endpoints differ. Two points
// cannot separate `A + Bn` from `A + Bn + Cn²` over a narrow range — a fixed
// cost A makes per-page fall either way — so this is labelled an OBSERVED slope
// and the per-page columns above are the thing to read.
if (rows.length >= 2) {
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  if (last.pages === first.pages) {
    console.log(`\nno slope: endpoint page counts are equal (${first.pages}).`);
  } else {
    const ratio = last.pages / first.pages;
    console.log(`\nobserved slope across ${first.pages} -> ${last.pages} pages (${ratio.toFixed(1)}x), cost ~ n^k:`);
    COLUMNS.forEach(([, , label], i) => {
      const a = first.values[i]!;
      const b = last.values[i]!;
      const k = a > 0 && b > 0 ? (Math.log(b / a) / Math.log(ratio)).toFixed(2) : "n/a";
      console.log(`  ${label.padEnd(16)} n^${k}`);
    });
  }
}
