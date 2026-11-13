// Compiles the DB-IP "IP to Country Lite" CSV (CC BY 4.0, https://db-ip.com) into the compact
// offline file the CLI bundles. Usage:
//   bun run scripts/build-geoip-db.ts <dbip-country-lite-YYYY-MM.csv.gz> <snapshot-month YYYY-MM>
// The CSV is downloaded by hand from https://db-ip.com/db/download/ip-to-country-lite; this script
// never touches the network. It records the source sha256 in geoip-db/SNAPSHOT.json.
//
// Output geoip-db/country.bin.gz (gzip of):
//   "SQGEO1" | u16 countryCount | countryCount x 2 ASCII bytes
//   | u32 v4Count | v4Count x u32 start | v4Count x u16 country index
//   | u32 v6Count | v6Count x 16-byte start | v6Count x u16 country index
// A range runs to the next start; the table is gap-free (gaps become "ZZ", unknown).
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

const [csvPath, month] = process.argv.slice(2);
if (!csvPath || !month || !/^\d{4}-\d{2}$/.test(month)) {
  console.error("usage: build-db.ts <csv.gz> <YYYY-MM>");
  process.exit(2);
}

const raw = new Uint8Array(await Bun.file(csvPath).arrayBuffer());
const sha256 = createHash("sha256").update(raw).digest("hex");
const lines = new TextDecoder().decode(gunzipSync(raw)).split("\n");

const codes: string[] = [];
const codeIndex = new Map<string, number>();
const indexOf = (code: string): number => {
  let i = codeIndex.get(code);
  if (i === undefined) {
    i = codes.length;
    codes.push(code);
    codeIndex.set(code, i);
  }
  return i;
};
const unknown = indexOf("ZZ");

function v4ToInt(ip: string): bigint {
  const p = ip.split(".").map(Number);
  return (BigInt(p[0]!) << 24n) | (BigInt(p[1]!) << 16n) | (BigInt(p[2]!) << 8n) | BigInt(p[3]!);
}
function v6ToInt(ip: string): bigint {
  const [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const fill = ip.includes("::") ? 8 - h.length - t.length : 0;
  const groups = [...h, ...Array<string>(fill).fill("0"), ...t];
  if (groups.length !== 8) throw new Error(`bad IPv6 ${ip}`);
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(Number.parseInt(g, 16)), 0n);
}

type Range = { start: bigint; end: bigint; cc: number };
const v4: Range[] = [];
const v6: Range[] = [];
for (const line of lines) {
  if (!line.trim()) continue;
  const [a, b, cc] = line.split(",");
  if (!a || !b || !cc || !/^[A-Z]{2}$/.test(cc)) throw new Error(`bad row: ${line}`);
  if (a.includes(":")) v6.push({ start: v6ToInt(a), end: v6ToInt(b), cc: indexOf(cc) });
  else v4.push({ start: v4ToInt(a), end: v4ToInt(b), cc: indexOf(cc) });
}

/** Sorted, gap-free, adjacent same-country ranges merged. */
function normalise(ranges: Range[], max: bigint): Range[] {
  ranges.sort((x, y) => (x.start < y.start ? -1 : x.start > y.start ? 1 : 0));
  const out: Range[] = [];
  let next = 0n;
  const push = (start: bigint, end: bigint, cc: number) => {
    const last = out[out.length - 1];
    if (last && last.cc === cc && last.end + 1n === start) last.end = end;
    else out.push({ start, end, cc });
  };
  for (const r of ranges) {
    if (r.start < next) throw new Error("overlapping ranges");
    if (r.start > next) push(next, r.start - 1n, unknown);
    push(r.start, r.end, r.cc);
    next = r.end + 1n;
  }
  if (next <= max) push(next, max, unknown);
  return out;
}
const v4n = normalise(v4, 0xffffffffn);
const v6n = normalise(v6, (1n << 128n) - 1n);

const size = 6 + 2 + codes.length * 2 + 4 + v4n.length * 6 + 4 + v6n.length * 18;
const buf = new Uint8Array(size);
const view = new DataView(buf.buffer);
let o = 0;
buf.set(new TextEncoder().encode("SQGEO1"), o);
o += 6;
view.setUint16(o, codes.length);
o += 2;
for (const c of codes) {
  buf.set(new TextEncoder().encode(c), o);
  o += 2;
}
view.setUint32(o, v4n.length);
o += 4;
for (const r of v4n) {
  view.setUint32(o, Number(r.start));
  o += 4;
}
for (const r of v4n) {
  view.setUint16(o, r.cc);
  o += 2;
}
view.setUint32(o, v6n.length);
o += 4;
for (const r of v6n) {
  for (let i = 0; i < 16; i++) buf[o + i] = Number((r.start >> BigInt(120 - 8 * i)) & 0xffn);
  o += 16;
}
for (const r of v6n) {
  view.setUint16(o, r.cc);
  o += 2;
}

const dir = new URL("../geoip-db/", import.meta.url);
const gz = gzipSync(buf, { level: 9 });
await Bun.write(new URL("country.bin.gz", dir), gz);
// keep the `edge` block that scripts/refresh-edge-data.ts owns
const previous = await Bun.file(new URL("SNAPSHOT.json", dir)).json().catch(() => ({}));
await Bun.write(
  new URL("SNAPSHOT.json", dir),
  `${JSON.stringify(
    {
      source: "DB-IP.com IP to Country Lite",
      sourceUrl: "https://db-ip.com/db/download/ip-to-country-lite",
      license: "CC-BY-4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      snapshot: month,
      sourceFile: `dbip-country-lite-${month}.csv.gz`,
      sourceSha256: sha256,
      v4Ranges: v4n.length,
      v6Ranges: v6n.length,
      compiledBytes: gz.length,
      ...(previous.edge ? { edge: previous.edge } : {}),
    },
    null,
    2,
  )}\n`,
);
console.log({ sha256, v4: v4n.length, v6: v6n.length, bytes: gz.length });
