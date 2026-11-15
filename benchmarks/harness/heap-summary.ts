/**
 * Summarise a V8-format `.heapsnapshot` (as written by the CLI under
 * `SQUIRREL_HEAP_SNAPSHOT_DIR`, repo#1991): what the live heap is made of, and
 * what holds it.
 *
 * Two tables:
 *
 *   1. Self size by class: node type + constructor name, count and bytes. This
 *      is "what is the memory", not "who keeps it".
 *   2. Plain objects by property shape, each charged its self size plus the
 *      children it alone references. The shape names the holder (a check
 *      result, a page record) where a constructor name of `Object` does not.
 *
 * Node sizes already include string and ArrayBuffer backing storage, so do not
 * add `process.memoryUsage().external` to these figures.
 *
 * Usage: bun heap-summary.ts <file.heapsnapshot> [topN]
 */

const file = process.argv[2];
if (!file) throw new Error("usage: heap-summary.ts <file.heapsnapshot> [topN]");
const TOP = Number(process.argv[3] ?? 25);

type Snapshot = {
  snapshot: {
    meta: {
      node_fields: string[];
      node_types: [string[], ...unknown[]];
      edge_fields: string[];
      edge_types: [string[], ...unknown[]];
    };
    node_count: number;
  };
  nodes: number[];
  edges: number[];
  strings: string[];
};

const snap = (await Bun.file(file).json()) as Snapshot;
const { meta } = snap.snapshot;
const NF = meta.node_fields.length;
const EF = meta.edge_fields.length;
const nType = meta.node_fields.indexOf("type");
const nName = meta.node_fields.indexOf("name");
const nSelf = meta.node_fields.indexOf("self_size");
const nEdges = meta.node_fields.indexOf("edge_count");
const eType = meta.edge_fields.indexOf("type");
const eTo = meta.edge_fields.indexOf("to_node");
const nodeTypes = meta.node_types[0];
const edgeTypes = meta.edge_types[0];
const weakEdge = edgeTypes.indexOf("weak");
const shortcutEdge = edgeTypes.indexOf("shortcut");

const { nodes, edges, strings } = snap;
const N = nodes.length / NF;

// First-edge index per node.
const firstEdge = new Uint32Array(N + 1);
for (let i = 0, e = 0; i < N; i++) {
  firstEdge[i] = e;
  e += nodes[i * NF + nEdges]! * EF;
}
firstEdge[N] = edges.length;

const selfSize = (i: number) => nodes[i * NF + nSelf]!;
const typeOf = (i: number) => nodeTypes[nodes[i * NF + nType]!] ?? "?";
const nameOf = (i: number) => strings[nodes[i * NF + nName]!] ?? "?";
const label = (i: number) => {
  const t = typeOf(i);
  const n = nameOf(i);
  return t === "string" || t === "concatenated string" || t === "sliced string"
    ? t
    : `${t}:${n.length > 60 ? `${n.slice(0, 57)}...` : n}`;
};
const mb = (b: number) => (b / (1024 * 1024)).toFixed(1);

let total = 0;
for (let i = 0; i < N; i++) total += selfSize(i);

// ── 1. self size by class ──────────────────────────────────────
const byClass = new Map<string, { count: number; bytes: number }>();
for (let i = 0; i < N; i++) {
  const k = label(i);
  const v = byClass.get(k) ?? { count: 0, bytes: 0 };
  v.count += 1;
  v.bytes += selfSize(i);
  byClass.set(k, v);
}
console.log(`# ${file}`);
console.log(`nodes ${N}, total self size ${mb(total)} MiB\n`);
console.log("## Self size by class\n");
console.log("| class | count | MiB | share |");
console.log("|---|---|---|---|");
for (const [k, v] of [...byClass].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, TOP)) {
  console.log(`| \`${k.replaceAll("|", "\\|")}\` | ${v.count} | ${mb(v.bytes)} | ${((100 * v.bytes) / total).toFixed(1)}% |`);
}

// ── 2. plain objects by property shape ─────────────────────────
// A dominator tree is the textbook "who holds it", but JSC's snapshot links
// almost every object straight to the synthetic root, so its dominators come
// out flat and name nothing. What does name the holder is the object's own
// shape: a CheckResult, a PageAudit and a crawler record have different
// property sets. Each object is charged its self size plus every child that it
// alone references (a string, a butterfly, an array held by nothing else), which
// is the memory collecting that object would free one level down.
const propertyEdge = edgeTypes.indexOf("property");
const eName = meta.edge_fields.indexOf("name_or_index");
const referrers = new Uint32Array(N);
for (let e = 0; e < edges.length; e += EF) {
  const t = edges[e + eType]!;
  if (t === weakEdge || t === shortcutEdge) continue;
  referrers[edges[e + eTo]! / NF]! += 1;
}
const objectType = nodeTypes.indexOf("object");
const byShape = new Map<string, { count: number; bytes: number }>();
for (let v = 0; v < N; v++) {
  if (nodes[v * NF + nType] !== objectType) continue;
  const props: string[] = [];
  let bytes = selfSize(v);
  for (let e = firstEdge[v]!; e < firstEdge[v + 1]!; e += EF) {
    const t = edges[e + eType]!;
    if (t === weakEdge || t === shortcutEdge) continue;
    const w = edges[e + eTo]! / NF;
    if (t === propertyEdge && props.length < 8) props.push(String(strings[edges[e + eName]!]));
    if (referrers[w] === 1 && firstEdge[w + 1]! - firstEdge[w]! <= EF * 4) bytes += selfSize(w);
  }
  const key = `${nameOf(v)} {${props.sort().join(",")}}`;
  const entry = byShape.get(key) ?? { count: 0, bytes: 0 };
  entry.count += 1;
  entry.bytes += bytes;
  byShape.set(key, entry);
}
console.log("\n## Objects by property shape (self plus solely-owned children)\n");
console.log("| shape | count | MiB | share |");
console.log("|---|---|---|---|");
for (const [k, v] of [...byShape].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, TOP)) {
  const shown = k.length > 140 ? `${k.slice(0, 137)}...` : k;
  console.log(`| \`${shown.replaceAll("|", "\\|")}\` | ${v.count} | ${mb(v.bytes)} | ${((100 * v.bytes) / total).toFixed(1)}% |`);
}
