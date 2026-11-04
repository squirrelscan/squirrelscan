// Special-use IP literals (#1560): addresses no public visitor reaches and no hosted service can be handed, whatever they embed.
//
// `isPrivateOrReservedHost` (url.ts) is the narrow test the egress paths grant from: loopback, RFC1918, link-local, CGNAT, ULA and
// the IPv4-mapped forms. It does not name the address blocks that exist to carry or translate traffic (NAT64, 6to4, Teredo,
// ISATAP), the documentation ranges, site-local, multicast or the reserved blocks, so a policy caller that asked only that
// question judged `http://[64:ff9b::a00:1]/` (NAT64 for 10.0.0.1) public. This module is the wider question, answered once:
// it is syntactic (no lookup), and an address that matches is not public, whatever its embedded IPv4 is. Used by the callers that
// decide policy (cloud handoff, render charge, publish, rule gating, the default scheme). The egress guards do NOT use it: they
// keep `public-egress.ts`, which refuses by address with its own embedded-IPv4 logic.
//
// Special-use ranges and which layer covers them. Both layers refuse the ISATAP forms that embed a non-public IPv4 address
// (`0:5efe:a.b.c.d` and `200:5efe:a.b.c.d` on any prefix, #1577): this module for policy, `isNonPublicAddress` at connect time.
// ISATAP only routes on a host with an ISATAP interface, so one embedding a public IPv4 stays public in both. A test table in
// `tests/special-use-ip.test.ts` runs the same literals through both and asserts they agree.
//
// NAT64 and 6to4 with a PUBLIC embedded IPv4 (`64:ff9b::808:808`, `2002:808:808::1`) are special-use here, by prefix (#1572): the
// egress guard judges them by the embedded address, and that difference is intentional (see `isNonPublicHostnameForPolicy`).

import { isIP } from "node:net";

/** The IPv4 blocks that are not public unicast, besides the private ranges `isPrivateOrReservedHost` already holds. */
export function isSpecialUseIpv4(host: string): boolean {
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return false;
  const [a, b, c] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true; // this host, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 169 && b === 254) return true; // link-local, the metadata address
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0 && c === 0) return octets[3] !== 9 && octets[3] !== 10; // IETF protocol assignments, minus the PCP and TURN anycast addresses (192.0.0.9, 192.0.0.10: globally reachable)
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast (deprecated)
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  return a >= 224; // multicast, reserved, limited broadcast
}

/** The 16 bytes of an IPv6 literal (any valid spelling, with or without a dotted tail), or null when it is not one. */
function ipv6Bytes(host: string): number[] | null {
  if (isIP(host) !== 6) return null;
  let text = host.toLowerCase();
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  const dotted = text.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const parts = dotted[2]!.split(".").map(Number);
    if (parts.some((p) => p > 255)) return null;
    const hi = ((parts[0]! << 8) | parts[1]!).toString(16);
    const lo = ((parts[2]! << 8) | parts[3]!).toString(16);
    text = `${dotted[1]}${hi}:${lo}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" ? [] : halves[0]!.split(":");
  const tail = halves.length === 2 && halves[1] !== "" ? halves[1]!.split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  const groups = [...head, ...(halves.length === 2 ? Array.from({ length: missing }, () => "0") : []), ...tail];
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const group of groups) {
    const value = parseInt(group, 16);
    if (!/^[0-9a-f]{1,4}$/.test(group) || Number.isNaN(value)) return null;
    bytes.push(value >> 8, value & 0xff);
  }
  return bytes;
}

const v4 = (bytes: number[], at: number): string => `${bytes[at]}.${bytes[at + 1]}.${bytes[at + 2]}.${bytes[at + 3]}`;

/** The globally reachable exceptions inside `2001::/23`: PCP, TURN and DNS-SD anycast (`2001:1::1` to `2001:1::3`), AMT (`2001:3::/32`) and AS112-v6 (`2001:4:112::/48`). */
function isGloballyReachableIetf(bytes: number[], second: number): boolean {
  const allZero = (from: number, to: number) => bytes.slice(from, to).every((b) => b === 0);
  if (second === 0x0001 && allZero(4, 14) && bytes[14] === 0 && bytes[15]! >= 1 && bytes[15]! <= 3) return true;
  if (second === 0x0003) return true;
  return second === 0x0004 && bytes[4] === 0x01 && bytes[5] === 0x12;
}

/**
 * Whether an IPv6 literal is not a public unicast address: unspecified and loopback, link-local, site-local and unique-local,
 * multicast, the documentation prefixes, the discard prefix, the transition and translation prefixes (NAT64 `64:ff9b::/96` and
 * `64:ff9b:1::/48`, 6to4 `2002::/16`, Teredo and the other IETF assignments `2001::/23`), the deprecated IPv4-compatible
 * `::/96`, an IPv4-mapped or -translated address whose IPv4 is special-use, and an ISATAP interface identifier
 * (`::5efe:a.b.c.d`) that embeds one.
 */
export function isSpecialUseIpv6(host: string): boolean {
  const bytes = ipv6Bytes(host);
  if (!bytes) return false;
  const first = bytes[0]! << 8 | bytes[1]!;
  const second = bytes[2]! << 8 | bytes[3]!;
  const allZero = (from: number, to: number) => bytes.slice(from, to).every((b) => b === 0);
  if (allZero(0, 10)) {
    if (bytes[10] === 0xff && bytes[11] === 0xff) return isSpecialUseIpv4(v4(bytes, 12)); // ::ffff:a.b.c.d
    if (bytes[10] === 0 && bytes[11] === 0) return true; // ::, ::1 and the compatible ::a.b.c.d
  }
  if (allZero(0, 8) && bytes[8] === 0xff && bytes[9] === 0xff && bytes[10] === 0 && bytes[11] === 0) return isSpecialUseIpv4(v4(bytes, 12)); // ::ffff:0:a.b.c.d
  if (first === 0x64 && second === 0xff9b) return true; // NAT64: 64:ff9b::/96, and 64:ff9b:1::/48 treated alike
  if (first === 0x0100 && allZero(2, 8)) return true; // 100::/64, discard-only
  if (first === 0x0100 && allZero(2, 6) && bytes[6] === 0 && bytes[7] === 1) return true; // 100:0:0:1::/64, dummy IPv6 prefix (RFC 9780)
  if (first === 0x5f00) return true; // 5f00::/16, SRv6 SIDs
  if (first === 0x2001 && (second & 0xfe00) === 0) return !isGloballyReachableIetf(bytes, second); // 2001::/23: Teredo, benchmarking, ORCHID
  if (first === 0x2001 && second === 0x0db8) return true; // documentation
  if (first === 0x3fff && (second & 0xf000) === 0) return true; // 3fff::/20 documentation
  if (first === 0x2002) return true; // 6to4
  if ((first & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((first & 0xffc0) === 0xfec0) return true; // site-local fec0::/10
  if ((first & 0xff00) === 0xff00) return true; // multicast
  // ISATAP: an interface identifier `0:5efe:a.b.c.d` or `200:5efe:a.b.c.d` on any prefix embeds an IPv4 address.
  if ((bytes[8] === 0 || bytes[8] === 2) && bytes[9] === 0 && bytes[10] === 0x5e && bytes[11] === 0xfe) return isSpecialUseIpv4(v4(bytes, 12));
  return false;
}

/** Whether a bare IP literal (IPv6 without brackets) is special-use. A name, or an address that is public unicast, is false. */
export function isSpecialUseIpLiteral(host: string): boolean {
  const kind = isIP(host);
  if (kind === 4) return isSpecialUseIpv4(host);
  if (kind === 6) return isSpecialUseIpv6(host);
  return false;
}
