// Opt-in heap snapshots at audit phase boundaries (repo#1991): off by default,
// one V8 snapshot per asked-for boundary when on, and never charged to the
// phase it observes.

import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PhaseTimer,
  phaseHeapSnapshotWriter,
  streamPhaseHook,
} from "../../src/controllers/audit";

const saved = {
  dir: process.env.SQUIRREL_HEAP_SNAPSHOT_DIR,
  phases: process.env.SQUIRREL_HEAP_SNAPSHOT_PHASES,
};
const dirs: string[] = [];

afterEach(() => {
  for (const [key, value] of [
    ["SQUIRREL_HEAP_SNAPSHOT_DIR", saved.dir],
    ["SQUIRREL_HEAP_SNAPSHOT_PHASES", saved.phases],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "heap-snap-"));
  dirs.push(dir);
  return dir;
}

describe("phaseHeapSnapshotWriter", () => {
  test("is undefined unless SQUIRREL_HEAP_SNAPSHOT_DIR is set", () => {
    delete process.env.SQUIRREL_HEAP_SNAPSHOT_DIR;
    expect(phaseHeapSnapshotWriter()).toBeUndefined();
  });

  test("writes one numbered V8 snapshot per boundary, filtered by SQUIRREL_HEAP_SNAPSHOT_PHASES", () => {
    const dir = join(tempDir(), "nested");
    process.env.SQUIRREL_HEAP_SNAPSHOT_DIR = dir;
    process.env.SQUIRREL_HEAP_SNAPSHOT_PHASES = "rules, report";
    const write = phaseHeapSnapshotWriter();
    expect(write).toBeDefined();
    write?.("crawl");
    write?.("rules");
    write?.("report");
    expect(readdirSync(dir).sort()).toEqual([
      "01-rules.heapsnapshot",
      "02-report.heapsnapshot",
    ]);
    const snap = JSON.parse(
      readFileSync(join(dir, "01-rules.heapsnapshot"), "utf8")
    );
    expect(snap.snapshot.meta.node_fields).toContain("self_size");
    expect(snap.nodes.length).toBeGreaterThan(0);
  });

  test("a failed write is reported, never thrown into the audit", () => {
    const file = join(tempDir(), "not-a-dir");
    writeFileSync(file, "x");
    process.env.SQUIRREL_HEAP_SNAPSHOT_DIR = file;
    delete process.env.SQUIRREL_HEAP_SNAPSHOT_PHASES;
    const write = phaseHeapSnapshotWriter();
    expect(() => write?.("rules")).not.toThrow();
    expect(existsSync(join(file, "01-rules.heapsnapshot"))).toBe(false);
  });
});

describe("streamPhaseHook", () => {
  test("is undefined when neither diagnostic is on, so a normal run passes no hook", () => {
    expect(streamPhaseHook(undefined, undefined)).toBeUndefined();
  });

  test("forwards every boundary to the memory logger and only sub-phase ends to the snapshot", () => {
    const memory: string[] = [];
    const snaps: string[] = [];
    const hook = streamPhaseHook(
      (phase, boundary) => memory.push(`${phase}:${boundary}`),
      (phase) => snaps.push(phase)
    );
    hook?.("page-rules", "start");
    hook?.("page-rules", "end");
    expect(memory).toEqual(["page-rules:start", "page-rules:end"]);
    expect(snaps).toEqual(["stream-page-rules"]);
  });
});

describe("PhaseTimer onMark", () => {
  test("runs after the phase is timed, and its cost is not charged to the next phase", () => {
    const seen: string[] = [];
    const timer = new PhaseTimer<"rules" | "report">((name) => {
      seen.push(name);
      Bun.sleepSync(60);
    });
    timer.enter("rules");
    timer.mark("rules");
    timer.enter("report");
    timer.mark("report");
    expect(seen).toEqual(["rules", "report"]);
    expect(timer.timingsMs.rules!).toBeLessThan(50);
    expect(timer.timingsMs.report!).toBeLessThan(50);
  });
});
