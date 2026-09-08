/**
 * Per-stage phase table: crawl span (from the server request log), rules and
 * report (from the trace log), wall + CPU (from /usr/bin/time -l).
 * Usage: bun phases.ts <results-dir>...
 */
import { existsSync, readFileSync, statSync } from "node:fs";

const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const num = (re: RegExp, s: string) => {
  const m = re.exec(s);
  return m ? Number(m[1]) : 0;
};

const rows: string[][] = [];
rows.push([
  "stage",
  "pages",
  "wall",
  "cpu",
  "crawl",
  "ms/pg",
  "reqs",
  "pageReqs",
  "rules",
  "site",
  "parse",
  "peakRSS",
  "db",
]);

for (const dir of process.argv.slice(2)) {
  const label = dir.split("/").pop()!;
  const t = read(`${dir}/audit.time`);
  const wall = num(/^\s*([\d.]+)\s+real/m, t);
  const cpu = num(/([\d.]+)\s+user/, t) + num(/([\d.]+)\s+sys/, t);
  const maxrss = num(/(\d+)\s+maximum resident set size/, t);

  const rep = `${dir}/report.json`;
  let pages = 0;
  if (existsSync(rep)) {
    try {
      pages = Number(JSON.parse(readFileSync(rep, "utf8")).meta?.totalPages ?? 0);
    } catch {
      /* truncated */
    }
  }

  // crawl span from request log
  const reqRaw = read(`${dir}/requests.log`).trim();
  const reqs = reqRaw ? reqRaw.split("\n") : [];
  const pageReqs = reqs.filter((l) => /\t\/p\//.test(l)).map((l) => Number(l.split("\t")[0]));
  const crawlSpan = pageReqs.length > 1 ? (pageReqs.at(-1)! - pageReqs[0]!) / 1000 : 0;

  // phases from the trace log
  const tr = read(`${dir}/trace.log`);
  // The streaming pipeline (#252) no longer emits these two spans, so a run on
  // it has no rules attribution in the trace at all. Report that as "n/a" —
  // printing 0s reads as "the rules phase was free", which is the opposite of
  // true (it is most of the wall time on a large crawl).
  const rulesMs = /\[runPageRules:all\] duration=([\d.]+)ms/.test(tr)
    ? num(/\[runPageRules:all\] duration=([\d.]+)ms/, tr)
    : null;
  const siteMs = /\[runSiteRules\] duration=([\d.]+)ms/.test(tr)
    ? num(/\[runSiteRules\] duration=([\d.]+)ms/, tr)
    : null;
  const parseMs = (tr.match(/\[parsePageRecord\] duration=([\d.]+)ms/g) ?? [])
    .map((s) => Number(/([\d.]+)/.exec(s)![1]))
    .reduce((a, b) => a + b, 0);

  const dbBytes = Number(read(`${dir}/projectdb.bytes`).trim() || 0);

  rows.push([
    label,
    String(pages),
    wall.toFixed(0) + "s",
    cpu.toFixed(0) + "s",
    crawlSpan.toFixed(0) + "s",
    pages ? (crawlSpan * 1000 / pages).toFixed(0) : "-",
    String(reqs.length),
    String(pageReqs.length),
    rulesMs === null ? "n/a" : (rulesMs / 1000).toFixed(0) + "s",
    siteMs === null ? "n/a" : (siteMs / 1000).toFixed(0) + "s",
    (parseMs / 1000).toFixed(1) + "s",
    (maxrss / 1048576).toFixed(0) + "MB",
    dbBytes ? (dbBytes / 1048576).toFixed(0) + "MB" : "-",
  ]);
}

const w = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
for (const r of rows) console.log(r.map((c, i) => c.padStart(w[i]!)).join("  "));
