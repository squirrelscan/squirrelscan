// Child process for phase-heap-snapshot.test.ts (repo#1991). Writing a V8 heap
// snapshot and parsing the multi-MB JSON leaves a large heap behind, which would
// skew the timing tests that share the test runner's process. It runs here
// instead, and prints the facts the test asserts as one JSON line on stdout.
//
// Usage: bun phase-heap-snapshot-child.ts <dir> <phases> <boundary>...
// <phases> is SQUIRREL_HEAP_SNAPSHOT_PHASES ("" leaves it unset).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { phaseHeapSnapshotWriter } from "../../src/controllers/audit";

const [dir, phases, ...boundaries] = process.argv.slice(2);
if (!dir) throw new Error("usage: <dir> <phases> <boundary>...");

process.env.SQUIRREL_HEAP_SNAPSHOT_DIR = dir;
if (phases) process.env.SQUIRREL_HEAP_SNAPSHOT_PHASES = phases;
else delete process.env.SQUIRREL_HEAP_SNAPSHOT_PHASES;

const write = phaseHeapSnapshotWriter();
for (const boundary of boundaries) write?.(boundary);

const files = readdirSync(dir).sort();
const first = files[0];
let nodeFields: string[] = [];
let nodeCount = 0;
if (first) {
  const snap = JSON.parse(readFileSync(join(dir, first), "utf8"));
  nodeFields = snap.snapshot.meta.node_fields;
  nodeCount = snap.nodes.length;
}
console.log(
  JSON.stringify({
    writerDefined: write !== undefined,
    files,
    first,
    nodeFields,
    nodeCount,
  })
);
