// How the rules phases scale with page count (#1910).
//
// #1910 reports site rules going from 4s at 400 pages to 687s at 5,000 — about
// n^2 — with page rules at n^1.6 and per-page `parsePageRecord` cost rising from
// 5.5 to 40 ms, and asks for a re-measurement it can believe. Five things have
// to be controlled for the answer to mean anything, and four of them cost a
// wrong answer rather than a vague one:
//
//   1. THE NETWORK. Two things reach it. `security/http-to-https` probes sample
//      URLs over HTTP with staggered sleeps, and none of the cloud, intel or
//      external-link switches turns it off. On this fixture it was 508-790 ms of a 518-790 ms site
//      phase: the whole phase was one rule waiting on sockets, and every other
//      site rule's scaling was invisible underneath it. It is DISABLED by
//      default here (`--disable`), and the disabled set is printed, because a
//      site-rule number measured with it on is a number about the network. And
//      the soft-404 confirmation pass re-fetches every flagged candidate with a
//      sleep between same-host requests; it is off here too. Neither fires on
//      these fixtures, but another database could make either of them the
//      measurement. Note this also means the result is about the REMAINING
//      rules, not about production rules-phase latency.
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
// the streamed pass; #1910 measured the CLI, so both are timed. With `--profile`
// the parent also splits each arm into its page-scope and site-scope halves from
// the rule profiler, because a near-linear total cannot rule out a superlinear
// site component hiding inside it.
//
// ONLY SITE RULES ARE REPORTED PER RULE, and that is a hard limit of the
// profiler rather than a choice. It rounds every invocation to whole
// milliseconds. A site rule runs ONCE per audit and takes tens or hundreds of
// ms, so rounding costs it under half a millisecond. A page rule runs once per
// page — 198 rules across 2,500 pages is 495,000 rounded samples — and summing
// them buries every sub-millisecond invocation at zero while any rule that
// crosses the 1 ms boundary as pages get heavier jumps a whole unit. Summed page
// -scope profiler numbers made the two arms look like n^1.47 against n^1.01 when
// unrounded timings of the same invocations put both near n^1.0. Page-rule cost
// is read from the PHASE timings above, which are plain unrounded spans.
//
// Site rules also run with bounded concurrency, so their per-rule times add to
// more than the site phase they came from; page rules run serially. Read a
// per-rule number against the same rule at another page count, never against a
// phase.
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
    soft404_confirm: { ...(base as { soft404_confirm?: object }).soft404_confirm, enabled: false },
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
const TOP_RULES = Math.max(1, Number.parseInt(arg("top", "10"), 10));

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
    stderr: "pipe",
  });
  const stderr = proc.stderr?.toString() ?? "";
  if (proc.exitCode !== 0) {
    console.error(`  ${mode} on ${db}: exit ${proc.exitCode}\n${stderr.slice(-500)}`);
    return null;
  }
  if (PROFILE) recordProfile(mode, db, stderr);
  const line = proc.stdout.toString().split("\n").find((l) => l.startsWith("CHILD "));
  return line ? (JSON.parse(line.slice(6)) as Record<string, number>) : null;
}

/** arm -> db -> ruleId -> summed ms, and the page/site split, per attempt. */
const profiles = new Map<string, Map<string, { pageInvocations: number; site: number; rules: Map<string, number> }>>();

function recordProfile(mode: string, db: string, stderr: string): void {
  const byDb = profiles.get(mode) ?? new Map();
  // Lowest SITE TOTAL wins, and that is the whole selection: the per-rule rows
  // shown come from that same attempt rather than being a per-rule minimum
  // across attempts, so they are internally consistent with each other and with
  // the total above them.
  const acc = { pageInvocations: 0, site: 0, rules: new Map<string, number>() };
  for (const line of stderr.split("\n")) {
    if (!line.startsWith("[rule-profile]")) continue;
    try {
      const d = JSON.parse(line.slice(14)) as { ruleId: string; pageUrl?: string; durationMs?: number };
      const ms = d.durationMs ?? 0;
      // A site-scope rule runs once per audit and carries no pageUrl; a page
      // rule emits one line per page.
      // Page-scope lines are COUNTED, not summed: see the header. Their summed
      // durations are a rounding artifact, and reporting the count instead makes
      // it visible that both arms ran the same number of rule invocations.
      if (d.pageUrl === undefined) {
        acc.site += ms;
        acc.rules.set(d.ruleId, (acc.rules.get(d.ruleId) ?? 0) + ms);
      } else acc.pageInvocations += 1;
    } catch {
      // A truncated line at the end of a pipe is not worth failing a run over.
    }
  }
  const prev = byDb.get(db);
  if (!prev || acc.site < prev.site) byDb.set(db, acc);
  profiles.set(mode, byDb);
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
  // `undefined`, not 0: an arm whose every attempt failed would otherwise print
  // "0ms / 0.00" and read as the fastest row in the table.
  const values = COLUMNS.map(([mode, key]) => perMode.get(mode)?.[key]);
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
        .map((ms) =>
          ms === undefined
            ? `${"failed".padStart(16)} ${"-".padStart(6)}`
            : `${`${ms}ms`.padStart(16)} ${(ms / row.pages).toFixed(2).padStart(6)}`,
        )
        .join(" "),
  );
}

if (PROFILE) {
  const sizeOf = (db: string) => rows.find((r) => r.db === db)?.pages ?? 0;
  const ordered = [...DBS].sort((a, b) => sizeOf(a) - sizeOf(b));
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  for (const mode of ["streamed", "v1"] as const) {
    const byDb = profiles.get(mode);
    if (!byDb || !first || !last) continue;
    const a = byDb.get(first);
    const b = byDb.get(last);
    if (!a || !b) continue;
    const ratio = sizeOf(last) / sizeOf(first);
    const k = (x: number, y: number) =>
      x > 0 && y > 0 && ratio > 1 ? `n^${(Math.log(y / x) / Math.log(ratio)).toFixed(2)}` : "n/a";
    console.log(
      `\n=== ${mode} arm, SITE rules (one attempt, the one with the lowest total) ===\n` +
        `  page-rule invocations  ${a.pageInvocations} -> ${b.pageInvocations} ` +
        `(counted, not timed — the profiler's whole-ms rounding makes their sum meaningless)\n` +
        `  site-scope total       ${a.site.toFixed(0)}ms -> ${b.site.toFixed(0)}ms   ${k(a.site, b.site)}`,
    );
    const top = [...b.rules].sort((x, y) => y[1] - x[1]).slice(0, TOP_RULES);
    console.log(`  ${"site rule".padEnd(36)} ${"first".padStart(8)} ${"last".padStart(8)} ${"slope".padStart(8)}`);
    for (const [rule, ms] of top) {
      const before = a.rules.get(rule) ?? 0;
      console.log(`  ${rule.padEnd(36)} ${`${before.toFixed(0)}ms`.padStart(8)} ${`${ms.toFixed(0)}ms`.padStart(8)} ${k(before, ms).padStart(8)}`);
    }
  }
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
      const a = first.values[i];
      const b = last.values[i];
      const k = a !== undefined && b !== undefined && a > 0 && b > 0
        ? (Math.log(b / a) / Math.log(ratio)).toFixed(2)
        : "n/a";
      console.log(`  ${label.padEnd(16)} n^${k}`);
    });
  }
}
