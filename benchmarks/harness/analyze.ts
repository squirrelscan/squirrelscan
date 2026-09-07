/**
 * Summarize one benchmark stage. Usage: bun analyze.ts <results/<label>> [project]
 * Reads: rss.log (external sampler), mem.jsonl (in-process probe),
 *        audit.time (/usr/bin/time -l), report.json, audit.out.
 */
import { statSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

const dir = process.argv[2];
const mb = (b: number) => (b / 1048576).toFixed(0);
const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");

// ── external RSS sampler ────────────────────────────────────────
const rss = read(`${dir}/rss.log`)
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((l) => l.trim().split(/\s+/).map(Number))
  .filter((p) => p.length >= 2 && Number.isFinite(p[0]!) && Number.isFinite(p[1]!)) as [
  number,
  number,
][];
const peakKb = rss.length ? Math.max(...rss.map((r) => r[1])) : 0;
const peakAt = rss.find((r) => r[1] === peakKb)?.[0] ?? 0;
const wall = rss.length ? rss[rss.length - 1]![0] : 0;

// ── in-process probe ────────────────────────────────────────────
const mem = read(`${dir}/mem.jsonl`)
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l) as Record<string, number | string>;
    } catch {
      return null;
    }
  })
  .filter(Boolean) as Array<Record<string, number | string>>;
const ticks = mem.filter((m) => m.tag === "tick" || m.tag === "start");
const last = mem.find((m) => m.tag === "exit");
const peakHeap = ticks.length ? Math.max(...ticks.map((m) => Number(m.heapUsed))) : 0;
const peakExt = ticks.length ? Math.max(...ticks.map((m) => Number(m.external))) : 0;

// ── /usr/bin/time -l ────────────────────────────────────────────
const t = read(`${dir}/audit.time`);
const maxrss = /(\d+)\s+maximum resident set size/.exec(t)?.[1];
const realTime = /^\s*([\d.]+)\s+real/m.exec(t)?.[1];
const userTime = /([\d.]+)\s+user/.exec(t)?.[1];
const sysTime = /([\d.]+)\s+sys/.exec(t)?.[1];

// ── report ──────────────────────────────────────────────────────
const rpPath = `${dir}/report.json`;
let pagesCrawled = 0;
let findings = 0;
let score: unknown = "?";
let reportBytes = 0;
let rpText: string | null = null;
try {
  rpText = readFileSync(rpPath, "utf8"); // read once; no exists/stat/read race
} catch {
  rpText = null;
}
if (rpText !== null) {
  reportBytes = Buffer.byteLength(rpText, "utf8");
  try {
    const r = JSON.parse(rpText) as Record<string, unknown>;
    const meta = (r.meta ?? {}) as Record<string, unknown>;
    const summary = (r.summary ?? {}) as Record<string, unknown>;
    pagesCrawled = Number(meta.totalPages ?? summary.pagesCrawled ?? 0) || 0;
    const sc = (r as any).score ?? {};
    score = `${sc.overall ?? "?"} (${sc.grade ?? "?"})  passed=${summary.passed ?? "?"} warn=${summary.warnings ?? "?"} failed=${summary.failed ?? "?"}`;
    const issues = ((r as any).issues ?? (r as any).findings ?? []) as unknown[];
    findings = Array.isArray(issues) ? issues.length : 0;
  } catch {
    /* partial/truncated report */
  }
}

// ── project db ──────────────────────────────────────────────────
const project = read(`${dir}/project.txt`).trim() || read(`${dir}/project`).trim();
const slug = project.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
const pdb = `${homedir()}/.squirrel/projects/${slug}/project.db`;
const pdbSize = existsSync(pdb) ? statSync(pdb).size : 0;
const csdb = `${homedir()}/.squirrel/content-store.db`;
const csSize = existsSync(csdb) ? statSync(csdb).size : 0;

// ── phase attribution from rss.log shape ────────────────────────
// print a coarse profile: RSS at 10% intervals of wall time
const marks: string[] = [];
if (rss.length) {
  for (let f = 0; f <= 10; f++) {
    const target = (wall * f) / 10;
    let best = rss[0]!;
    for (const r of rss) if (Math.abs(r[0] - target) < Math.abs(best[0] - target)) best = r;
    marks.push(`${best[0]}s:${mb(best[1] * 1024)}MB`);
  }
}

console.log(`
stage        ${dir.split("/").pop()}
rc           ${read(`${dir}/rc`).trim()}   ${read(`${dir}/guard.log`).trim() || ""}
wall         ${realTime ?? wall}s   (user ${userTime ?? "?"}s, sys ${sysTime ?? "?"}s)
pages        ${pagesCrawled}   ->  ${pagesCrawled && realTime ? (pagesCrawled / Number(realTime)).toFixed(2) : "?"} pages/s
peak RSS     ${maxrss ? mb(Number(maxrss)) : mb(peakKb * 1024)} MB  (sampler peak ${mb(peakKb * 1024)} MB at ${peakAt}s)
peak heapUsed${peakHeap ? " " + mb(peakHeap) + " MB" : " n/a"}   peak external ${peakExt ? mb(peakExt) + " MB" : "n/a"}
end heapUsed ${last ? mb(Number(last.heapUsed)) + " MB" : "n/a"}   end external ${last ? mb(Number(last.external)) + " MB" : "n/a"}
findings     ${findings}   score ${score}
report.json  ${mb(reportBytes)} MB
project.db   ${mb(pdbSize)} MB   (${slug})
content-store${" "}${mb(csSize)} MB (global, cumulative)
rss profile  ${marks.join("  ")}
`);
