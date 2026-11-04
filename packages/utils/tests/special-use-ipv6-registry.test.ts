// #1572: a differential of the policy classifier against the IANA IPv6 special-purpose address registry (as of RFC 9780).
// Every address inside a registry block that is not globally reachable must not be public, whichever spelling it takes. The
// registry is written out here by hand (no fetch); the generator is a seeded PRNG so a failure reproduces.

import { describe, expect, test } from "bun:test";

import { isNonPublicHostnameForPolicy } from "../src/non-public-host";
import { isSpecialUseIpv4, isSpecialUseIpv6 } from "../src/special-use-ip";

/** Prefixes of the registry whose "Globally Reachable" column is False (or that the policy treats as non-public), as [hex groups, prefix length]. */
const NOT_GLOBALLY_REACHABLE: Array<[string, string, number]> = [
  ["loopback", "::1", 128],
  ["unspecified", "::", 128],
  ["IPv4-compatible (deprecated)", "::", 96],
  ["discard-only", "100::", 64],
  ["dummy prefix (RFC 9780)", "100:0:0:1::", 64],
  ["IETF protocol assignments, Teredo, benchmarking, ORCHID", "2001::", 23],
  ["documentation", "2001:db8::", 32],
  ["documentation (3fff)", "3fff::", 20],
  ["6to4", "2002::", 16],
  ["SRv6 SIDs", "5f00::", 16],
  ["unique-local", "fc00::", 7],
  ["link-local", "fe80::", 10],
  ["site-local (deprecated)", "fec0::", 10],
  ["multicast", "ff00::", 8],
  ["NAT64 well-known", "64:ff9b::", 96],
  ["NAT64 local-use", "64:ff9b:1::", 48],
];

/** Globally reachable carve-outs inside a not-reachable block: the policy says public for these. */
const REACHABLE_EXCEPTIONS = ["2001:1::1", "2001:1::2", "2001:1::3", "2001:3::", "2001:3:ffff::1", "2001:4:112::", "2001:4:112:ffff::1"];

/** Public unicast blocks that must stay public. */
const PUBLIC_SAMPLES = ["2606:4700::1111", "2001:4860:4860::8888", "2a00:1450:4001:81b::200e", "2620:fe::fe", "2001:200::1", "2001:1234::1", "3fff:1000::1", "2400::1", "2620:4f:8000::1", "100:1::1", "5e00::1", "5f01::1", "2003::1"];

function bytesOf(prefix: string): number[] {
  const text = prefix === "::" ? "::" : prefix;
  const halves = text.split("::");
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves[1] ? halves[1].split(":") : [];
  const groups = [...head, ...Array<string>(8 - head.length - tail.length).fill("0"), ...tail].map((g) => parseInt(g, 16));
  return groups.flatMap((g) => [g >> 8, g & 0xff]);
}

function formatBytes(bytes: number[], style: number): string {
  const groups = Array.from({ length: 8 }, (_, i) => (bytes[2 * i]! << 8) | bytes[2 * i + 1]!);
  if (style === 0) return groups.map((g) => g.toString(16)).join(":");
  if (style === 1) return groups.map((g) => g.toString(16).padStart(4, "0").toUpperCase()).join(":");
  // Compressed: the longest zero run becomes `::`.
  let best = { start: -1, len: 0 };
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > best.len) best = { start: i, len: j - i };
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (best.len < 2) return hex.join(":");
  return `${hex.slice(0, best.start).join(":")}::${hex.slice(best.start + best.len).join(":")}`;
}

function makeRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state;
  };
}

/** A random address inside `prefix/length`. */
function randomIn(prefix: string, length: number, next: () => number): number[] {
  const bytes = bytesOf(prefix);
  for (let bit = length; bit < 128; bit++) {
    const byte = bit >> 3;
    const mask = 0x80 >> (bit & 7);
    if ((next() & 1) === 1) bytes[byte]! |= mask;
    else bytes[byte]! &= ~mask;
  }
  return bytes;
}

/** Whether `bytes` sits in one of the REACHABLE_EXCEPTIONS blocks: 2001:1::1 to 3, 2001:3::/32, 2001:4:112::/48. */
function isException(bytes: number[]): boolean {
  if (bytes[0] !== 0x20 || bytes[1] !== 0x01) return false;
  const second = (bytes[2]! << 8) | bytes[3]!;
  if (second === 3) return true;
  if (second === 4) return bytes[4] === 0x01 && bytes[5] === 0x12;
  return second === 1 && bytes.slice(4, 15).every((b) => b === 0) && bytes[15]! >= 1 && bytes[15]! <= 3;
}

describe("IPv6 special-purpose registry differential (#1572)", () => {
  test("200,000 random literals inside non-reachable registry blocks never come back public", () => {
    const next = makeRandom(1572);
    const total = 200_000;
    const leaks: string[] = [];
    for (let i = 0; i < total; i++) {
      const [label, prefix, length] = NOT_GLOBALLY_REACHABLE[i % NOT_GLOBALLY_REACHABLE.length]!;
      const bytes = randomIn(prefix, length, next);
      if (isException(bytes)) continue;
      const literal = formatBytes(bytes, next() % 3);
      if (!isSpecialUseIpv6(literal) || !isNonPublicHostnameForPolicy(literal)) leaks.push(`${label}: ${literal}`);
      if (leaks.length >= 10) break;
    }
    expect(leaks).toEqual([]);
  }, 60_000);

  test("the two ranges added by #1572 are covered at their edges", () => {
    for (const host of ["100:0:0:1::", "100:0:0:1:ffff:ffff:ffff:ffff", "5f00::", "5f00:ffff::1", "5f00:1::1"]) {
      expect([host, isSpecialUseIpv6(host)]).toEqual([host, true]);
    }
    for (const host of ["100:0:0:2::", "100:0:1:1::", "100:1::1", "5eff::1", "5f01::"]) {
      expect([host, isSpecialUseIpv6(host)]).toEqual([host, false]);
    }
  });

  test("the globally reachable carve-outs inside 2001::/23 are not special-use", () => {
    for (const host of REACHABLE_EXCEPTIONS) expect([host, isNonPublicHostnameForPolicy(host)]).toEqual([host, false]);
    for (const host of ["2001:1::4", "2001:1:1::1", "2001:2::1", "2001:4:111::", "2001:4::1", "2001::1", "2001:10::1", "2001:20::1"]) {
      expect([host, isNonPublicHostnameForPolicy(host)]).toEqual([host, true]);
    }
  });

  test("192.0.0.9 and 192.0.0.10 are not special-use; the rest of 192.0.0.0/24 is", () => {
    for (const host of ["192.0.0.9", "192.0.0.10"]) {
      expect([host, isSpecialUseIpv4(host)]).toEqual([host, false]);
      expect([host, isNonPublicHostnameForPolicy(host)]).toEqual([host, false]);
    }
    for (const host of ["192.0.0.0", "192.0.0.1", "192.0.0.8", "192.0.0.11", "192.0.0.192", "192.0.0.255"]) {
      expect([host, isNonPublicHostnameForPolicy(host)]).toEqual([host, true]);
    }
  });

  test("public unicast samples stay public", () => {
    for (const host of PUBLIC_SAMPLES) expect([host, isNonPublicHostnameForPolicy(host)]).toEqual([host, false]);
  });
});
