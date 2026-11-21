// Bench for squirrelscan/repo#1883: per-page vs grouped stream producers on a drscholls-shaped fixture.
// Each producer runs in its own process so heap numbers are not polluted:
//   bun scripts/bench-grouped-stream.ts --mode per-page
//   bun scripts/bench-grouped-stream.ts --mode grouped
import {
  buildGroupedStreamFindings,
  buildStreamFindings,
} from "../src/stream-findings";
import { buildDrschollsFixture } from "../tests/helpers/grouped-stream-fixture";

const arg = process.argv.indexOf("--mode");
const mode = arg >= 0 ? process.argv[arg + 1] : "";
if (mode !== "per-page" && mode !== "grouped") {
  console.error("usage: --mode per-page|grouped");
  process.exit(1);
}

const rules = buildDrschollsFixture();
Bun.gc(true);
const before = process.memoryUsage();
const t0 = performance.now();
const lines =
  mode === "grouped"
    ? buildGroupedStreamFindings(rules, 1)
    : buildStreamFindings(rules, 1);
const ndjson = lines.map((l) => JSON.stringify(l)).join("\n");
const ms = performance.now() - t0;
const after = process.memoryUsage();
const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
console.log(
  JSON.stringify({
    mode,
    lines: lines.length,
    ndjsonBytes: Buffer.byteLength(ndjson),
    heapDeltaMB: mb(after.heapUsed - before.heapUsed),
    rssDeltaMB: mb(after.rss - before.rss),
    ms: Math.round(ms),
    peakRssMB: mb(process.resourceUsage().maxRSS * 1024),
  })
);
