/// <reference path="./env.d.ts" />
// Offline GeoIP country lookup over the bundled DB-IP Lite country snapshot (CC BY 4.0, DB-IP.com).
// No request is ever made at runtime: the table is a file embedded in the binary (see scripts/build-db.ts).
import { isIP } from "node:net";
import { gunzipSync } from "node:zlib";

import dbPath from "../../geoip-db/country.bin.gz" with { type: "file" };
import snapshot from "../../geoip-db/SNAPSHOT.json";
import { parseV4, parseV6 } from "./ip";

export const GEOIP_ATTRIBUTION = "IP geolocation by DB-IP.com (https://db-ip.com), CC BY 4.0";
export const GEOIP_SNAPSHOT: string = snapshot.snapshot;

interface Table {
  codes: string[];
  v4Starts: Uint32Array;
  v4Cc: Uint16Array;
  v6Starts: Uint8Array;
  v6Cc: Uint16Array;
}

let table: Promise<Table> | undefined;

async function load(): Promise<Table> {
  const buf = gunzipSync(new Uint8Array(await Bun.file(dbPath).arrayBuffer()));
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (new TextDecoder().decode(buf.subarray(0, 6)) !== "SQGEO1") throw new Error("bad geoip database");
  let o = 6;
  const n = view.getUint16(o);
  o += 2;
  const codes: string[] = [];
  for (let i = 0; i < n; i++) {
    codes.push(new TextDecoder().decode(buf.subarray(o, o + 2)));
    o += 2;
  }
  const readU32s = (count: number) => {
    const a = new Uint32Array(count);
    for (let i = 0; i < count; i++) a[i] = view.getUint32(o + i * 4);
    o += count * 4;
    return a;
  };
  const readU16s = (count: number) => {
    const a = new Uint16Array(count);
    for (let i = 0; i < count; i++) a[i] = view.getUint16(o + i * 2);
    o += count * 2;
    return a;
  };
  const v4n = view.getUint32(o);
  o += 4;
  const v4Starts = readU32s(v4n);
  const v4Cc = readU16s(v4n);
  const v6n = view.getUint32(o);
  o += 4;
  const v6Starts = buf.slice(o, o + v6n * 16);
  o += v6n * 16;
  const v6Cc = readU16s(v6n);
  return { codes, v4Starts, v4Cc, v6Starts, v6Cc };
}

function compare16(starts: Uint8Array, index: number, key: Uint8Array): number {
  for (let i = 0; i < 16; i++) {
    const d = starts[index * 16 + i]! - key[i]!;
    if (d !== 0) return d;
  }
  return 0;
}

/** Index of the last range whose start is <= key, or -1. */
function floorSearch(count: number, cmp: (index: number) => number): number {
  let lo = 0;
  let hi = count - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cmp(mid) <= 0) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * The ISO 3166-1 alpha-2 country the snapshot assigns to an IPv4 or IPv6 address, or null when the
 * address is not an IP, or the snapshot has no country for it (DB-IP's `ZZ`). Never a guess.
 */
export async function lookupCountry(ip: string): Promise<string | null> {
  const kind = isIP(ip.split("%")[0]!);
  if (kind === 0) return null;
  const t = await (table ??= load());
  let cc: number;
  if (kind === 4) {
    const key = parseV4(ip);
    if (key === null) return null;
    const i = floorSearch(t.v4Starts.length, (m) => t.v4Starts[m]! - key);
    if (i < 0) return null;
    cc = t.v4Cc[i]!;
  } else {
    const key = parseV6(ip);
    if (!key) return null;
    // ::ffff:a.b.c.d is the IPv4 address a.b.c.d
    if (key.subarray(0, 10).every((b) => b === 0) && key[10] === 0xff && key[11] === 0xff) {
      return lookupCountry(`${key[12]}.${key[13]}.${key[14]}.${key[15]}`);
    }
    const i = floorSearch(t.v6Starts.length / 16, (m) => compare16(t.v6Starts, m, key));
    if (i < 0) return null;
    cc = t.v6Cc[i]!;
  }
  const code = t.codes[cc];
  return code && code !== "ZZ" ? code : null;
}

/** English country name for an ISO code, or the code itself when the runtime has no name. */
export function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}
