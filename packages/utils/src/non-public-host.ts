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
 * `localhost.`.
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
 * Zones that can only denote something inside a private network, matched at the
 * apex AND as a suffix. `local` is mDNS, `internal` / `intranet` / `lan` /
 * `home.arpa` are private-use zones, `localhost` is loopback by RFC 6761, `svc`
 * is a Kubernetes service name, `consul` / `nomad` are service-discovery zones.
 * Not all of them are formally reserved: `localhost` (RFC 6761), `local`
 * (RFC 6762), `home.arpa` (RFC 8375) and `internal` (ICANN, for private use)
 * are; `corp` is indefinitely deferred by ICANN; the rest are simply not
 * delegated public TLDs today, so no public site can sit under one. The list
 * is the API's `classifyHostedEgressHost` list, entry for entry: if a zone is
 * ever delegated, both change together.
 */
const INTERNAL_NAME_ZONES = [
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
  if (INTERNAL_NAME_ZONES.some((zone) => host === zone || host.endsWith(`.${zone}`))) {
    return true;
  }
  // A dotless host resolves through the machine's own search domain in practice
  // (`db`, `intranet`, `nas`). A public TLD apex CAN carry an A record, so this
  // is a deliberate trade: no audit target is a bare TLD.
  return !host.includes(".");
}

/**
 * The `host:port` of a local or private-network URL, or null when the host is
 * public.
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
  if (!isNonPublicHostname(bare)) return null;
  // `host` (not `hostname`) so the port the user typed is in the label, and as
  // they typed it: this names the thing they pointed at, it is not an id.
  return parsed.host;
}

/** True when `rawUrl` is a usable http(s) URL on a local or private-network host. */
export function isNonPublicUrl(rawUrl: string): boolean {
  return nonPublicHostLabel(rawUrl) !== null;
}
