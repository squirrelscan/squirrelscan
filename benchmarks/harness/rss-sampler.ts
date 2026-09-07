/**
 * External RSS sampler + guard rail. Samples the RSS of a process TREE (the
 * /usr/bin/time wrapper plus every descendant) once a second, appends
 * "<elapsedSec> <rssKb>" lines, and kills the tree if it breaches a ceiling.
 *
 * Usage: bun rss-sampler.ts <rootPid> <outLog> <killMB> <killSec> <guardLog>
 */
const [rootPid, outLog, killMB, killSec, guardLog] = [
  Number(process.argv[2]),
  process.argv[3]!,
  Number(process.argv[4] ?? 4096),
  Number(process.argv[5] ?? 3600),
  process.argv[6]!,
];

const t0 = Date.now();
const lines: string[] = [];

function snapshot(): Map<number, { ppid: number; rss: number }> {
  const out = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,rss="]).stdout.toString();
  const m = new Map<number, { ppid: number; rss: number }>();
  for (const l of out.split("\n")) {
    const p = l.trim().split(/\s+/);
    if (p.length < 3) continue;
    const pid = Number(p[0]);
    const ppid = Number(p[1]);
    const rss = Number(p[2]);
    if (Number.isFinite(pid) && Number.isFinite(rss)) m.set(pid, { ppid, rss });
  }
  return m;
}

function treeRss(m: Map<number, { ppid: number; rss: number }>, root: number) {
  // children index
  const kids = new Map<number, number[]>();
  for (const [pid, v] of m) {
    if (!kids.has(v.ppid)) kids.set(v.ppid, []);
    kids.get(v.ppid)!.push(pid);
  }
  let total = 0;
  let n = 0;
  const stack = [root];
  while (stack.length) {
    const pid = stack.pop()!;
    const v = m.get(pid);
    if (!v) continue;
    total += v.rss;
    n++;
    for (const k of kids.get(pid) ?? []) stack.push(k);
  }
  return { total, n };
}

function killTree(m: Map<number, { ppid: number; rss: number }>, root: number) {
  const kids = new Map<number, number[]>();
  for (const [pid, v] of m) {
    if (!kids.has(v.ppid)) kids.set(v.ppid, []);
    kids.get(v.ppid)!.push(pid);
  }
  const all: number[] = [];
  const stack = [root];
  while (stack.length) {
    const pid = stack.pop()!;
    all.push(pid);
    for (const k of kids.get(pid) ?? []) stack.push(k);
  }
  // deepest first so the parent cannot respawn
  for (const pid of all.reverse()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

const flush = () => {
  try {
    require("node:fs").writeFileSync(outLog, lines.join("\n") + "\n");
  } catch {
    /* best effort */
  }
};
process.on("exit", flush);
process.on("SIGTERM", () => {
  flush();
  process.exit(0);
});

let peak = 0;
while (true) {
  const m = snapshot();
  if (!m.has(rootPid)) break; // run finished
  const { total, n } = treeRss(m, rootPid);
  const elapsed = Math.round((Date.now() - t0) / 1000);
  if (total > peak) peak = total;
  lines.push(`${elapsed} ${total} ${n}`);
  if (lines.length % 20 === 0) flush();

  const mb = total / 1024;
  if (mb > killMB) {
    require("node:fs").appendFileSync(
      guardLog,
      `KILLED rss=${mb.toFixed(0)}MB (ceiling ${killMB}MB) at ${elapsed}s\n`,
    );
    killTree(m, rootPid);
    break;
  }
  if (elapsed > killSec) {
    require("node:fs").appendFileSync(
      guardLog,
      `KILLED time=${elapsed}s (ceiling ${killSec}s) rss=${mb.toFixed(0)}MB\n`,
    );
    killTree(m, rootPid);
    break;
  }
  await Bun.sleep(1000);
}
flush();
