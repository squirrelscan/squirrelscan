// Egress guard for requests to hosts the audited site does not own (#703).
//
// The shared fetch paths deliberately leave the HOST unrestricted (see
// safe-fetch.ts): squirrelscan audits localhost, staging and internal sites on
// purpose, so blocking private hosts there is a functional regression. A URL
// that a page names on ANOTHER host is different. A public page whose
// `<script src>` points at `http://169.254.169.254/` or `http://10.0.0.5/` must
// not make squirrel request the auditor's own network, so a status probe of a
// third-party URL goes through this guard on every hop:
//
//  - The audited site is public: only public addresses. A private, loopback,
//    link-local, CGNAT, multicast or otherwise reserved IP literal is refused
//    (IPv6 forms that embed an IPv4 address are judged by that address), and
//    so is a name that is non-public by itself (`localhost`, `*.internal`, a
//    dotless host) or that RESOLVES to any such address.
//  - The audited site is itself on a private network (`localhost:3000`, an
//    RFC1918 box): its other hosts are expected to be private too, so private
//    addresses are allowed. Link-local addresses and the cloud metadata services
//    stay refused: no page legitimately loads an asset from them.
//
// The check runs before each hop, so a public URL that redirects to a private
// one is refused before the private hop is sent.
//
// PINNED, so DNS rebinding cannot swap the address. The runtime's fetch would
// resolve a name again without sharing this lookup, so a DNS server could
// answer public here and private to the fetch. A guarded hop therefore never
// hands fetch the name: it connects to the address vetted here, with the
// original `Host` header and, over TLS, the original name as the server name,
// which the runtime also verifies the certificate against. Virtual hosting and
// certificate checks behave as for the name; only the connect address is fixed.
// One limit: behind an HTTP proxy (HTTP_PROXY), a pinned plain-http request
// goes out in absolute form with the address, and the proxy takes the Host from
// that, so such a probe can read the address's default vhost. The connection
// still goes to the vetted address; correctness, not reach, is what it costs.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { isCloudMetadataHostname, isNonPublicHostname } from "./non-public-host";
import { isPrivateOrReservedHost } from "./url";

/** Every address a hostname resolves to. */
export type ResolveHost = (hostname: string) => Promise<string[]>;

export const resolveHostAddresses: ResolveHost = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
};

/**
 * One lookup per hostname for the life of the returned resolver (one asset
 * phase): a page set that names the same CDN on fifty assets resolves it once.
 * A failed lookup is forgotten, so a transient resolver error costs only the
 * requests that saw it and a retry looks the name up again.
 */
export function memoizeResolveHost(resolve: ResolveHost): ResolveHost {
  const answers = new Map<string, Promise<string[]>>();
  return (hostname) => {
    const key = hostname.toLowerCase();
    let answer = answers.get(key);
    if (!answer) {
      answer = resolve(key);
      answers.set(key, answer);
      answer.catch(() => {
        if (answers.get(key) === answer) answers.delete(key);
      });
    }
    return answer;
  };
}

export interface EgressPolicy {
  /**
   * The audited site is itself on a private network, so private addresses are
   * allowed. Link-local and cloud metadata addresses are refused either way.
   */
  allowPrivateNetwork: boolean;
  /** DNS resolution; tests inject one. Defaults to the system resolver. */
  resolve?: ResolveHost;
  /**
   * Connect to the vetted address (default). `false` only where the transport
   * itself resolves once and connects to what it validated, as the hosted
   * container's egress proxy does: there a pinned plain-http request would
   * lose its Host, which the proxy rewrites from the request target.
   */
  pin?: boolean;
  /**
   * Hosts a request may reach, the first hop and every redirect: false refuses
   * the hop. Set for requests that must stay on the audited site (a same-site
   * manifest that redirects to another host is not followed there). Gets the
   * URL's hostname, lowercased, IPv6 without brackets.
   */
  allowHost?: (hostname: string) => boolean;
  /**
   * Targets that may resolve to private addresses even when `allowPrivateNetwork`
   * is off: the audited site's own origin (host AND port), which the crawl
   * already requests. A subdomain, another host, or another port on the site's
   * host that resolves privately is still refused, so a public page cannot point
   * squirrel at the auditor's network through a name it controls. Link-local and
   * metadata addresses are refused regardless. Gets the hop's parsed URL.
   */
  allowPrivateTarget?: (url: URL) => boolean;
  /**
   * Targets sent by name without a DNS check or pinning: the hosts the crawl
   * itself requests (repo#2764). Checks that need no lookup still apply first:
   * scheme, `allowHost`, an IP literal the policy refuses (always a
   * link-local or metadata one), and a metadata hostname. A hop that leaves
   * them is vetted like any other. Vetting the
   * site's own name would refuse a LAN site whose mDNS name also answers
   * link-local IPv6 addresses (`printer.local`), and pinning it would route
   * around `NO_PROXY`. Gets the hop's parsed URL.
   */
  trustTarget?: (url: URL) => boolean;
}

/**
 * Whether an HTTP proxy from the environment carries this process's requests
 * (the runtime's fetch honours these variables). The proxy then resolves and
 * connects, so a request cannot be pinned to an address it vetted: a pinned
 * plain-http request would reach the proxy with the address in place of the
 * name (repo#3430).
 */
export function proxiedByEnvironment(): boolean {
  return ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"].some(
    (name) => (process.env[name] ?? "").trim() !== "",
  );
}

/**
 * Whether the audited site's own hosts are vetted and pinned like any other
 * (repo#3430): asked for (`pinOwnHosts`, the CLI) and possible, which it is not
 * where something else resolves the name, a transport that pins
 * (`egressPinnedByTransport`, the hosted container) or an environment proxy.
 */
export function ownHostsPinned(options: {
  pinOwnHosts?: boolean;
  egressPinnedByTransport?: boolean;
}): boolean {
  return (
    options.pinOwnHosts === true &&
    options.egressPinnedByTransport !== true &&
    !proxiedByEnvironment()
  );
}

/** Thrown before a request the egress policy refuses. Nothing was sent. */
export class EgressRefusedError extends Error {
  override name = "EgressRefusedError";
}

/** Cloud metadata services reached by address rather than by 169.254/16. */
const METADATA_IPV4 = new Set([
  "168.63.129.16", // Azure WireServer
  "100.100.100.200", // Alibaba Cloud
  "192.0.0.192", // Oracle Cloud (legacy)
]);

function ipv4Octets(address: string): number[] | null {
  if (isIP(address) !== 4) return null;
  return address.split(".").map(Number);
}

/** The eight 16-bit groups of an IPv6 address (a dotted IPv4 tail allowed). */
function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase();
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  if (isIP(text) !== 6) return null;
  const dotted = text.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(2).map(Number) as [number, number, number, number];
    text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length > 1 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length > 1 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

/**
 * The IPv4 address an IPv6 address carries, if it is one of the embedding
 * forms: IPv4-mapped (`::ffff:a.b.c.d`) and -translated (`::ffff:0:a.b.c.d`),
 * NAT64 (`64:ff9b::/96`, `64:ff9b:1::/48`), 6to4 (`2002::/16`) and the
 * deprecated IPv4-compatible `::a.b.c.d`. A NAT64 or 6to4 gateway delivers it
 * to that IPv4 address, so it is judged as that address.
 */
function embeddedIpv4(g: number[]): number[] | null {
  const octets = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  const [g0, g1, g2, , g4, g5, g6, g7] = g as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (zero(0, 5) && g5 === 0xffff) return octets(g6, g7);
  if (zero(0, 4) && g4 === 0xffff && g5 === 0) return octets(g6, g7);
  if (g0 === 0x64 && g1 === 0xff9b && (g2 === 1 || zero(2, 6))) return octets(g6, g7);
  if (g0 === 0x2002) return octets(g1, g2);
  if (zero(0, 6) && (g6 !== 0 || g7 > 1)) return octets(g6, g7);
  return null;
}

function isAlwaysRefusedIpv4(o: number[]): boolean {
  return (o[0] === 169 && o[1] === 254) || METADATA_IPV4.has(o.join("."));
}

/** Anything a public site cannot be: private, loopback, link-local, reserved. */
function isNonPublicIpv4(o: number[]): boolean {
  const [a = 0, b = 0, c = 0] = o;
  return (
    a === 0 || // "this network"
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // TEST-NET-1
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 || // multicast, reserved and broadcast
    METADATA_IPV4.has(o.join("."))
  );
}

/**
 * Cloud-internal IPv6 endpoints, as exact addresses. All sit in unique local
 * fc00::/7, so a private-network audit would otherwise reach them: AWS's
 * metadata service (fd00:ec2::254), the EKS Pod Identity agent (fd00:ec2::23)
 * and GCP's metadata server (fd20:ce::254).
 */
const METADATA_IPV6: readonly (readonly number[])[] = [
  [0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x254],
  [0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x23],
  [0xfd20, 0x00ce, 0, 0, 0, 0, 0, 0x254],
];

function isAlwaysRefusedIpv6(g: number[]): boolean {
  const g0 = g[0] ?? 0;
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  // Local-use NAT64 64:ff9b:1::/48 may embed its IPv4 address at any of the
  // RFC 6052 offsets, so the embedded address cannot be read reliably.
  if (g0 === 0x64 && g[1] === 0xff9b && g[2] === 1) return true;
  if (METADATA_IPV6.some((m) => m.every((x, i) => g[i] === x))) return true;
  const v4 = embeddedIpv4(g);
  return v4 !== null && isAlwaysRefusedIpv4(v4);
}

function isNonPublicIpv6(g: number[]): boolean {
  const g0 = g[0] ?? 0;
  if (g.slice(0, 7).every((x) => x === 0) && (g[7] ?? 0) <= 1) return true; // :: and ::1
  if ((g0 & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g0 & 0xffc0) === 0xfec0) return true; // site-local fec0::/10
  if ((g0 & 0xff00) === 0xff00) return true; // multicast ff00::/8
  if (g0 === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g0 === 0x64 && g[1] === 0xff9b && g[2] === 1) return true; // local-use NAT64
  const v4 = embeddedIpv4(g);
  return v4 !== null && isNonPublicIpv4(v4);
}

/**
 * Link-local (169.254.0.0/16, which holds the cloud metadata address, and
 * fe80::/10), another cloud metadata address, or an IPv6 form that embeds one:
 * never an asset host, whatever the audited site is.
 */
export function isLinkLocalOrMetadataAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "");
  const v4 = ipv4Octets(bare);
  if (v4) return isAlwaysRefusedIpv4(v4);
  const v6 = ipv6Groups(bare);
  return v6 !== null && isAlwaysRefusedIpv6(v6);
}

/**
 * Any address a public site cannot have: private, loopback, link-local, CGNAT,
 * documentation, benchmarking, multicast, reserved, the metadata services, and
 * the IPv6 forms that embed one of those IPv4 addresses. Not an IP → false.
 */
export function isNonPublicAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "");
  if (isPrivateOrReservedHost(bare)) return true;
  const v4 = ipv4Octets(bare);
  if (v4) return isNonPublicIpv4(v4);
  const v6 = ipv6Groups(bare);
  return v6 !== null && isNonPublicIpv6(v6);
}

function refusesAddress(address: string, allowPrivate: boolean): boolean {
  if (isLinkLocalOrMetadataAddress(address)) return true;
  return !allowPrivate && isNonPublicAddress(address);
}

/** Rejects with an AbortError when `signal` aborts first. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) return promise;
  const aborted = () => new DOMException("The operation was aborted.", "AbortError");
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(aborted());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Where an allowed request connects: `null` for an IP literal, which is already
 * the address, or for a trusted target (`trustTarget`), sent by its name;
 * otherwise the vetted address to connect to in place of the name.
 */
export interface VettedTarget {
  /** The URL with its host replaced by the first vetted address (IPv6 bracketed). */
  url: string;
  /**
   * The same URL for every vetted address, in the order to try them (IPv4
   * first). A name that answers `::1` and `127.0.0.1` reaches a dev server that
   * listens on only one of them.
   */
  urls: string[];
  /** The original `host` (name and any non-default port), for the Host header. */
  hostHeader: string;
  /** The original name, for TLS SNI and certificate checks; https only. */
  serverName?: string;
}

/**
 * The answers to try, in order: the first IPv4 address, then the first IPv6
 * one. Two at most, so a name with dozens of answers cannot fan one request
 * out across all of them; one per family is what a `::1`-only dev server needs.
 */
function orderAddresses(addresses: string[]): string[] {
  const v4 = addresses.find((address) => isIP(address) === 4);
  // A scoped address (`fe80::1%en0`) cannot be pinned in a URL: skip to one that can.
  const v6 = addresses.find((address) => isIP(address) === 6 && !address.includes("%"));
  return [v4, v6].filter((address): address is string => address !== undefined);
}

/**
 * Errors that mean the connection was never made, so nothing was sent and the
 * next address may be tried. Anything else (a reset after the request was
 * read, a truncated answer) may have reached the server: it is final.
 */
const CONNECT_FAILURE_CODES = new Set([
  "ConnectionRefused",
  "ECONNREFUSED",
  "FailedToOpenSocket",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
]);

function isConnectFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && CONNECT_FAILURE_CODES.has(code);
}

/**
 * Throws {@link EgressRefusedError} when `policy` refuses a request to `url`:
 * a non-http(s) scheme, a refused IP literal or name, or a name that resolves
 * to no address or to any refused one. A resolver failure (no such name)
 * propagates as the network error the request itself would have hit.
 */
export async function assertEgressAllowed(
  url: string,
  policy: EgressPolicy,
  signal?: AbortSignal | null,
): Promise<void> {
  await vetEgressTarget(url, policy, signal);
}

/**
 * True when `policy` refuses a request to `url` ({@link vetEgressTarget} throws
 * {@link EgressRefusedError}); nothing is sent either way. For a hand-rolled
 * redirect loop that ends at a refused hop instead of failing the whole fetch
 * (repo#2830). Any other error (a resolver failure) propagates: a caller that
 * would otherwise follow the hop treats it as refused (fail closed).
 *
 * False holds only for a request sent through {@link egressGuardedSend} with
 * the same policy, which connects to the vetted address. A pinning policy (pin
 * unset) sets scoped link-local answers aside, which is safe only because the
 * pinned connect never uses them; a caller that checks here and then sends by
 * name must pass `pin: false`, which judges every answer.
 */
export async function egressRefuses(
  url: string,
  policy: EgressPolicy,
  signal?: AbortSignal | null,
): Promise<boolean> {
  try {
    await vetEgressTarget(url, policy, signal);
    return false;
  } catch (error) {
    if (error instanceof EgressRefusedError) return true;
    throw error;
  }
}

/**
 * True when `policy` refuses `url` on what the URL itself says, with no DNS
 * lookup: a non-http(s) scheme, a host outside `allowHost`, a refused IP
 * literal, a metadata hostname, or a non-public name the policy does not
 * allow. A caller can then skip work that would answer for the URL without a
 * request (a cache, a remote service) as surely as the request itself is
 * refused (pub#770). False is not an approval: the name is still vetted on
 * the request.
 */
export function refusedWithoutLookup(url: string, policy: EgressPolicy): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (policy.allowHost && !policy.allowHost(host)) return true;
  const allowPrivate = policy.allowPrivateNetwork || policy.allowPrivateTarget?.(parsed) === true;
  if (isIP(host) !== 0) return refusesAddress(host, allowPrivate);
  if (isCloudMetadataHostname(host)) return true;
  if (policy.trustTarget?.(parsed)) return false;
  return !allowPrivate && isNonPublicHostname(host);
}

/**
 * {@link assertEgressAllowed}, returning where the request must connect so the
 * address it was vetted on is the address it uses (see the header comment).
 */
export async function vetEgressTarget(
  url: string,
  policy: EgressPolicy,
  signal?: AbortSignal | null,
): Promise<VettedTarget | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new EgressRefusedError("unparseable URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new EgressRefusedError(`refused scheme ${parsed.protocol}`);
  }
  // URL.hostname keeps IPv6 literals bracketed and IPv4 literals canonical.
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (policy.allowHost && !policy.allowHost(host)) {
    throw new EgressRefusedError("refused: host outside the allowed set");
  }

  const allowPrivate = policy.allowPrivateNetwork || policy.allowPrivateTarget?.(parsed) === true;
  if (isIP(host) !== 0) {
    if (refusesAddress(host, allowPrivate)) throw new EgressRefusedError("refused address");
    return null;
  }
  if (isCloudMetadataHostname(host)) throw new EgressRefusedError("refused metadata host");
  // After the checks that need no lookup, so no trust reaches a metadata name.
  if (policy.trustTarget?.(parsed)) return null;
  if (!allowPrivate && isNonPublicHostname(host)) {
    throw new EgressRefusedError("refused non-public host");
  }

  const answers = await raceAbort((policy.resolve ?? resolveHostAddresses)(host), signal);
  // A scoped link-local answer (`fe80::1%en0`) cannot be pinned in a URL, so a
  // pinned request never connects to it. A LAN name (`nas.local`) answers one
  // beside its routable addresses on macOS, and refusing the whole name for it
  // refused every redirect between LAN hosts (repo#2830), so it is set aside.
  // Not when the transport connects by name: it might pick that address.
  const addresses =
    policy.pin === false ? answers : answers.filter((address) => !address.includes("%"));
  if (
    addresses.length === 0 ||
    addresses.some((address) => refusesAddress(address, allowPrivate))
  ) {
    throw new EgressRefusedError("refused: host resolves to a non-public address");
  }

  const urls: string[] = [];
  for (const address of orderAddresses(addresses)) {
    const pinned = new URL(parsed.href);
    pinned.hostname = isIP(address) === 6 ? `[${address}]` : address;
    // The hostname setter ignores a value it cannot parse (a scoped IPv6
    // address, a resolver that answered a name) and would leave the name in
    // place: an unpinned request. Such an answer is never used.
    if (isIP(pinned.hostname.replace(/^\[|\]$/g, "")) !== 0) urls.push(pinned.href);
  }
  if (urls.length === 0) {
    throw new EgressRefusedError("refused: resolved address cannot be pinned");
  }
  return {
    url: urls[0]!,
    urls,
    hostHeader: parsed.host,
    // SNI names carry no trailing root dot (RFC 6066), and the certificate is
    // checked against this name, so `example.com.` must present `example.com`.
    ...(parsed.protocol === "https:" ? { serverName: parsed.hostname.replace(/\.$/, "") } : {}),
  };
}

/** The runtime's fetch takes a TLS server name, and checks the certificate against it. */
type PinnedInit = RequestInit & { tls?: Record<string, unknown> };

/**
 * Wraps a per-hop `send` (the third argument of `safeRedirectFetch`) so every
 * hop, the first included, is vetted by {@link vetEgressTarget} and then sent
 * to the vetted address, with the original Host header and TLS server name.
 * `safeRedirectFetch` resolves each `Location` against the original URL, so
 * the next hop is vetted by its own name in turn.
 */
export function egressGuardedSend(
  send: (url: string, init: RequestInit) => Promise<Response>,
  policy: EgressPolicy,
): (url: string, init: RequestInit) => Promise<Response> {
  return async (url, init) => {
    const target = await vetEgressTarget(url, policy, init.signal);
    if (!target || policy.pin === false) return send(url, init);
    const headers = new Headers(init.headers);
    headers.set("host", target.hostHeader);
    const pinned: PinnedInit = { ...init, headers };
    if (target.serverName) {
      pinned.tls = { ...(init as PinnedInit).tls, serverName: target.serverName };
    }
    // Each vetted address in turn, as a resolver-driven connect would, but only
    // past a connection that was never made. An answer of any status is final,
    // and so is any other error (the request may have been received) and an
    // abort (the caller's deadline).
    let failure: unknown;
    for (const pinnedUrl of target.urls) {
      try {
        return await send(pinnedUrl, pinned);
      } catch (error) {
        if (init.signal?.aborted || !isConnectFailure(error)) throw error;
        failure = error;
      }
    }
    throw failure;
  };
}
