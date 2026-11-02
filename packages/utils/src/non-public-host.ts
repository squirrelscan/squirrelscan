/**
 * Local and private-network hosts: the one classifier (#1841, pub#629).
 *
 * squirrelscan audits `http://localhost:3000`, RFC1918 staging boxes and
 * internal hosts on purpose: the crawl runs on the user's own machine, on their
 * own network. Two things follow from a host no public visitor can reach, and
 * both read this classifier so they can never disagree about a host:
 *
 *  - No HOSTED service can reach it either, so the CLI hands nothing to one: no
 *    cloud render, no screenshot, no scheduled cloud audit, no publish (#1841).
 *  - It is not the production delivery edge, so the rules about transport and
 *    delivery (HTTPS, HSTS, caching, compression, HTTP/2) do not apply to it and
 *    are skipped rather than failed (pub#629). A dev server is plain HTTP/1.1 on
 *    purpose and sets no production caching headers.
 *
 * THE COST OF A MISTAKE IS ASYMMETRIC, and the rules below are tuned for it. A
 * host wrongly classified as public costs a cloud call that is refused later and
 * a few delivery findings on a dev server. A host wrongly classified as PRIVATE
 * silently stops a real customer site from publishing and switches its HTTPS
 * checks off. So every name rule matches a zone that cannot be registered
 * publicly, never a word that might appear in a real domain.
 *
 * It deliberately mirrors the API's `classifyHostedEgressHost` name rules (the
 * loopback names, the cloud metadata names, the internal-only zones, and the
 * dotless-host rule) so the two sides agree on the cases a private-IP check
 * alone cannot see: `box.local`, `metadata.google.internal`, `intranet`,
 * `localhost.`. The reserved and special-use zones added for pub#805 (`test`
 * through `alt` below) reach the API's list separately.
 *
 * SYNTACTIC ONLY: no DNS lookup. A public name that happens to resolve to a
 * private address (`127.0.0.1.nip.io`, an `/etc/hosts` entry) is public here,
 * which is the safe direction for both readers above.
 *
 * INDEPENDENT OF `parseUserUrl`, also deliberately. That helper answers "is this
 * a valid audit target", and it rejects single-label and trailing-dot names, so
 * classifying through it returned "reachable" for exactly the hosts that are
 * least reachable. This only ever needs the HOST.
 *
 * MUST stay out of the shared fetch paths. See the comment block in
 * `safe-fetch.ts`: host-blocking a crawl is a functional regression, not
 * hardening. This decides what to hand to the cloud and which rules apply,
 * never whether to fetch.
 */
import { isIP } from "node:net";

import { isSpecialUseIpLiteral } from "./special-use-ip";
import { isPrivateOrReservedHost } from "./url";

/** Loopback by name. RFC 6761 for `localhost`; the rest are conventional. */
const LOOPBACK_NAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost"]);

/** Cloud instance-metadata services named directly rather than by address. */
const METADATA_HOSTNAMES = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "metadata.azure.com",
  "instance-data",
  "instance-data.ec2.internal",
  "nova-agent",
]);

/**
 * Zones that cannot name a public site, matched at the apex AND as a suffix.
 * `local` is mDNS, `internal` / `intranet` / `lan` / `home.arpa` are
 * private-use zones, `localhost` is loopback by RFC 6761, `svc` is a Kubernetes
 * service name, and `consul` / `nomad` are service-discovery zones.
 * Not all of them are formally reserved: `localhost` (RFC 6761), `local`
 * (RFC 6762), `home.arpa` (RFC 8375) and `internal` (ICANN, for private use)
 * are; `test`, `example` and `invalid` are special-use names (RFC 2606 / RFC
 * 6761), `onion` is special-use (RFC 7686), and `alt` is reserved for
 * non-DNS namespaces (RFC 9476). `corp` is indefinitely deferred by ICANN;
 * the remaining conventional local-only zones are not delegated public TLDs,
 * so no public site can sit under one. The API's `classifyHostedEgressHost`
 * list is meant to match this one entry for entry, and gains the pub#805 zones
 * separately: if a zone is ever delegated, both change together.
 */
const NON_PUBLIC_NAME_ZONES = [
  "localhost",
  "local",
  "internal",
  "intranet",
  "lan",
  "home.arpa",
  "corp",
  "private",
  "svc",
  "consul",
  "nomad",
  "test",
  "example",
  "invalid",
  "localdomain",
  "home",
  "onion",
  "alt",
];

/**
 * Lowercase and strip EVERY trailing root dot. Stripping only one would leave
 * `localhost..` classified as a public name while the IPv4 path already refuses
 * `127.0.0.1..`, an asymmetry with no reason to exist.
 *
 * A loop, not `/\.+$/`: that regex retries from every dot in a run that is not
 * at the end, so a hostname of many dots is quadratic (CodeQL js/polynomial-redos).
 */
function normalizeHostname(host: string): string {
  let end = host.length;
  while (end > 0 && host.charCodeAt(end - 1) === 0x2e) end--;
  return host.slice(0, end).toLowerCase();
}

/**
 * Is this bare host an IP literal rather than a name?
 *
 * Two shapes are exhaustive HERE because the input has already been through the
 * WHATWG URL parser: every accepted IPv4 spelling (decimal, octal, hex, short
 * form) is canonicalized to dotted-quad, and every IPv6 form keeps its colons.
 * A DNS name can contain neither shape (the port lives in `host`, not
 * `hostname`), so this needs no resolver.
 */
function isIpLiteral(host: string): boolean {
  return host.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/** A cloud instance-metadata service named directly (`metadata.google.internal`). */
export function isCloudMetadataHostname(rawHost: string): boolean {
  return METADATA_HOSTNAMES.has(normalizeHostname(rawHost));
}

/**
 * True when no public visitor (and no hosted runner) could reach this bare
 * hostname: loopback, RFC1918, link-local, CGNAT, ULA, the internal-only zones,
 * and dotless names. Takes `URL.hostname` with any IPv6 brackets removed.
 */
export function isNonPublicHostname(rawHost: string): boolean {
  const host = normalizeHostname(rawHost);
  if (host.length === 0) return true;

  // AN IP LITERAL IS DECIDED BY THE IP RULES ALONE, and returns here. Falling
  // through to the NAME rules below would hand every IPv6 address to the
  // dotless-host rule (`2606:4700::1111` contains no dot) and classify a real
  // IPv6-only customer site as private. The ranges cover loopback, RFC1918,
  // link-local incl. the metadata address, CGNAT, 0.0.0.0/8, and the IPv6
  // equivalents including the IPv4-embedding forms. The decimal, octal and hex
  // IPv4 spellings arrive here already canonicalized by the URL parser.
  if (isIpLiteral(host)) return isPrivateOrReservedHost(host);

  if (LOOPBACK_NAMES.has(host)) return true;
  if (METADATA_HOSTNAMES.has(host)) return true;
  // Both the apex (`home.arpa`) and anything under it (`router.home.arpa`).
  if (NON_PUBLIC_NAME_ZONES.some((zone) => host === zone || host.endsWith(`.${zone}`))) {
    return true;
  }
  // A dotless host resolves through the machine's own search domain in practice
  // (`db`, `intranet`, `nas`). A public TLD apex CAN carry an A record, so this
  // is a deliberate trade: no audit target is a bare TLD.
  return !host.includes(".");
}

/** The eight 16-bit groups of an IPv6 literal (dotted IPv4 tail allowed), or undefined when it is not one. */
function ipv6Groups(host: string): number[] | undefined {
  let text = host.toLowerCase();
  const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (tail) {
    const o = tail.slice(1).map(Number);
    if (o.some((n) => n > 255)) return undefined;
    text = `${text.slice(0, tail.index)}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const side = (part: string): number[] | undefined => {
    if (part === "") return [];
    const groups = part.split(":");
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return undefined;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };
  const head = side(halves[0]!);
  const rest = halves.length === 2 ? side(halves[1]!) : [];
  if (!head || !rest) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const fill = 8 - head.length - rest.length;
  if (fill < 1) return undefined;
  return [...head, ...Array<number>(fill).fill(0), ...rest];
}

const dotted = (hi: number, lo: number): string => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

/** An IPv4 literal in a range no public site is served from, beyond the private ones: documentation, benchmarking, multicast, reserved, broadcast. */
function isSpecialUseIpv4(host: string): boolean {
  const o = host.split(".").map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // not an address: refused
  const [a, b, c] = o as [number, number, number, number];
  if (a >= 224) return true; // multicast 224/4, reserved 240/4, broadcast 255.255.255.255
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24 (IETF), 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 88 && c === 99) return true; // 192.88.99.0/24 (6to4 relay, deprecated)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmarking)
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 (TEST-NET-2)
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 (TEST-NET-3)
  return false;
}

/** An IPv6 literal that is special-use or carries an IPv4 address that is not public: NAT64, 6to4, Teredo, compatible, site-local, documentation, multicast, discard. */
function isSpecialUseIpv6(g: readonly number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  // An embedded IPv4 can only add a refusal: a public one falls through to the prefix rules below (a multicast, site-local, documentation or discard prefix stays refused).
  const zeros = (from: number, to: number): boolean => g.slice(from, to).every((x) => x === 0);
  if (zeros(0, 6)) return true; // ::/96: unspecified, loopback and the deprecated IPv4-compatible form
  if (g0 === 0x64 && g1 === 0xff9b) {
    if (zeros(2, 6) && isNonPublicHostnameStrict(dotted(g6, g7))) return true; // NAT64
    if (g2 === 1) return true; // 64:ff9b:1::/48, local-use NAT64
  }
  if (g0 === 0x2002 && isNonPublicHostnameStrict(dotted(g1, g2))) return true; // 6to4
  if (g0 === 0x2001 && g1 === 0) return true; // Teredo 2001::/32
  if (g0 === 0x2001 && g1 === 0xdb8) return true; // documentation 2001:db8::/32
  if (g0 === 0x2001 && g1 === 2 && g2 === 0) return true; // benchmarking 2001:2::/48
  if (g0 === 0x2001 && (g1 & 0xfff0) === 0x10) return true; // ORCHID 2001:10::/28
  if (g0 === 0x2001 && (g1 & 0xfff0) === 0x20) return true; // ORCHIDv2 2001:20::/28
  if (g0 === 0x5f00) return true; // SRv6 segment ids 5f00::/16
  if ((g4 === 0 || g4 === 0x200) && g5 === 0x5efe && isNonPublicHostnameStrict(dotted(g6, g7))) return true; // ISATAP under any prefix
  if (g0 === 0x3fff && (g1 & 0xf000) === 0) return true; // documentation 3fff::/20
  if ((g0 & 0xffc0) === 0xfec0) return true; // site-local fec0::/10
  if (g0 >> 8 === 0xff) return true; // multicast ff00::/8
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && (g3 === 0 || g3 === 1)) return true; // discard 100::/64, dummy 100:0:0:1::/64
  if (zeros(0, 4) && g4 === 0xffff && g5 === 0 && isNonPublicHostnameStrict(dotted(g6, g7))) return true; // ::ffff:0:a.b.c.d
  if (zeros(0, 5) && g5 === 0xffff && isNonPublicHostnameStrict(dotted(g6, g7))) return true; // ::ffff:a.b.c.d
  return false;
}

/**
 * {@link isNonPublicHostname} plus the special-use address ranges a hosted or batch caller must not be pointed at: IPv4
 * documentation, benchmarking, multicast, reserved and broadcast; IPv6 NAT64, 6to4 (judged by the IPv4 they carry), Teredo,
 * IPv4-compatible, site-local, documentation, multicast and discard. A separate function, not a change to the shared one,
 * because the shared classifier also decides which delivery rules run on a page, and fixtures and docs use these ranges.
 * Fail closed: text that has the shape of an address (a colon, or four dotted numbers) and is not a well-formed one (nine
 * groups, two `::`, a zone id or brackets, an octet over 255) is refused, so a spelling no parser would accept is not let through.
 */
export function isNonPublicHostnameStrict(rawHost: string): boolean {
  if (isNonPublicHostname(rawHost)) return true;
  const host = normalizeHostname(rawHost);
  if (!isIpLiteral(host)) return false;
  if (!host.includes(":")) return isSpecialUseIpv4(host);
  const groups = ipv6Groups(host);
  return groups === undefined ? true : isSpecialUseIpv6(groups); // text that looks like an address and is not one is refused
}

/**
 * The wider question the POLICY callers ask (#1560): is this bare host one no public visitor, and no hosted service, can reach?
 * `isNonPublicHostname` plus every special-use IP literal: NAT64, 6to4, Teredo and ISATAP forms, the documentation ranges (IPv4
 * and IPv6), site-local, multicast and the reserved blocks, whatever IPv4 they embed (see `special-use-ip.ts`). Cloud handoff,
 * the render charge, publish gating, the `skipOnPrivateTarget` rule gating and the default scheme read this.
 *
 * NAT64 and 6to4 are judged by PREFIX, not by the IPv4 they embed (#1572): `64:ff9b::808:808` and `2002:808:808::1` are non-public here
 * even though the embedded IPv4 is public, because they are translation and transition space (a hosted runner may have no path
 * into it, and no public certificate is expected for such a literal), and no real site is audited by one. The egress guard
 * (`public-egress.ts`) deliberately answers differently, by the embedded address, because it decides whether a connection is
 * safe, not whether the target is public. A malformed IPv6 (a colon that is not a valid literal) is non-public: fail closed.
 *
 * NOT for a grant. `isNonPublicHostname` stays the narrow test that `allowPrivateNetwork` follows (the crawl's seed redirect
 * and the engine's probes): a host that this function calls non-public but `isNonPublicHostname` does not is refused egress
 * unless it is allowed explicitly, which is the safe direction. The egress guards keep `public-egress.ts`.
 */
export function isNonPublicHostnameForPolicy(rawHost: string): boolean {
  const host = normalizeHostname(rawHost);
  if (isNonPublicHostname(host)) return true;
  // A colon that is not a valid IPv6 literal cannot name a public site: fail closed (#1572). Unreachable through the URL-parsed callers.
  if (host.includes(":") && isIP(host) !== 6) return true;
  return isIpLiteral(host) && isSpecialUseIpLiteral(host);
}

/**
 * The `host:port` of a local or private-network URL, or null when the host is
 * public. "Local or private" is `isNonPublicHostnameForPolicy`: the narrow
 * private ranges and names, and every special-use IP literal (#1560).
 *
 * Takes the user's RAW input, including a bare `localhost:3000`. A schemeless
 * value gets `http://` purely so the URL parser will yield a host; the scheme
 * plays no part in the verdict and is never written back.
 *
 * Null for input that is not a usable http(s) URL: the normal URL validation
 * reports that far better than a reachability verdict would, and this must
 * never be the thing that rejects a typo.
 */
export function nonPublicHostLabel(rawUrl: string): string | null {
  return hostLabelWhere(rawUrl, isNonPublicHostnameForPolicy);
}

/**
 * {@link nonPublicHostLabel} with the NARROW classifier (`isNonPublicHostname`): for the callers that grant
 * `allowPrivateNetwork` from the start URL (the crawl's seed redirect), where a wider verdict would widen a grant.
 */
export function privateNetworkHostLabel(rawUrl: string): string | null {
  return hostLabelWhere(rawUrl, isNonPublicHostname);
}

function hostLabelWhere(rawUrl: string, classify: (host: string) => boolean): string | null {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) return null;
  // An explicit non-http(s) scheme is someone else's error to report.
  if (trimmed.includes("://") && !/^https?:\/\//i.test(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  // URL.hostname keeps an IPv6 literal bracketed; the checks want it bare.
  const bare = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!classify(bare)) return null;
  // `host` (not `hostname`) so the port the user typed is in the label, and as
  // they typed it: this names the thing they pointed at, it is not an id.
  return parsed.host;
}

/** True when `rawUrl` is a usable http(s) URL on a local or private-network host. */
export function isNonPublicUrl(rawUrl: string): boolean {
  return nonPublicHostLabel(rawUrl) !== null;
}

/** True when `rawUrl` is a usable http(s) URL on a host the narrow classifier calls local or private (see {@link privateNetworkHostLabel}). */
export function isPrivateNetworkUrl(rawUrl: string): boolean {
  return privateNetworkHostLabel(rawUrl) !== null;
}
